export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error ?? "error", data.message ?? "Алдаа гарлаа");
  return data as T;
}

export type Purpose = "attachment" | "receipt" | "entry_original" | "entry_watermarked" | "handover";

/** Browser -> R2 directly with a presigned URL. Returns the object key. */
export async function uploadFile(file: Blob, fileName: string, purpose: Purpose): Promise<string> {
  const type = file.type || guessType(fileName);
  const p = await api<{ key: string; uploadUrl: string; method: string; headers: Record<string, string> }>("/uploads/presign", {
    body: { purpose, fileName, size: file.size, type },
  });
  const r = await fetch(p.uploadUrl, { method: p.method, headers: p.headers, body: file, credentials: p.uploadUrl.startsWith("/") ? "same-origin" : "omit" });
  if (!r.ok) throw new ApiError(r.status, "upload_failed", "Файл оруулахад алдаа гарлаа");
  return p.key;
}

function guessType(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", psd: "image/vnd.adobe.photoshop", ai: "application/postscript", eps: "application/postscript" } as Record<string, string>
  )[ext ?? ""] ?? "application/octet-stream";
}

/**
 * Watermark in the creator's browser (keeps Worker CPU free). Produces a low-res JPEG
 * (max 1200px) with a diagonal repeated "Lumi · preview" mark.
 */
export async function makeWatermarked(file: File, label: string): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Зургийг уншиж чадсангүй (PNG/JPG/WEBP/SVG байх ёстой)"));
      i.src = url;
    });
    const max = 1200;
    const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
    const w = Math.round((img.naturalWidth || max) * scale);
    const h = Math.round((img.naturalHeight || max) * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(-Math.PI / 6);
    g.font = `bold ${Math.max(14, Math.round(w / 22))}px sans-serif`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.strokeStyle = "rgba(0,0,0,0.25)";
    g.lineWidth = 1;
    const text = `Lumi · ${label} · preview`;
    const step = Math.max(80, Math.round(w / 6));
    for (let y = -h; y < h; y += step) {
      for (let x = -w; x < w; x += g.measureText(text).width + 60) {
        g.fillText(text, x, y);
        g.strokeText(text, x, y);
      }
    }
    g.restore();
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.7));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const mnt = (n: number | null | undefined) => (n ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "₮";
export const dt = (sec?: number | null) => (sec ? new Date(sec * 1000).toLocaleString("mn-MN", { dateStyle: "medium", timeStyle: "short" }) : "—");
export function timeLeft(sec?: number | null) {
  if (!sec) return "—";
  const d = sec - Date.now() / 1000;
  if (d <= 0) return "дууссан";
  const days = Math.floor(d / 86400);
  const hours = Math.floor((d % 86400) / 3600);
  return days > 0 ? `${days} өдөр ${hours} цаг` : `${hours} цаг ${Math.floor((d % 3600) / 60)} мин`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  logo: "Лого",
  brand: "Брэнд",
  web: "Вэб",
  app: "Апп",
  print: "Хэвлэл",
  packaging: "Савлагаа",
  illustration: "Зураг чимэглэл",
  social: "Сошиал",
  other: "Бусад",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "Ноорог",
  awaiting_payment: "Төлбөр хүлээж буй",
  payment_review: "Төлбөр шалгаж буй",
  pending_approval: "Админ зөвшөөрөх",
  active: "Бүтээл хүлээн авч байна",
  extended: "Сунгагдсан",
  selecting: "Ялагч сонгож байна",
  handover: "Эх файл хүлээлгэж буй",
  payout_pending: "Ялагчид шилжүүлж буй",
  completed: "Дууссан",
  refund_pending: "Буцаалт хийгдэж буй",
  refunded: "Буцаагдсан",
  cancelled: "Цуцлагдсан",
  disputed: "Маргаантай",
};
