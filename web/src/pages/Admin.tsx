import { useState } from "react";
import { api, dt, mnt } from "../api";
import { useAuth } from "../auth";
import { ErrorText, Loading, RequireAuth, StatusBadge, useAction, useLoad } from "../components/ui";

const TABS = ["Төлбөр", "Шилжүүлэг", "Уралдаан", "Тохиргоо", "Админ", "Audit log"] as const;

export default function Admin() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { user } = useAuth();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Төлбөр");
  const { data: today } = useLoad<any>(user?.role === "admin" ? "/admin/today" : null);
  if (user?.role !== "admin") return <p>Эрхгүй.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-bold">Админ</h1>
        <span className="badge">{user.adminLevel}</span>
        {today && <span className="text-sm text-stone-600">Өнөөдөр: орсон {mnt(today.inAmount)} · гарсан {mnt(today.outAmount)} · шалгах {today.pendingPayments} · шилжүүлэх {today.pendingPayouts}</span>}
      </div>
      <p className="text-xs text-stone-500">Telegram bot ажиллахгүй үед энэ самбар нөөц болно. Хоёулаа ижил серверийн функцийг дууддаг.</p>
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => <button key={t} className={t === tab ? "btn-primary" : "btn-ghost"} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {tab === "Төлбөр" && <Payments />}
      {tab === "Шилжүүлэг" && <Payouts />}
      {tab === "Уралдаан" && <Contests />}
      {tab === "Тохиргоо" && <Settings />}
      {tab === "Админ" && <Admins />}
      {tab === "Audit log" && <Logs />}
    </div>
  );
}

