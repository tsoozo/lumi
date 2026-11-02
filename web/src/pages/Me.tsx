import { useState } from "react";
import { Link } from "react-router-dom";
import { api, dt, mnt, STATUS_LABELS } from "../api";
import { useAuth } from "../auth";
import { ErrorText, Loading, RequireAuth, StatusBadge, useAction, useLoad } from "../components/ui";

export default function Me() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

const NOTIF: Record<string, string> = {
  payment_confirmed: "Төлбөр баталгаажлаа", payment_rejected: "Төлбөр олдсонгүй", payment_mismatch: "Төлбөрийн дүн зөрүүтэй", contest_published: "Уралдаан нийтлэгдлээ",
  submission_closed: "Ялагчаа сонгоно уу", low_entries: "Бүтээл цөөн ирлээ", selection_reminder: "Ялагч сонгох сануулга", you_won: "🏆 Та яллаа!",
  handover_files_sent: "Эх файл ирлээ", bank_account_required: "Банкны данс бүртгүүлнэ үү", split_prize: "Шагнал хуваагдлаа", split_prize_client: "Шагнал хуваагдлаа",
  payout_sent: "Мөнгө шилжлээ", payout_problem: "Дансаа шалгана уу", refund_started: "Буцаалт эхэллээ", entry_removed: "Бүтээл хасагдлаа", contest_rejected: "Уралдаан татгалзагдлаа",
};

