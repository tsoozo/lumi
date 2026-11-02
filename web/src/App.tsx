import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api";
import { AuthProvider, useAuth } from "./auth";
import Admin from "./pages/Admin";
import ContestDetail from "./pages/ContestDetail";
import Handover from "./pages/Handover";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Me from "./pages/Me";
import MyContest from "./pages/MyContest";
import NewContest from "./pages/NewContest";
import Pay from "./pages/Pay";
import Submit from "./pages/Submit";

function Header() {
  const { user, notifications, refresh } = useAuth();
  const nav = useNavigate();
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link to="/" className="text-xl font-bold tracking-tight">
          Lumi<span className="text-brand">.</span>
        </Link>
        <nav className="flex gap-4 text-sm">
          <NavLink to="/contests" className={({ isActive }) => (isActive ? "font-semibold" : "text-stone-600")}>
            Уралдаанууд
          </NavLink>
          {user?.role === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? "font-semibold" : "text-stone-600")}>
              Админ
            </NavLink>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link to="/contests/new" className="btn-accent">
            + Уралдаан зарлах
          </Link>
          {user ? (
            <>
              <Link to="/me" className="relative text-sm text-stone-700">
                {user.displayName ?? user.email}
                {notifications.length > 0 && <span className="absolute -right-3 -top-2 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{notifications.length}</span>}
              </Link>
              <button
                className="text-sm text-stone-500"
                onClick={async () => {
                  await api("/auth/logout", { method: "POST" });
                  await refresh();
                  nav("/");
                }}
              >
                Гарах
              </button>
            </>
          ) : (
            <Link to="/login" className="btn-ghost">
              Нэвтрэх
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/contests" element={<Home />} />
          <Route path="/contests/new" element={<NewContest />} />
          <Route path="/contests/:id" element={<ContestDetail />} />
          <Route path="/contests/:id/pay" element={<Pay />} />
          <Route path="/contests/:id/submit" element={<Submit />} />
          <Route path="/my/contests/:id" element={<MyContest />} />
          <Route path="/handover/:id" element={<Handover />} />
          <Route path="/me" element={<Me />} />
          <Route path="/login" element={<Login />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<p className="text-center text-stone-500">Хуудас олдсонгүй</p>} />
        </Routes>
      </main>
      <footer className="py-8 text-center text-xs text-stone-400">Lumi · Төсвөө тавь, хүн бүр оролдоно, чи нэгийг нь сонго.</footer>
    </AuthProvider>
  );
}