function Payments() {
  const { data, reload } = useLoad<any[]>("/admin/payments?status=reported");
  const { busy, error, run } = useAction();
  if (!data) return <Loading />;
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">⚠️ Баримтын зургийг биш, банкны аппын хуулгыг шалгана: утга + дүн + огноо гурвуулаа таарах ёстой.</p>
      <ErrorText error={error} />
      {data.length === 0 && <p className="text-stone-500">Шалгах төлбөр алга.</p>}
      {data.map(({ payment: p, contest: c }) => (
        <div key={p.id} className="card space-y-2 text-sm">
          <div className="font-semibold">#{p.id} {c.title} <span className="font-mono">({c.ref})</span></div>
          <div>Дүн: <b>{mnt(p.reportedAmount)}</b> {p.reportedAmount !== p.expectedAmount && <span className="text-amber-700">(хүлээгдэж буй {mnt(p.expectedAmount)})</span>} · {p.payerBankName} · {p.payerAccountName} · {dt(p.createdAt)}</div>
          {p.receiptImageUrl && <a className="underline" href={`/api/files/${p.receiptImageUrl}`} target="_blank" rel="noreferrer">Баримт</a>}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => { const ref = prompt("Банкны гүйлгээний дугаар (заавал биш):") ?? undefined; run(async () => { await api(`/admin/payments/${p.id}/confirm`, { body: { bankTransactionRef: ref || undefined } }); reload(); }); }}>✅ Орсон</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { const n = prompt("Хэдэн төгрөг орсон бэ?"); if (n) run(async () => { await api(`/admin/payments/${p.id}/mismatch`, { body: { receivedAmount: Number(n) } }); reload(); }); }}>⚠️ Дүн зөрүүтэй</button>
            <button className="btn-danger" disabled={busy} onClick={() => { const r = prompt("Шалтгаан: not_found / wrong_ref / other", "not_found"); if (r) run(async () => { await api(`/admin/payments/${p.id}/reject`, { body: { reason: r } }); reload(); }); }}>❌ Ороогүй</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Payouts() {
  const { data, reload, error: loadErr } = useLoad<any[]>("/admin/payouts?status=pending");
  const { busy, error, run } = useAction();
  if (loadErr) return <ErrorText error={loadErr} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-3">
      <ErrorText error={error} />
      {data.length === 0 && <p className="text-stone-500">Шилжүүлэх зүйл алга.</p>}
      {data.map((p) => (
        <div key={p.id} className="card space-y-1 text-sm">
          <div className="font-semibold">{p.type === "refund" ? "↩️ Буцаалт" : "🏆 Шагнал"} #{p.id} · {p.contestTitle} ({p.refCode})</div>
          <div>Хүлээн авагч: {p.recipient}</div>
          <div>{p.account ? <>Банк: {p.account.bankName} · <span className="font-mono">{p.account.number}</span> · {p.account.holder} {!p.account.verified && <span className="text-amber-700">⚠️ нэр таарахгүй</span>}</> : <span className="text-amber-700">Данс бүртгүүлээгүй</span>}</div>
          <div>Дүн: <b>{mnt(p.amount)}</b> · Гүйлгээний утга: {p.refCode} {p.type === "refund" ? "буцаалт" : "шагнал"} · Эцсийн хугацаа {dt(p.dueAt)}</div>
          {p.account?.lockedUntil && p.account.lockedUntil * 1000 > Date.now() && <div className="text-amber-700">Данс саяхан өөрчлөгдсөн — {dt(p.account.lockedUntil)} хүртэл түгжээтэй</div>}
          <div className="flex gap-2 pt-1">
            <button className="btn-primary" disabled={busy || !p.account} onClick={() => {
              if (!confirm(`Итгэлтэй байна уу? ${mnt(p.amount)} → ${p.recipient}`)) return;
              const ref = prompt("Гүйлгээний дугаар:");
              if (ref) run(async () => { await api(`/admin/payouts/${p.id}/mark-sent`, { body: { bankTransactionRef: ref } }); reload(); });
            }}>📤 Шилжүүлсэн</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { const r = prompt("Асуудлын шалтгаан:"); if (r) run(async () => { await api(`/admin/payouts/${p.id}/problem`, { body: { reason: r } }); reload(); }); }}>⏸ Асуудалтай</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Contests() {
  const [status, setStatus] = useState("");
  const { data, reload } = useLoad<any[]>(`/admin/contests${status ? `?status=${status}` : ""}`);
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-3">
      <select className="input w-56" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Бүгд</option>
        {["pending_approval", "payment_review", "active", "selecting", "handover", "payout_pending", "disputed", "refund_pending", "completed"].map((s) => <option key={s}>{s}</option>)}
      </select>
      <ErrorText error={error} />
      {!data ? <Loading /> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th>#</th><th>Гарчиг</th><th>Төсөв</th><th>Төлөв</th><th></th></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="py-2">{c.id}</td>
                <td><a className="underline" href={`/contests/${c.id}`}>{c.title}</a> <span className="font-mono text-xs text-stone-400">{c.paymentRefCode}</span></td>
                <td>{mnt(c.budget)}</td>
                <td><StatusBadge status={c.status} /></td>
                <td className="space-x-1 text-right">
                  {c.status === "pending_approval" && <>
                    <button className="btn-primary px-2 py-1 text-xs" disabled={busy} onClick={() => run(async () => { await api(`/admin/contests/${c.id}/approve`, { method: "POST" }); reload(); })}>Нийтлэх</button>
                    <button className="btn-danger px-2 py-1 text-xs" disabled={busy} onClick={() => { const r = prompt("Татгалзах шалтгаан (100% буцаалт хийгдэнэ):"); if (r) run(async () => { await api(`/admin/contests/${c.id}/reject`, { body: { reason: r } }); reload(); }); }}>Татгалзах</button>
                  </>}
                  {["selecting", "disputed"].includes(c.status) && <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => confirm("Бүх бүтээл хасагдсан тул 100% буцаах уу?") && run(async () => { await api(`/admin/contests/${c.id}/refund-removed`, { method: "POST" }); reload(); })}>Буцаалт (хулгай)</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Settings() {
  const { user } = useAuth();
  const { data, setData } = useLoad<Record<string, any>>("/admin/settings");
  const { busy, error, run } = useAction();
  if (!data) return <Loading />;
  const editable = user?.adminLevel === "super";
  return (
    <div className="card space-y-3">
      {!editable && <p className="text-sm text-stone-500">Зөвхөн супер админ өөрчилнө.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(data).map(([k, v]) => (
          <div key={k}>
            <label className="label font-mono text-xs">{k}</label>
            {typeof v === "boolean" ? (
              <input type="checkbox" disabled={!editable} checked={v} onChange={(e) => setData({ ...data, [k]: e.target.checked })} />
            ) : (
              <input className="input" disabled={!editable} value={String(v)} onChange={(e) => setData({ ...data, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} />
            )}
          </div>
        ))}
      </div>
      {editable && <button className="btn-primary" disabled={busy} onClick={() => run(async () => setData(await api("/admin/settings", { method: "PUT", body: data })))}>Хадгалах</button>}
      <ErrorText error={error} />
    </div>
  );
}

function Admins() {
  const { data, reload } = useLoad<any[]>("/admin/users");
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState("reviewer");
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h3 className="font-semibold">Админ нэмэх (супер админ)</h3>
        <div className="flex flex-wrap gap-2">
          <input className="input w-64" placeholder="имэйл" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input w-40" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="reviewer">Шалгагч</option><option value="finance">Санхүү</option><option value="super">Супер</option>
          </select>
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => { const r = await api("/admin/invites", { body: { email, level } }); setCode(r.code); reload(); })}>Код үүсгэх</button>
        </div>
        {code && <p className="text-sm">Шинэ админ bot-д <code className="rounded bg-stone-100 px-1">/start {code}</code> гэж 15 минутын дотор илгээнэ.</p>}
        <ErrorText error={error} />
      </div>
      <ul className="card divide-y text-sm">
        {data?.map((u) => <li key={u.id} className="py-2">{u.email} · {u.adminLevel} · Telegram {u.telegramLinked ? "✓" : "—"}</li>)}
      </ul>
    </div>
  );
}

function Logs() {
  const { data } = useLoad<any[]>("/admin/audit-logs");
  if (!data) return <Loading />;
  return (
    <table className="w-full text-xs">
      <tbody>
        {data.map((l) => (
          <tr key={l.id} className="border-t align-top">
            <td className="py-1 pr-2 whitespace-nowrap">{dt(l.createdAt)}</td>
            <td className="pr-2">{l.actorType}{l.actorId ? `#${l.actorId}` : ""}</td>
            <td className="pr-2 font-mono">{l.action}</td>
            <td className="pr-2">{l.entityType}#{l.entityId}</td>
            <td className="font-mono text-stone-500">{l.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
