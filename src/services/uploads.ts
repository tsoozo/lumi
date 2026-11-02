import { AwsClient } from "aws4fetch";
import { and, eq } from "drizzle-orm";
import { contests, entries, handovers, payments, payouts } from "../db/schema";
import { randomToken } from "../lib/crypto";
import { badRequest, forbidden, notFound } from "../lib/errors";
import type { Actor, Ctx } from "./context";
import { getSettings } from "./settings";

/**
 * Upload purposes. Files go browser -> R2 directly via a presigned PUT URL (Worker CPU is not spent on bytes).
 * Key prefixes encode the owner so the API can check ownership by prefix.
 */
const PURPOSES = {
  attachment: { bucket: "public", prefix: "attachments", types: ["image/png", "image/jpeg", "image/webp", "application/pdf"], ext: ["png", "jpg", "jpeg", "webp", "pdf"] },
  receipt: { bucket: "private", prefix: "receipts", types: ["image/png", "image/jpeg", "image/webp", "application/pdf"], ext: ["png", "jpg", "jpeg", "webp", "pdf"] },
  entry_original: { bucket: "private", prefix: "entries", types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/pdf"], ext: ["png", "jpg", "jpeg", "webp", "svg", "pdf"] },
  entry_watermarked: { bucket: "public", prefix: "entries", types: ["image/jpeg", "image/webp", "image/png"], ext: ["jpg", "jpeg", "webp", "png"] },
  handover: {
    bucket: "private",
    prefix: "handover",
    types: ["application/zip", "application/pdf", "image/png", "image/jpeg", "image/svg+xml", "application/postscript", "application/octet-stream", "image/vnd.adobe.photoshop"],
    ext: ["zip", "pdf", "png", "jpg", "jpeg", "svg", "ai", "eps", "psd", "fig"],
  },
} as const;
export type UploadPurpose = keyof typeof PURPOSES;

const MAGIC: [string, number[]][] = [
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["jpg", [0xff, 0xd8, 0xff]],
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]],
  ["webp", [0x52, 0x49, 0x46, 0x46]],
];

/** Content sniffing on the first bytes (called after upload, before the key is accepted). */
export function sniffMatches(ext: string, head: Uint8Array): boolean {
  const e = ext === "jpeg" ? "jpg" : ext;
  const sig = MAGIC.find(([k]) => k === e);
  if (!sig) return true; // svg/ai/psd/eps/fig: no simple magic number; svg is served as attachment only
  return sig[1].every((b, i) => head[i] === b);
}

export function bucketFor(env: Ctx["env"], purpose: UploadPurpose): R2Bucket {
  return PURPOSES[purpose].bucket === "public" ? env.PUBLIC_FILES : env.PRIVATE_FILES;
}

export async function presignUpload(ctx: Ctx, actor: Actor, input: { purpose: string; fileName: string; size: number; type: string }) {
  const p = PURPOSES[input.purpose as UploadPurpose];
  if (!p) throw badRequest("purpose", "Буруу зорилго");
  const s = await getSettings(ctx.db);
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > s.max_upload_mb * 1024 * 1024) {
    throw badRequest("size", `Файл ${s.max_upload_mb}MB-аас ихгүй байна`);
  }
  const ext = (input.fileName.split(".").pop() ?? "").toLowerCase();
  if (!(p.ext as readonly string[]).includes(ext)) throw badRequest("ext", `Зөвшөөрөгдөх төрөл: ${p.ext.join(", ")}`);
  if (!(p.types as readonly string[]).includes(input.type)) throw badRequest("type", "Файлын төрөл зөвшөөрөгдөхгүй");
  const key = `${p.prefix}/${actor.id}/${randomToken(12)}.${ext}`;
  const bucketName = p.bucket === "public" ? "lumi-public" : "lumi-private";

  if (ctx.env.R2_ACCESS_KEY_ID && ctx.env.R2_SECRET_ACCESS_KEY && ctx.env.R2_ACCOUNT_ID) {
    const aws = new AwsClient({ accessKeyId: ctx.env.R2_ACCESS_KEY_ID, secretAccessKey: ctx.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
    const url = new URL(`https://${ctx.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${key}`);
    url.searchParams.set("X-Amz-Expires", "600");
    const signed = await aws.sign(new Request(url, { method: "PUT", headers: { "Content-Type": input.type } }), { aws: { signQuery: true } });
    return { key, uploadUrl: signed.url, method: "PUT", headers: { "Content-Type": input.type } };
  }
  // Local dev fallback (no R2 S3 credentials): upload through the Worker.
  return { key, uploadUrl: `/api/uploads/direct/${input.purpose}/${encodeURIComponent(key)}`, method: "PUT", headers: { "Content-Type": input.type } };
}

/** Dev-only direct upload (used when R2 S3 keys are not configured). */
export async function directUpload(ctx: Ctx, actor: Actor, purpose: string, key: string, body: ReadableStream | ArrayBuffer, type: string) {
  const p = PURPOSES[purpose as UploadPurpose];
  if (!p || !key.startsWith(`${p.prefix}/${actor.id}/`)) throw forbidden();
  if (ctx.env.R2_ACCESS_KEY_ID) throw forbidden("Direct upload disabled");
  await bucketFor(ctx.env, purpose as UploadPurpose).put(key, body, { httpMetadata: { contentType: type } });
  return { key };
}

/** Public files (watermarked previews, attachments). Served via r2.dev / custom domain in prod. */
export function publicUrl(ctx: Ctx, key: string | null | undefined) {
  if (!key) return null;
  return ctx.env.PUBLIC_FILES_BASE_URL ? `${ctx.env.PUBLIC_FILES_BASE_URL.replace(/\/$/, "")}/${key}` : `/api/public/${key}`;
}

/** Who may download a private file? */
async function canReadPrivate(ctx: Ctx, actor: Actor, key: string): Promise<boolean> {
  if (actor.type === "admin") return true;
  const [prefix, owner] = key.split("/");
  if (Number(owner) === actor.id) return true; // own uploads (receipt, entry original, handover files)
  if (prefix === "handover") {
    // The client may download final files once they were sent.
    const rows = await ctx.db
      .select({ files: handovers.finalFilesUrl, status: handovers.status, clientId: contests.clientId })
      .from(handovers)
      .innerJoin(contests, eq(contests.id, handovers.contestId))
      .where(eq(contests.clientId, actor.id!));
    return rows.some((r) => r.status !== "waiting_files" && r.files && (JSON.parse(r.files) as string[]).includes(key));
  }
  return false; // entry originals of other creators are never exposed
}

export async function signedDownload(ctx: Ctx, actor: Actor, key: string) {
  if (!(await canReadPrivate(ctx, actor, key))) throw forbidden();
  if (ctx.env.R2_ACCESS_KEY_ID && ctx.env.R2_SECRET_ACCESS_KEY && ctx.env.R2_ACCOUNT_ID) {
    const aws = new AwsClient({ accessKeyId: ctx.env.R2_ACCESS_KEY_ID, secretAccessKey: ctx.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
    const url = new URL(`https://${ctx.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/lumi-private/${key}`);
    url.searchParams.set("X-Amz-Expires", "600"); // 10 minutes
    const signed = await aws.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    return { url: signed.url };
  }
  const obj = await ctx.env.PRIVATE_FILES.get(key);
  if (!obj) throw notFound();
  return { object: obj };
}

