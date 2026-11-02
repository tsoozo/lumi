import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, makeWatermarked, uploadFile } from "../api";
import { ErrorText, Loading, RequireAuth, useAction, useLoad } from "../components/ui";

export default function Submit() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { id } = useParams();
  const { data: c } = useLoad<any>(`/contests/${id}`);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [own, setOwn] = useState(false);
  const { busy, error, run } = useAction();
  const nav = useNavigate();
  if (!c) return <Loading />;

  const pick = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    if (f) {
      const wm = await makeWatermarked(f, c.title.slice(0, 20)).catch(() => null);
      if (wm) setPreview(URL.createObjectURL(wm));
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-2xl font-bold">Бүтээл оруулах</h1>
      <p className="mb-4 text-stone-600">{c.title}</p>
      <form
        className="card space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          run(async () => {
            const wm = await makeWatermarked(file, c.title.slice(0, 20));
            const originalKey = await uploadFile(file, file.name, "entry_original");
            const watermarkedKey = await uploadFile(wm, "preview.jpg", "entry_watermarked");
            await api(`/contests/${id}/entries`, { body: { title, description, originalKey, watermarkedKey, originalityConfirmed: own } });
            nav(`/contests/${id}`);
          });
        }}
      >
        <div>
          <label className="label">Зураг (PNG, JPG, WEBP, SVG)</label>
          <input type="file" accept=".png,.jpg,.jpeg,.webp,.svg" required onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          <p className="mt-1 text-xs text-stone-500">Эх файл хаалттай хадгалагдана. Захиалагчид зөвхөн watermark-тай, бага нягтралтай хувилбар харагдана. Бусад оролцогчид харахгүй.</p>
        </div>
        {preview && <img src={preview} alt="watermark preview" className="w-full rounded-lg border" />}
        <div>
          <label className="label">Нэр (заавал биш)</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label">Санаагаа тайлбарла</label>
          <textarea className="input min-h-24" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          <span>Энэ миний өөрийн бүтээл. Хулгай илэрвэл бүтээл хасагдаж, давтвал бүртгэл хаагдахыг ойлгож байна.</span>
        </label>
        <button className="btn-accent w-full" disabled={!file || !own || busy}>{busy ? "Оруулж байна…" : "Илгээх"}</button>
        <ErrorText error={error} />
      </form>
    </div>
  );
}