function Inner() {
  const { user, notifications, refresh } = useAuth();
  const { data: me, reload } = useLoad<any>("/me");
  const { data: contests } = useLoad<any[]>("/me/contests");
  const { data: entries } = useLoad<any[]>("/me/entries");
  const { data: earnings } = useLoad<any>("/me/earnings");
  const [profile, setProfile] = useState({ fullName: user!.fullName ?? "", displayName: user!.displayName ?? "", phone: user!.phone ?? "" });
  const [bank, setBank] = useState({ bankName: "", accountNumber: "", accountHolderName: "", code: "" });
  const [codeSent, setCodeSent] = useState(false);
  const p = useAction();
  const b = useAction();
  if (!me) return <Loading />;
  const acct = me.bankAccounts?.find((a: any) => a.isActive);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {notifications.length > 0 && (
        <section className="card lg:col-span-2">
          <div className="mb-2 flex justify-between"><h2 className="font-semibold">Мэдэгдэл</h2><button className="text-sm text-stone-500" onClick={async () => { await api("/me/notifications/read", { method: "POST" }); refresh(); }}>Бүгдийг уншсан</button></div>
          <ul className="space-y-1 text-sm">
            {notifications.map((n) => {
              const pl = JSON.parse(n.payload);
              return <li key={n.id}>{pl.contestId ? <Link className="underline" to={`/contests/${pl.contestId}`}>{NOTIF[n.type] ?? n.type}</Link> : NOTIF[n.type] ?? n.type}{pl.title ? ` — ${pl.title}` : ""}{pl.amount ? ` (${mnt(pl.amount)})` : ""} <span className="text-xs text-stone-400">{dt(n.createdAt)}</span></li>;
            })}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold">Профайл</h2>
        <p className="text-sm text-stone-500">{user!.email}</p>
        <div><label className="label">Овог нэр (банкны данстай таарах ёстой)</label><input className="input" value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} /></div>
        <div><label className="label">Харагдах нэр</label><input className="input" value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} /></div>
        <div><label className="label">Утас</label><input className="input" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} /></div>
        <button className="btn-primary" disabled={p.busy} onClick={() => p.run(async () => { await api("/me", { method: "PATCH", body: profile }); await refresh(); })}>Хадгалах</button>
        <ErrorText error={p.error} />
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Банкны данс</h2>
        <p className="text-xs text-stone-500">Шагнал болон буцаалтыг энэ данс руу шилжүүлнэ. Аюулгүй байдлын үүднээс өөрчлөхөд имэйл код шаардана; шилжүүлэг хүлээгдэж байхад өөрчилбөл 48 цаг түгжигдэнэ.</p>
        {acct && (
          <div className="rounded-lg bg-stone-100 p-3 text-sm">
            {acct.bankName} · {acct.accountNumberMasked} · {acct.accountHolderName} {acct.isVerified ? "✓" : <span className="text-amber-700">(нэр профайлтай таарахгүй)</span>}
            {acct.lockedUntil && acct.lockedUntil * 1000 > Date.now() && <div className="text-xs text-amber-700">Түгжээтэй: {dt(acct.lockedUntil)} хүртэл</div>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Банк</label><input className="input" value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} placeholder="Голомт" /></div>
          <div><label className="label">Дансны дугаар</label><input className="input" inputMode="numeric" value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} /></div>
        </div>
        <div><label className="label">Эзэмшигчийн нэр</label><input className="input" value={bank.accountHolderName} onChange={(e) => setBank({ ...bank, accountHolderName: e.target.value })} /></div>
        {!codeSent ? (
          <button className="btn-ghost" disabled={b.busy} onClick={() => b.run(async () => { await api("/auth/request-code", { body: { email: user!.email } }); setCodeSent(true); })}>Баталгаажуулах код авах</button>
        ) : (
          <div className="flex gap-2">
            <input className="input" placeholder="Имэйлээр ирсэн код" value={bank.code} onChange={(e) => setBank({ ...bank, code: e.target.value })} />
            <button className="btn-primary" disabled={b.busy} onClick={() => b.run(async () => { await api("/me/bank-accounts", { body: bank }); setCodeSent(false); setBank({ bankName: "", accountNumber: "", accountHolderName: "", code: "" }); reload(); })}>{acct ? "Солих" : "Бүртгэх"}</button>
          </div>
        )}
        <ErrorText error={b.error} />
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Миний уралдаанууд</h2>
        {!contests?.length ? <p className="text-sm text-stone-500">Алга. <Link className="underline" to="/contests/new">Уралдаан зарлах</Link></p> : (
          <ul className="divide-y text-sm">
            {contests.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <Link className="underline" to={["draft", "awaiting_payment", "payment_review"].includes(c.status) ? `/contests/${c.id}/pay` : `/my/contests/${c.id}`}>{c.title}</Link>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Миний оролцоо</h2>
        {!entries?.length ? <p className="text-sm text-stone-500">Одоогоор бүтээл оруулаагүй.</p> : (
          <ul className="divide-y text-sm">
            {entries.map((e) => (
              <li key={e.entryId} className="flex items-center justify-between py-2">
                <Link className="underline" to={`/contests/${e.contestId}`}>{e.contestTitle}</Link>
                <span className="flex items-center gap-2">
                  {e.isWinner && e.handoverId && <Link className="btn-accent px-2 py-1 text-xs" to={`/handover/${e.handoverId}`}>🏆 Хүлээлгэн өгөх</Link>}
                  <span className="text-xs text-stone-500">{STATUS_LABELS[e.contestStatus]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card lg:col-span-2">
        <h2 className="mb-1 font-semibold">Орлого</h2>
        <p className="mb-3 text-2xl font-bold">{mnt(earnings?.total)}</p>
        <ul className="divide-y text-sm">
          {earnings?.items.map((p: any) => (
            <li key={p.id} className="flex justify-between py-2">
              <span>{p.contestTitle} · {p.type === "refund" ? "буцаалт" : p.type === "split_prize" ? "хуваасан шагнал" : "шагнал"}</span>
              <span>{mnt(p.amount)} · {p.status === "sent" ? `шилжсэн ${dt(p.sentAt)}${p.bankTransactionRef ? ` (${p.bankTransactionRef})` : ""}` : p.status === "failed" ? "асуудалтай — дансаа шалгана уу" : `хүлээгдэж буй (${dt(p.dueAt)}-аас өмнө)`}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
