import { useEffect, useState } from "react";

const API = (window.location.pathname.replace(/\/+$/, "") || "") + "/api";

type Plan = { plan_code: string; name: string; monthly_price: string; receipt_limit: number; is_active: boolean; stripe_price_id: string | null };
type CostMetrics = { ocr_cost_per_unit: string; email_cost_per_unit: string; storage_cost_per_gb: string; scraper_cost_per_run: string; estimatedCostPerReceipt?: number; planMargins?: { plan: string; price: number; breakEvenReceipts: number }[] };

async function api(path: string, token: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Request failed (${res.status})`);
  return j;
}

export default function AdminPortal({ token }: { token: string }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [costs, setCosts] = useState<CostMetrics | null>(null);
  const [orgs, setOrgs] = useState<{ id: string; name: string; plan?: { plan_code: string } | null }[]>([]);
  const [tab, setTab] = useState<"plans" | "costs" | "orgs">("plans");
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const [p, c, o] = await Promise.all([
        api("/admin/plans", token),
        api("/admin/costs", token),
        api("/admin/orgs", token),
      ]);
      setPlans(p.data); setCosts(c); setOrgs(o.data);
    } catch (e) { setMsg((e as Error).message); }
  };
  useEffect(() => { load(); }, [token]);

  const updatePlan = async (code: string) => {
    try {
      const body = { ...(edit[code + ".price"] ? { monthly_price: Number(edit[code + ".price"]) } : {}),
                     ...(edit[code + ".limit"] ? { receipt_limit: Number(edit[code + ".limit"]) } : {}) };
      const r = await api(`/admin/plans/${code}`, token, { method: "PATCH", body: { ...body, proration: "always_invoice" } });
      setMsg(`Plan ${code} updated — ${r.note || "synced to Stripe"}`);
      load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const updateCosts = async () => {
    try {
      await api("/admin/costs", token, { method: "PATCH", body: {
        ocr_cost_per_unit: Number(edit.ocr || 0), email_cost_per_unit: Number(edit.email || 0),
        storage_cost_per_gb: Number(edit.storage || 0), scraper_cost_per_run: Number(edit.scrape || 0),
      }});
      setMsg("Cost metrics updated");
      load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const tabBtn = (t: typeof tab, label: string) => (
    <button onClick={() => setTab(t)} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === t ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{label}</button>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Super Admin Portal</h1>
        <p className="text-sm text-slate-500">Plan &amp; cost management · RBAC super_admin · MFA required in prod</p>
      </header>

      <div className="flex gap-2">{tabBtn("plans", "Plans")}{tabBtn("costs", "Cost engine")}{tabBtn("orgs", "Organizations")}</div>
      {msg && <p className="text-sm text-indigo-600">{msg}</p>}

      {tab === "plans" && (
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr>
              <th className="p-3">Plan</th><th>Price</th><th>Cap/mo</th><th>Stripe price ID</th><th>Active</th><th></th>
            </tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.plan_code} className="border-t border-slate-100 align-middle">
                  <td className="p-3 font-medium capitalize">{p.name}</td>
                  <td>
                    <input className="input w-20" defaultValue={p.monthly_price} placeholder="0.00"
                      onChange={(e) => setEdit((m) => ({ ...m, [p.plan_code + ".price"]: e.target.value }))} />
                  </td>
                  <td>
                    <input className="input w-20" defaultValue={p.receipt_limit} placeholder="0"
                      onChange={(e) => setEdit((m) => ({ ...m, [p.plan_code + ".limit"]: e.target.value }))} />
                  </td>
                  <td className="text-slate-400 text-xs">{p.stripe_price_id || "—"}</td>
                  <td>{p.is_active ? <span className="text-emerald-600">●</span> : <span className="text-slate-300">○</span>}</td>
                  <td><button className="btn !py-1 !px-3" onClick={() => updatePlan(p.plan_code)}>Save</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-400 p-3">Price/cap changes sync to Stripe (proration: always_invoice). Grandfathering available on the API.</p>
        </div>
      )}

      {tab === "costs" && costs && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl shadow p-5">
            <h3 className="font-semibold mb-3">Operational cost engine</h3>
            {(["ocr_cost_per_unit", "email_cost_per_unit", "storage_cost_per_gb", "scraper_cost_per_run"] as const).map((k) => (
              <label key={k} className="block mb-3">
                <span className="text-xs uppercase text-slate-400">{k}</span>
                <input className="input w-full" defaultValue={costs[k]} onChange={(e) => setEdit((m) => ({ ...m, [k.replace("_cost_per_unit", "").replace("_cost_per_gb", "").replace("_cost_per_run", "").replace(/_cost/g, "cost")]: e.target.value }))} />
              </label>
            ))}
            <p className="text-sm text-slate-500 mb-3">Est. cost / receipt: <b>${(costs.estimatedCostPerReceipt ?? 0).toFixed(4)}</b></p>
            <button className="btn" onClick={updateCosts}>Save costs</button>
          </div>
          <div className="bg-white rounded-2xl shadow p-5">
            <h3 className="font-semibold mb-3">Margin / break-even</h3>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Plan</th><th>Price</th><th>Break-even receipts</th></tr></thead>
              <tbody>
                {(costs.planMargins ?? []).map((m) => (
                  <tr key={m.plan} className="border-t border-slate-100">
                    <td className="py-1.5 capitalize">{m.plan}</td>
                    <td>${Number(m.price).toFixed(2)}</td>
                    <td>{m.breakEvenReceipts === Infinity ? "∞" : m.breakEvenReceipts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "orgs" && (
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="p-3">Org</th><th>Plan</th></tr></thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="p-3">{o.name}</td>
                  <td className="capitalize">{o.plan?.plan_code || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}