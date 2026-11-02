import { Link, useParams } from "react-router-dom";
import { CATEGORY_LABELS, dt, mnt, timeLeft } from "../api";
import { useAuth } from "../auth";
import { ErrorText, Loading, StatusBadge, useLoad } from "../components/ui";

export default function ContestDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data: c, error } = useLoad<any>(`/contests/${id}`, [user?.id]);
  const { data: mine } = useLoad<any[]>(user ? `/contests/${id}/entries` : null, [user?.id]);
  if (error) return <ErrorText error={error} />;
  if (!c) return <Loading />;
  const accepting = ["active", "extended"].includes(c.status);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">{CATEGORY_LABELS[c.category] ?? c.category}</span>
          <StatusBadge status={c.status} />
        </div>
        <h1 className="text-3xl font-bold">{c.title}</h1>
        <section className="card space-y-4">
          <Block title="Тайлбар" text={c.description} />
          <Block title="Шаардлага" text={c.requirements} />
          <Block title="Эх файлын формат" text={c.deliverableFormats} />
          {c.attachments?.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-stone-500">Хавсралт</h3>
              <ul className="space-y-1 text-sm">
                {c.attachments.map((a: any) => (
                  <li key={a.url}><a className="underline" href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a></li>
                ))}
              </ul>
            </div>
          )}
        </section>
        {!c.isClient && mine && mine.length > 0 && (
          <section className="card">
            <h2 className="mb-3 font-semibold">{["handover", "payout_pending", "completed"].includes(c.status) ? "Бүх бүтээл" : "Миний бүтээлүүд (бусдад харагдахгүй)"}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {mine.map((e) => (
                <figure key={e.id} className="overflow-hidden rounded-lg border">
                  <img src={e.watermarkedUrl} alt={e.title} className="aspect-square w-full object-cover" />
                  <figcaption className="p-2 text-xs">{e.isWinner ? "🏆 " : ""}{e.title || `#${e.id}`}{e.status === "removed" && " · хасагдсан"}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
      </div>
      <aside className="space-y-4">
        <div className="card">
          <div className="text-sm text-stone-500">Ялагчийн шагнал</div>
          <div className="text-3xl font-bold">{mnt(c.prizeAmount)}</div>
          <div className="mt-1 text-xs text-green-700">✓ Баталгаат — мөнгө урьдчилан төлөгдсөн</div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-stone-500">Бүтээл</dt><dd>{c.entryCount}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Үлдсэн хугацаа</dt><dd>{accepting ? timeLeft(c.submissionDeadline) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Дуусах</dt><dd>{dt(c.submissionDeadline)}</dd></div>
          </dl>
          {c.isClient ? (
            <Link className="btn-primary mt-4 w-full" to={["draft", "awaiting_payment", "payment_review"].includes(c.status) ? `/contests/${c.id}/pay` : `/my/contests/${c.id}`}>
              Миний самбар
            </Link>
          ) : accepting ? (
            <Link className="btn-accent mt-4 w-full" to={user ? `/contests/${c.id}/submit` : `/login?next=/contests/${c.id}/submit`}>
              Бүтээл оруулах
            </Link>
          ) : null}
          {c.isWinner && c.handover && <Link className="btn-accent mt-2 w-full" to={`/handover/${c.handover.id}`}>🏆 Эх файл илгээх</Link>}
        </div>
        <div className="card text-xs text-stone-500">
          Бүтээлүүд нууцлагдмал: оролцогчид бие биеийнхээ бүтээлийг харахгүй. Захиалагч зөвхөн ялагчийн бүтээлийг ашиглах эрхтэй — ялаагүй бүтээл таны өмч хэвээр.
        </div>
      </aside>
    </div>
  );
}

const Block = ({ title, text }: { title: string; text: string }) =>
  text ? (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-stone-500">{title}</h3>
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  ) : null;
