import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, STATUS_LABELS } from "../api";
import { useAuth } from "../auth";

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setError(null);
    api<T>(path)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

/** Runs an async action with busy state and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export const ErrorText = ({ error }: { error: string | null }) => (error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null);
export const Loading = () => <p className="py-10 text-center text-stone-500">Ачаалж байна…</p>;
export const StatusBadge = ({ status }: { status: string }) => {
  const color =
    status === "active" || status === "extended"
      ? "bg-green-100 text-green-800"
      : status === "completed"
        ? "bg-stone-200 text-stone-700"
        : ["refund_pending", "refunded", "cancelled", "disputed"].includes(status)
          ? "bg-red-100 text-red-800"
          : "bg-amber-100 text-amber-800";
  return <span className={`badge ${color}`}>{STATUS_LABELS[status] ?? status}</span>;
};

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user)
    return (
      <div className="card mx-auto max-w-md text-center">
        <p className="mb-4">Үргэлжлүүлэхийн тулд нэвтэрнэ үү.</p>
        <Link className="btn-primary" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
          Нэвтрэх
        </Link>
      </div>
    );
  return <>{children}</>;
}

export function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost px-2 py-1 text-xs"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      {ok ? "Хуулсан ✓" : "Хуулах"}
    </button>
  );
}

export function Stars({ value, onChange }: { value: number | null; onChange?: (n: number) => void }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)} className={`text-lg ${value && n <= value ? "text-brand" : "text-stone-300"}`} aria-label={`${n} од`}>
          ★
        </button>
      ))}
    </span>
  );
}
