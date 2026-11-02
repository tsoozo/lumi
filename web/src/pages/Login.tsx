import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorText, useAction } from "../components/ui";

export default function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();

  return (
    <div className="card mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Нэвтрэх</h1>
      <p className="mb-4 text-sm text-stone-500">Нууц үг хэрэггүй — имэйл рүү чинь 6 оронтой код илгээнэ.</p>
      {!sent ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/auth/request-code", { body: { email } });
              setSent(true);
            });
          }}
        >
          <label className="label">Имэйл</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ner@gmail.com" />
          <button className="btn-primary mt-4 w-full" disabled={busy}>
            Код авах
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/auth/login", { body: { email, code } });
              await refresh();
              nav(params.get("next") ?? "/");
            });
          }}
        >
          <p className="mb-3 text-sm">
            <b>{email}</b> руу код илгээлээ (10 минут хүчинтэй).
          </p>
          <label className="label">Код</label>
          <input className="input tracking-[0.4em]" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <button className="btn-primary mt-4 w-full" disabled={busy}>
            Нэвтрэх
          </button>
          <button type="button" className="mt-2 w-full text-sm text-stone-500" onClick={() => setSent(false)}>
            Өөр имэйл
          </button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}
