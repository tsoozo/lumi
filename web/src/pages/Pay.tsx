import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, mnt, uploadFile } from "../api";
import { CopyButton, ErrorText, Loading, RequireAuth, StatusBadge, useAction, useLoad } from "../components/ui";

export default function Pay() {
  return (
    <RequireAuth>
      <PayInner />
    </RequireAuth>
  );
}

function PayInner() {
  const { id } = useParams();
  const { data: c, error: loadErr, reload } = useLoad<any>(`/contests/${id}`);
  const [f, setF] = useState({ reportedAmount: "", payerBankName: "", payerAccountName: "" });
  const [receipt, setReceipt] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  if (loadErr) return <ErrorText error={loadErr} />;
  if (!c) return <Loading />;
  if (!c.isClient) return <p>Энэ хуудас зөвхөн захиалагчид.</p>;
  const p = c.payment;
  const lastMismatch = p?.history?.find((x: any) => x.status === "amount_mismatch");
  const lastRejected = p?.history?.[0]?.status === "rejected" ? p.history[0] : null;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Төлбөр</h1>
        <StatusBadge status={c.status} />
      </div>
      <p className="text-stone-600">{c.title}</p>

      {c.status === "payment_review" && (
        <div className="card border-amber-300 bg-amber-50">
          <b>Шалгаж байна.</b> Админ банкны хуулгыг шалгаад баталгаажуулна (ихэвчлэн хэдэн цагийн дотор). Баталгаажмагц имэйлээр мэдэгдэнэ.
        </div>
      )}
      {!["awaiting_payment", "payment_review"].includes(c.status) && (
        <div className="card">
          Төлбөр баталгаажсан. <Link className="underline" to={`/my/contests/${c.id}`}>Уралдааны самбар руу →</Link>
        </div>
      )}

      {c.status === "awaiting_payment" && p && (
        <>
          {lastRejected && <div className="card border-red-300 bg-red-50 text-sm">Өмнөх мэдэгдэл: <b>{lastRejected.rejectReason}</b>. Шалгаад дахин мэдэгдэнэ үү.</div>}
          {lastMismatch && (
            <div className="card border-amber-300 bg-amber-50 text-sm">
              {mnt(lastMismatch.receivedAmount)} орсон. Үлдэгдэл <b>{mnt(p.amountDue)}</b>-ийг нэмж шилжүүлнэ үү, эсвэл{" "}
              <button className="underline" onClick={() => run(async () => { await api(`/contests/${c.id}/refund-partial`, { method: "POST" }); reload(); })}>орсон мөнгөө буцааж авах</button>.
            </div>
          )}
          <div className="card space-y-3">
            <Row label="Банк" value={p.bankName} />
            <Row label="Дансны дугаар" value={p.accountNumber} copy />
            <Row label="Эзэмшигч" value={p.accountHolder} />
            <Row label="Дүн" value={mnt(p.amountDue)} copy={String(p.amountDue)} />
            <Row label="Гүйлгээний утга" value={p.refCode} copy big />
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">⚠️ Гүйлгээний утгад <b>{p.refCode}</b> гэж заавал бичнэ үү. Утгагүй шилжүүлсэн төлбөр удаашина.</p>
          </div>

          <form
            className="card space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const receiptKey = receipt ? await uploadFile(receipt, receipt.name, "receipt") : undefined;
                await api(`/contests/${c.id}/payments`, { body: { reportedAmount: Number(f.reportedAmount || p.amountDue), payerBankName: f.payerBankName, payerAccountName: f.payerAccountName, receiptKey } });
                reload();
              });
            }}
          >
            <h2 className="font-semibold">Шилжүүлсний дараа</h2>
            <div>
              <label className="label">Шилжүүлсэн дүн</label>
              <input className="input" type="number" placeholder={String(p.amountDue)} value={f.reportedAmount} onChange={(e) => setF({ ...f, reportedAmount: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Таны банк</label>
                <input className="input" required value={f.payerBankName} onChange={(e) => setF({ ...f, payerBankName: e.target.value })} placeholder="Хаан банк" />
              </div>
              <div>
                <label className="label">Данс эзэмшигчийн нэр</label>
                <input className="input" required value={f.payerAccountName} onChange={(e) => setF({ ...f, payerAccountName: e.target.value })} placeholder="Б.Болд" />
              </div>
            </div>
            <div>
              <label className="label">Баримтын зураг (заавал биш)</label>
              <input type="file" accept=".png,.jpg,.jpeg,.webp,.pdf" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </div>
            <button className="btn-accent w-full" disabled={busy}>Шилжүүлсэн</button>
            <ErrorText error={error} />
          </form>
        </>
      )}
    </div>
  );
}

function Row({ label, value, copy, big }: { label: string; value: string; copy?: boolean | string; big?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-stone-500">{label}</span>
      <span className="flex items-center gap-2">
        <span className={big ? "font-mono text-xl font-bold" : "font-medium"}>{value || "—"}</span>
        {copy && value && <CopyButton text={typeof copy === "string" ? copy : value} />}
      </span>
    </div>
  );
}
