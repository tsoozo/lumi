import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, dt, mnt, timeLeft } from "../api";
import { ErrorText, Loading, RequireAuth, Stars, StatusBadge, useAction, useLoad } from "../components/ui";

export default function MyContest() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { id } = useParams();
  const { data: c, reload } = useLoad<any>(`/contests/${id}`);
  const { data: entries, reload: reloadEntries } = useLoad<any[]>(`/contests/${id}/entries`);
  const [open, setOpen] = useState<any | null>(null);
  const { busy, error, run } = useAction();
  if (!c || !entries) return <Loading />;
  if (!c.isClient) return <p>Энэ хуудас зөвхөн захиалагчид.</p>;
  const finalists = entries.filter((e) => e.isFinalist).map((e) => e.id);
  const canPick = c.status === "selecting";
  const canFinalist = ["active", "extended", "selecting"].includes(c.status);

  const toggleFinalist = (eid: number) =>
    run(async () => {
      const next = finalists.includes(eid) ? finalists.filter((x) => x !== eid) : [...finalists, eid];
      await api(`/contests/${id}/finalists`, { body: { entryIds: next } });
      reloadEntries();
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{c.title}</h1>
        <StatusBadge status={c.status} />
        <span className="text-sm text-stone-500">{c.paymentRefCode}</span>
      </div>

      {["active", "extended"].includes(c.status) && (
        <div className="card text-sm">Бүтээл хүлээн авч байна · үлдсэн {timeLeft(c.submissionDeadline)} · {entries.length} бүтээл ирсэн. Од өгч, сэтгэгдэл бичиж оролцогчдыг чиглүүлээрэй.</div>
      )}
      {c.status === "selecting" && !c.lowEntries && (
        <div className="card border-amber-300 bg-amber-50 text-sm">
          <b>Ялагчаа сонгоно уу</b> — {dt(c.selectionDeadline)}-аас өмнө. Сонгоогүй бол шагналыг {finalists.length ? "эцсийн шатны" : "бүх"} оролцогчдод тэнцүү хуваана, та аль ч бүтээлийг ашиглах эрхгүй болно.
        </div>
      )}
      {c.lowEntries && (
        <div className="card space-y-3 border-amber-300 bg-amber-50 text-sm">
          <p><b>{entries.length} бүтээл ирсэн</b> ({c.minEntries}-аас цөөн). Та сонгох эрхтэй:</p>
          <div className="flex flex-wrap gap-2">
            {c.canExtend && <button className="btn-primary" disabled={busy} onClick={() => run(async () => { await api(`/contests/${id}/extend`, { method: "POST" }); reload(); })}>7 хоног сунгах</button>}
            <button className="btn-danger" disabled={busy} onClick={() => confirm("100% буцаалт авах уу? Уралдаан хаагдана.") && run(async () => { await api(`/contests/${id}/refund-low-entries`, { method: "POST" }); reload(); })}>100% буцаалт авах</button>
            {entries.length > 0 && <span className="self-center text-stone-600">эсвэл доороос ялагч сонгоно уу</span>}
          </div>
        </div>
      )}
      {c.handover && (
        <div className="card text-sm">
          Хүлээлгэн өгөлт: <Link className="underline" to={`/handover/${c.handover.id}`}>эх файл, гэрээ →</Link>
        </div>
      )}
      <ErrorText error={error} />

      {entries.length === 0 ? (
        <p className="py-10 text-center text-stone-500">Одоогоор бүтээл ирээгүй байна.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {entries.map((e) => (
            <div key={e.id} className={`card p-0 ${e.isWinner ? "ring-2 ring-brand" : e.isFinalist ? "ring-2 ring-stone-800" : ""}`}>
              <button className="block w-full" onClick={() => setOpen(e)}>
                <img src={e.watermarkedUrl} alt={e.title} className="aspect-square w-full rounded-t-xl object-cover" />
              </button>
              <div className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="truncate text-sm font-medium">#{e.id} {e.creatorName}</span>
                  {e.isWinner && <span>🏆</span>}
                </div>
                <Stars value={e.rating} onChange={canFinalist ? (n) => run(async () => { await api(`/entries/${e.id}/rating`, { body: { stars: n } }); reloadEntries(); }) : undefined} />
                <div className="flex gap-1">
                  {canFinalist && (
                    <button className="btn-ghost flex-1 px-2 py-1 text-xs" disabled={busy || (!e.isFinalist && finalists.length >= 3)} onClick={() => toggleFinalist(e.id)}>
                      {e.isFinalist ? "✓ Эцсийн шат" : "Эцсийн шат"}
                    </button>
                  )}
                  {canPick && (
                    <button className="btn-accent flex-1 px-2 py-1 text-xs" disabled={busy} onClick={() => confirm(`#${e.id} бүтээлийг ялагчаар сонгох уу? Буцаах боломжгүй.`) && run(async () => { await api(`/contests/${id}/winner`, { body: { entryId: e.id } }); reload(); reloadEntries(); })}>
                      Ялагч
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <EntryModal entry={open} onClose={() => setOpen(null)} />}
      <p className="text-xs text-stone-500">Шагнал: {mnt(c.prizeAmount)} · Та зөвхөн ялагчийн бүтээлийг ашиглах эрхтэй.</p>
    </div>
  );
}

function EntryModal({ entry, onClose }: { entry: any; onClose: () => void }) {
  const { data: comments, reload } = useLoad<any[]>(`/entries/${entry.id}/comments`);
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="grid max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-white md:grid-cols-2" onClick={(e) => e.stopPropagation()}>
        <img src={entry.watermarkedUrl} alt="" className="w-full object-contain" onContextMenu={(e) => e.preventDefault()} />
        <div className="flex flex-col p-4">
          <h3 className="font-semibold">#{entry.id} {entry.title}</h3>
          <p className="mb-3 whitespace-pre-wrap text-sm text-stone-600">{entry.description}</p>
          <div className="flex-1 space-y-2 overflow-auto text-sm">
            {comments?.map((c) => <div key={c.id} className="rounded-lg bg-stone-100 p-2">{c.body}</div>)}
          </div>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/entries/${entry.id}/comments`, { body: { body } }); setBody(""); reload(); }); }}>
            <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Оролцогчид хувийн сэтгэгдэл…" />
            <button className="btn-primary" disabled={busy || !body.trim()}>Илгээх</button>
          </form>
          <ErrorText error={error} />
        </div>
      </div>
    </div>
  );
}
