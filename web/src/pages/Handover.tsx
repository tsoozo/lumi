import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, dt, mnt, uploadFile } from "../api";
import { ErrorText, Loading, RequireAuth, useAction, useLoad } from "../components/ui";

export default function Handover() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

const AGREEMENT = (title: string, prize: string) =>
  `"${title}" уралдааны ялагч бүтээлийн эд хөрөнгийн эрх (ашиглах, өөрчлөх, түгээх) нь ялагчид ${prize} шилжүүлэгдсэнээр захиалагчид бүрэн шилжинэ. Ялагч уг бүтээлийг өөр этгээдэд худалдахгүй, ашиглуулахгүй. Ялагч бүтээлийг портфолиодоо харуулах эрхтэй. Ялаагүй бүтээлүүд тэдгээрийн зохиогчийн өмч хэвээр үлдэнэ.`;

function Inner() {
  const { id } = useParams();
  const { data, reload } = useLoad<any>(`/handovers/${id}`);
  const [files, setFiles] = useState<File[]>([]);
  const [agree, setAgree] = useState(false);
  const { busy, error, run } = useAction();
  if (!data) return <Loading />;
  const h = data.handover;
  const text = AGREEMENT(data.contest.title, mnt(data.contest.prizeAmount));

  const download = (key: string) =>
    run(async () => {
      const r = await fetch(`/api/files/${key}`);
      if (r.headers.get("content-type")?.includes("application/json")) {
        const { url } = await r.json();
        window.location.href = url;
      } else {
        const b = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = key.split("/").pop()!;
        a.click();
      }
    });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Хүлээлгэн өгөлт</h1>
      <p className="text-stone-600">{data.contest.title} · шагнал {mnt(data.contest.prizeAmount)}</p>
      <div className="card text-sm">
        <h2 className="mb-2 font-semibold">Зохиогчийн эрх шилжүүлэх гэрээ</h2>
        <p className="text-stone-700">{text}</p>
        <p className="mt-2 text-xs text-stone-500">
          Ялагч: {h.ipAgreementCreatorAt ? `зөвшөөрсөн ${dt(h.ipAgreementCreatorAt)}` : "хүлээгдэж байна"} · Захиалагч: {h.ipAgreementClientAt ? `зөвшөөрсөн ${dt(h.ipAgreementClientAt)}` : "хүлээгдэж байна"}
        </p>
      </div>

      {data.role === "creator" && ["waiting_files", "files_sent"].includes(h.status) && (
        <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); run(async () => {
          const keys = [];
          for (const f of files) keys.push(await uploadFile(f, f.name, "handover"));
          await api(`/handovers/${id}/files`, { body: { keys, agreeIp: agree } });
          reload();
        }); }}>
          <h2 className="font-semibold">Эх файл илгээх {h.status === "waiting_files" && <span className="text-sm font-normal text-stone-500">· {dt(h.filesDeadline)}-аас өмнө</span>}</h2>
          <input type="file" multiple accept=".zip,.pdf,.png,.jpg,.jpeg,.svg,.ai,.eps,.psd,.fig" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {!h.ipAgreementCreatorAt && (
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Гэрээг зөвшөөрч байна</label>
          )}
          <button className="btn-accent" disabled={busy || !files.length || (!agree && !h.ipAgreementCreatorAt)}>{h.status === "files_sent" ? "Дахин илгээх" : "Илгээх"}</button>
        </form>
      )}

      {data.files.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-semibold">Эх файлууд</h2>
          <ul className="space-y-1 text-sm">
            {data.files.map((k: string) => <li key={k}><button className="underline" onClick={() => download(k)}>⬇ {k.split("/").pop()}</button></li>)}
          </ul>
        </div>
      )}

      {data.role === "client" && h.status === "waiting_files" && <div className="card text-sm">Ялагч эх файлаа {dt(h.filesDeadline)}-аас өмнө илгээнэ.</div>}
      {data.role === "client" && h.status === "files_sent" && (
        <div className="card space-y-2 text-sm">
          <p>Файлуудыг шалгаад хүлээн авна уу. {dt(h.acceptDeadline)} хүртэл хариу өгөхгүй бол автоматаар хүлээн авсанд тооцно.</p>
          <button className="btn-accent" disabled={busy} onClick={() => confirm("Эх файлыг хүлээн авч, гэрээг зөвшөөрөх үү?") && run(async () => { await api(`/handovers/${id}/accept`, { method: "POST" }); reload(); })}>Хүлээн авах, гэрээ зөвшөөрөх</button>
        </div>
      )}
      {["accepted", "auto_accepted"].includes(h.status) && <div className="card text-sm">✅ Хүлээлгэн өгөлт дууслаа. Ялагчид шагналыг 3 ажлын өдөрт шилжүүлнэ.</div>}
      {h.status === "disputed" && <div className="card border-red-300 bg-red-50 text-sm">Маргаантай — админ холбогдоно.</div>}
      <ErrorText error={error} />
    </div>
  );
}
