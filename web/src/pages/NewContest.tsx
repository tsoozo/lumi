import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CATEGORY_LABELS, mnt, uploadFile } from "../api";
import { ErrorText, Loading, RequireAuth, useAction, useLoad } from "../components/ui";

interface Config { minBudget: number; feePercent: string; submissionDaysMin: number; submissionDaysMax: number; maxUploadMb: number }

const STEPS = ["Brief", "Хавсралт", "Төсөв, хугацаа", "Дүрэм"];

export default function NewContest() {
  return (
    <RequireAuth>
      <Form />
    </RequireAuth>
  );
}

function Form() {
  const { data: cfg } = useLoad<Config>("/config");
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ title: "", category: "logo", description: "", requirements: "", deliverableFormats: "AI, SVG, PNG", budget: 300000, submissionDays: 7 });
  const [files, setFiles] = useState<File[]>([]);
  const [agree, setAgree] = useState({ noRefund: false, rules: false });
  const { busy, error, run, setError } = useAction();
  const nav = useNavigate();
  if (!cfg) return <Loading />;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: ["budget", "submissionDays"].includes(k) ? Number(e.target.value) : e.target.value });
  const pct = Number(cfg.feePercent);
  const fee = Math.round((f.budget * pct) / 100);

  const next = () => {
    setError(null);
    if (step === 0 && f.title.trim().length < 3) return setError("Гарчгаа бичнэ үү");
    if (step === 2 && f.budget < cfg.minBudget) return setError(`Хамгийн бага төсөв ${mnt(cfg.minBudget)}`);
    setStep(step + 1);
  };

  const submit = () =>
    run(async () => {
      const attachments = [];
      for (const file of files) attachments.push({ key: await uploadFile(file, file.name, "attachment"), name: file.name });
      const c = await api("/contests", { body: { ...f, attachments, acceptNoRefund: agree.noRefund } });
      await api(`/contests/${c.id}/submit-for-payment`, { method: "POST" });
      nav(`/contests/${c.id}/pay`);
    });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-2xl font-bold">Уралдаан зарлах</h1>
      <ol className="mb-6 flex gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={`flex-1 rounded-lg px-3 py-2 text-center ${i === step ? "bg-ink text-white" : i < step ? "bg-stone-200" : "bg-white text-stone-400"}`}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <div className="card space-y-4">
        {step === 0 && (
          <>
            <div>
              <label className="label">Гарчиг</label>
              <input className="input" value={f.title} onChange={set("title")} placeholder="Кофе шопын лого" maxLength={120} />
            </div>
            <div>
              <label className="label">Ангилал</label>
              <select className="input" value={f.category} onChange={set("category")}>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Тайлбар — бизнес, зорилтот хэрэглэгч, таалагддаг хэв маяг</label>
              <textarea className="input min-h-32" value={f.description} onChange={set("description")} />
            </div>
            <div>
              <label className="label">Шаардлага (өнгө, текст, заавал байх зүйлс)</label>
              <textarea className="input min-h-20" value={f.requirements} onChange={set("requirements")} />
            </div>
            <div>
              <label className="label">Эх файлын формат</label>
              <input className="input" value={f.deliverableFormats} onChange={set("deliverableFormats")} />
            </div>
          </>
        )}
        {step === 1 && (
          <div>
            <label className="label">Жишээ зураг, одоогийн лого, брэндбүүк (заавал биш, {cfg.maxUploadMb}MB хүртэл)</label>
            <input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <ul className="mt-2 text-sm text-stone-600">{files.map((x) => <li key={x.name}>📎 {x.name}</li>)}</ul>
            <p className="mt-3 text-xs text-stone-500">Хавсралт олон нийтэд харагдана — нууц мэдээлэл бүү оруулаарай.</p>
          </div>
        )}
        {step === 2 && (
          <>
            <div>
              <label className="label">Төсөв (₮) — үнийг та өөрөө шийднэ</label>
              <input className="input" type="number" min={cfg.minBudget} step={10000} value={f.budget} onChange={set("budget")} />
              <p className="mt-2 text-sm text-stone-600">
                Ялагч авна: <b>{mnt(f.budget - fee)}</b> · Платформын шимтгэл {cfg.feePercent}%: {mnt(fee)}
              </p>
            </div>
            <div>
              <label className="label">Бүтээл хүлээн авах хугацаа: {f.submissionDays} хоног</label>
              <input type="range" className="w-full" min={cfg.submissionDaysMin} max={cfg.submissionDaysMax} value={f.submissionDays} onChange={set("submissionDays")} />
            </div>
          </>
        )}
        {step === 3 && (
          <div className="space-y-3 text-sm">
            <ul className="list-disc space-y-1 pl-5 text-stone-700">
              <li>Төсвөө бүтнээр нь урьдчилан шилжүүлнэ. Төлбөр батлагдсаны дараа уралдаан нийтлэгдэнэ.</li>
              <li>Та бүх бүтээлийг харж болно, гэхдээ <b>зөвхөн ялагчийн бүтээлийг</b> ашиглах эрхтэй. Ялаагүй бүтээл оролцогчийн өмч хэвээр.</li>
              <li>Ялагч сонгох хугацаандаа сонгохгүй бол шагналыг оролцогчдод тэнцүү хуваана, та аль ч бүтээлийг ашиглах эрхгүй болно.</li>
              <li>3-аас цөөн бүтээл ирвэл: 7 хоног сунгах, 100% буцаалт авах эсвэл ирснээс ялагч сонгох эрхтэй.</li>
            </ul>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={agree.noRefund} onChange={(e) => setAgree({ ...agree, noRefund: e.target.checked })} />
              <span>"Аль нь ч таалагдсангүй" гэсэн шалтгаанаар буцаалт хийгдэхгүйг ойлгож зөвшөөрч байна.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={agree.rules} onChange={(e) => setAgree({ ...agree, rules: e.target.checked })} />
              <span>Уралдааны дүрмийг зөвшөөрч байна.</span>
            </label>
          </div>
        )}
        <ErrorText error={error} />
        <div className="flex justify-between pt-2">
          <button className="btn-ghost" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Буцах</button>
          {step < 3 ? (
            <button className="btn-primary" onClick={next}>Үргэлжлүүлэх</button>
          ) : (
            <button className="btn-accent" disabled={!agree.noRefund || !agree.rules || busy} onClick={submit}>
              {busy ? "Илгээж байна…" : "Төлбөр рүү →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
