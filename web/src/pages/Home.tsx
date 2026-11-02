import { useState } from "react";
import { Link } from "react-router-dom";
import { CATEGORY_LABELS, mnt, timeLeft } from "../api";
import { ErrorText, Loading, StatusBadge, useLoad } from "../components/ui";

interface Row { id: number; title: string; category: string; budget: number; prizeAmount: number; status: string; submissionDeadline: number | null; entryCount: number }

export default function Home() {
  const [category, setCategory] = useState("");
  const [minBudget, setMinBudget] = useState("");
  const [status, setStatus] = useState("open");
  const q = new URLSearchParams({ ...(category && { category }), ...(minBudget && { minBudget }), status }).toString();
  const { data, error } = useLoad<Row[]>(`/contests?${q}`);

  return (
    <div>
      <section className="mb-8 rounded-2xl bg-ink px-6 py-10 text-white">
        <h1 className="text-3xl font-bold leading-tight md:text-4xl">
          Үнийн маргаан хэрэггүй.
          <br />
          <span className="text-brand">Төсвөө тавь — хүн бүр оролдоно — чи нэгийг нь сонго.</span>
        </h1>
        <p className="mt-3 max-w-2xl text-stone-300">
          Уламжлалт уу, шинэлэг үү, эсвэл төсөвтөө тааруулсан уу — шийдвэр таных. Бүх уралдаан баталгаат: заавал нэг ялагч тодорч, мөнгө нь аль хэдийн данс руу орсон байдаг.
        </p>
        <div className="mt-6 flex gap-3">
          <Link to="/contests/new" className="btn-accent">Уралдаан зарлах</Link>
          <a href="#list" className="btn border border-stone-600 text-white hover:bg-stone-800">Оролцох</a>
        </div>
      </section>

      <div id="list" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Ангилал</label>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Бүгд</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Доод төсөв</label>
          <input className="input w-36" type="number" min={0} step={10000} value={minBudget} onChange={(e) => setMinBudget(e.target.value)} placeholder="50000" />
        </div>
        <div>
          <label className="label">Төлөв</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Нээлттэй</option>
            <option value="closed">Хаагдсан</option>
            <option value="">Бүгд</option>
          </select>
        </div>
      </div>
      <ErrorText error={error} />
      {!data ? <Loading /> : data.length === 0 ? (
        <p className="py-10 text-center text-stone-500">Одоогоор уралдаан алга. Анхных нь болоорой!</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((c) => (
            <Link key={c.id} to={`/contests/${c.id}`} className="card transition hover:border-stone-400">
              <div className="mb-2 flex items-center justify-between">
                <span className="badge">{CATEGORY_LABELS[c.category] ?? c.category}</span>
                <StatusBadge status={c.status} />
              </div>
              <h3 className="mb-3 line-clamp-2 font-semibold">{c.title}</h3>
              <div className="flex items-end justify-between text-sm">
                <div>
                  <div className="text-xs text-stone-500">Шагнал</div>
                  <div className="text-lg font-bold">{mnt(c.prizeAmount)}</div>
                </div>
                <div className="text-right text-stone-600">
                  <div>{c.entryCount} бүтээл</div>
                  <div className="text-xs">{timeLeft(c.submissionDeadline)}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
