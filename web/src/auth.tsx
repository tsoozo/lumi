import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  id: number;
  email: string;
  fullName: string | null;
  displayName: string | null;
  phone: string | null;
  role: "user" | "admin";
  adminLevel: "reviewer" | "finance" | "super" | null;
  telegramLinked: boolean;
}
interface AuthState {
  user: Me | null;
  loading: boolean;
  notifications: { id: number; type: string; payload: string; createdAt: number }[];
  refresh: () => Promise<void>;
}
const Ctx = createContext<AuthState>({ user: null, loading: true, notifications: [], refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, "refresh">>({ user: null, loading: true, notifications: [] });
  const refresh = useCallback(async () => {
    try {
      const r = await api("/me");
      setState({ user: r.user, loading: false, notifications: r.notifications ?? [] });
    } catch {
      setState({ user: null, loading: false, notifications: [] });
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
