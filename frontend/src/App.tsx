import { Fragment, useCallback, useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import AdminPortal from "./Admin";

type User = { id: string; name: string; email: string; role: string };
type Usage = {
  plan: string;
  planCode: string;
  receiptLimit: number;
  receiptsUsed: number;
  remaining: number;
  percent: number;
};
type Receipt = {
  id: string;
  store_name?: string;
  total?: number | string;
  date?: string;
  payment_method?: string;
  items?: { id: string; name: string; quantity?: number | string; price?: number | string }[];
};
type Analytics = { totalReceipts: number; totalSpend: number; averagePerDay: number; byDay: Record<string, number> };

const API = (window.location.pathname.replace(/\/+$/, "") || "") + "/api";
function store() {
  const t = localStorage.getItem("et_token");
  return t ? JSON.parse(t) as { token: string; user: User } : null;
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(API + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `Request failed (${res.status})`);
  }
  return res.json();
}

function Login({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const j = await api("/auth/login", { method: "POST", body: { email, password } });
      onLogin(j.token, j.user);
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="bg-white p-8 rounded-2xl shadow w-96">
        <h1 className="text-2xl font-bold mb-1">Expense Tracker</h1>
        <p className="text-slate-500 mb-6">Multi-tenant receipt &amp; expense platform</p>
        {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
        <input className="input w-full mb-3" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <input className="input w-full mb-5" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        <button className="btn w-full">Sign in</button>
        <p className="text-xs text-slate-400 mt-4 text-center">demo@example.com / Demo12345!</p>
      </form>
    </div>
  );
}

function QuotaBar({ u, onUpgrade }: { u: Usage; onUpgrade: () => void }) {
  const color = u.percent >= 100 ? "bg-red-500" : u.percent >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="bg-white p-5 rounded-2xl shadow">
      <div className="flex justify-between items-center mb-2">
        <div>
          <span className="text-xs uppercase tracking-wide text-slate-400">{u.plan} plan</span>
          <h3 className="text-lg font-semibold">{u.receiptsUsed} / {u.receiptLimit} receipts</h3>
        </div>
        <button onClick={onUpgrade} className="text-sm text-indigo-600 font-medium hover:underline">Upgrade</button>
      </div>
      <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${u.percent}%` }} />
      </div>
      <p className="text-xs text-slate-500 mt-2">{u.remaining} remaining this month</p>
    </div>
  );
}

function Upload({ token, onDone }: { token: string; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    (e.target as HTMLInputElement).value = "";
    const fd = new FormData();
    fd.append("file", f);
    setBusy(true);
    setMsg("Running OCR on receipt…");
    fetch(API + "/receipts/ocr", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || "upload failed");
        const rc = j.receipt;
        const items = rc.items?.length ? ` · ${rc.items.length} line item${rc.items.length > 1 ? "s" : ""}` : "";
        setMsg(`OCR done — ${rc.store_name || "receipt"} $${Number(rc.total || 0).toFixed(2)}${items} (${j.usage?.remaining} left)`);
        onDone();
      })
      .catch((x) => setMsg((x as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="bg-white p-5 rounded-2xl shadow">
      <h3 className="font-semibold mb-3">Upload &amp; OCR receipt</h3>
      <label className={`block border-2 border-dashed border-slate-300 rounded-xl p-6 text-center text-slate-500 cursor-pointer hover:border-indigo-400 ${busy ? "opacity-50 pointer-events-none" : ""}`}>
        {busy ? "Processing…" : "Drop a receipt image here or click"}
        <input type="file" className="hidden" onChange={upload} accept="image/*" />
      </label>
      {msg && <p className="text-xs mt-3 text-slate-600">{msg}</p>}
    </div>
  );
}

function SpendChart({ a }: { a: Analytics }) {
  const data = Object.entries(a.byDay).map(([d, v]) => ({ day: d.slice(5), spend: v })).slice(-14);
  return (
    <div className="bg-white p-5 rounded-2xl shadow">
      <h3 className="font-semibold mb-3">Spend per day</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <XAxis dataKey="day" fontSize={10} />
          <YAxis fontSize={10} />
          <Tooltip />
          <Line type="monotone" dataKey="spend" stroke="#6366f1" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function App() {
  const [sess, setSess] = useState(store());
  const [usage, setUsage] = useState<Usage | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sess) return;
    try {
      const [u, a, r] = await Promise.all([
        api("/billing/usage", { token: sess.token }),
        api("/export/analytics", { token: sess.token }),
        api("/receipts", { token: sess.token }),
      ]);
      setUsage(u); setAnalytics(a); setReceipts(r.data);
    } catch (e) {
      console.error(e);
    }
  }, [sess]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!sess) {
    return <Login onLogin={(token, user) => {
      localStorage.setItem("et_token", JSON.stringify({ token, user }));
      setSess({ token, user });
    }} />;
  }

  // Super admins land on the Admin Portal (org dashboard needs an org).
  if (sess.user.role === "super_admin") {
    return (
      <div className="min-h-screen p-6">
        <div className="mb-6 flex justify-between items-center">
          <h1 className="text-xl font-semibold">Expense Tracker · {sess.user.email}</h1>
          <button className="text-sm text-slate-500 hover:text-slate-800"
            onClick={() => { localStorage.removeItem("et_token"); setSess(null); }}>Sign out</button>
        </div>
        <AdminPortal token={sess.token} />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 space-y-6">
      <header className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-500">{sess.user.email} · {sess.user.role}</p>
        </div>
        <button className="text-sm text-slate-500 hover:text-slate-800"
          onClick={() => { localStorage.removeItem("et_token"); setSess(null); }}>
          Sign out
        </button>
      </header>

      <div className="grid md:grid-cols-2 gap-6">
        {usage && <QuotaBar u={usage} onUpgrade={() => alert("Stripe Checkout — mock mode. See /api/billing/checkout")} />}
        <Upload token={sess.token} onDone={refresh} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {analytics && <SpendChart a={analytics} />}
        <div className="bg-white p-5 rounded-2xl shadow">
          <h3 className="font-semibold mb-3">Summary</h3>
          {analytics ? (
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Receipts" val={analytics.totalReceipts} />
              <Stat label="Total" val={`$${analytics.totalSpend.toFixed(2)}`} />
              <Stat label="Avg/day" val={`$${analytics.averagePerDay}`} />
            </div>
          ) : <p className="text-slate-400 text-sm">Loading…</p>}
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl shadow">
        <h3 className="font-semibold mb-3">Recent receipts <span className="text-xs font-normal text-slate-400">(click a row to expand line items)</span></h3>
        {receipts.length === 0 ? (
          <p className="text-slate-400 text-sm">No receipts yet — upload or wire an n8n OCR webhook.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-400 text-xs uppercase">
              <th className="py-2">Store</th><th>Date</th><th>Total</th><th>Payment</th><th className="w-8" />
            </tr></thead>
            <tbody>{receipts.map((r) => {
              const open = openId === r.id;
              const items = r.items || [];
              const subtotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
              return (
                <Fragment key={r.id}>
                  <tr
                    className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                    onClick={() => setOpenId(open ? null : r.id)}
                  >
                    <td className="py-2 font-medium">{r.store_name || "—"}</td>
                    <td>{r.date ? r.date.slice(0, 10) : "—"}</td>
                    <td>${Number(r.total || 0).toFixed(2)}</td>
                    <td>{r.payment_method || "—"}</td>
                    <td className="text-slate-400 text-center">{open ? "▾" : "▸"}</td>
                  </tr>
                  {open && (
                    <tr className="border-t border-slate-100 bg-slate-50">
                      <td colSpan={5} className="px-4 py-3">
                        {items.length === 0 ? (
                          <p className="text-xs text-slate-500 pl-4">No line items extracted for this receipt.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead><tr className="text-left text-slate-400 uppercase">
                                <th className="py-1 pl-4">Item</th><th>Qty</th><th>Price</th><th className="text-right pr-4">Subtotal</th>
                              </tr></thead>
                              <tbody>{items.map((it) => (
                                <tr key={it.id} className="border-t border-slate-200/70">
                                  <td className="py-1.5 pl-4">{it.name}</td>
                                  <td>{Number(it.quantity || 1)}</td>
                                  <td>${Number(it.price || 0).toFixed(2)}</td>
                                  <td className="text-right pr-4">${(Number(it.price || 0) * Number(it.quantity || 1)).toFixed(2)}</td>
                                </tr>
                              ))}</tbody>
                              <tfoot>
                                <tr className="border-t border-slate-300 font-semibold">
                                  <td className="py-1.5 pl-4" colSpan={3}>Sum of line items</td>
                                  <td className="text-right pr-4">${subtotal.toFixed(2)}</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, val }: { label: string; val: string | number }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xl font-semibold">{val}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}

export default App;