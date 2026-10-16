import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { asyncHandler, AppError } from "../utils/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();

/** Field templates for downstream accounting tools. */
const TEMPLATES = {
  xero: {
    name: "Xero",
    fields: ["Date", "Description", "Amount", "TaxAmount", "Reference", "SupplierName"],
    get: (r: ReceiptRow) => [
      r.date,
      r.description,
      r.total,
      r.tax ?? "",
      r.reference,
      r.description,
    ],
  },
  quickbooks: {
    name: "QuickBooks",
    fields: ["TransactionDate", "Memo/Description", "Amount", "AccountName", "PaidThru"],
    get: (r: ReceiptRow) => [r.date, r.description, r.total, "Office Expenses", ""],
  },
  myob: {
    name: "MYOB",
    fields: ["Date", "Memo", "Amount", "Tax", "PaymentMethod"],
    get: (r: ReceiptRow) => [r.date, r.description, r.total, r.tax ?? "", r.paymentMethod],
  },
} as const;

type ReceiptRow = {
  date: string;
  description: string;
  total: number | null;
  tax: number | null;
  reference: string;
  paymentMethod: string;
};

type OutputCell = string | number | null;

function csvEscape(v: OutputCell): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(fields: OutputCell[], rows: OutputCell[][]): string {
  return [fields.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}

/** GET /api/export/csv?template=xero|quickbooks|myob&from=&to= */
router.get(
  "/csv",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId;
    if (!orgId) throw new AppError(403, "no_org", "Not a tenant user");
    const t = (req.query.template as string) || "xero";
    const template = TEMPLATES[t as keyof typeof TEMPLATES];
    if (!template) throw new AppError(400, "bad_template", `Unknown template: ${t}`);

    const where: Record<string, unknown>[] = [{ org_id: orgId }];
    if (req.query.from) where.push({ date: { gte: new Date(req.query.from as string) } });
    if (req.query.to) where.push({ date: { lte: new Date(req.query.to as string) } });

    const receipts = await prisma.receipts.findMany({
      where: { AND: where as never },
      orderBy: { createdAt: "asc" },
      include: { items: true },
    });

    const rows: OutputCell[][] = receipts.map((r) =>
      template.get({
        date: r.date ? r.date.toISOString().slice(0, 10) : "",
        description: `Receipt ${r.store_name || ""}`.trim(),
        total: r.total ? Number(r.total) : null,
        tax: r.tax ? Number(r.tax) : null,
        reference: r.id,
        paymentMethod: r.payment_method || "",
      })
    );

    const csv = buildCsv(template.fields as unknown as string[], rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="expenses-${t}-${Date.now()}.csv"`);
    res.send(csv);
  })
);

/** GET /api/export/analytics — simple spend summary for the dashboard. */
router.get(
  "/analytics",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const receipts = await prisma.receipts.findMany({ where: { org_id: orgId }, include: { items: true } });
    const totalSpend = receipts.reduce((s, r) => s + Number(r.total ?? 0), 0);
    const byStore: Record<string, number> = {};
    for (const r of receipts) {
      const key = r.store_name || "Unknown";
      byStore[key] = (byStore[key] || 0) + Number(r.total ?? 0);
    }
    const byDay: Record<string, number> = {};
    for (const r of receipts) {
      const day = r.date ? r.date.toISOString().slice(0, 10) : "unknown";
      byDay[day] = (byDay[day] || 0) + Number(r.total ?? 0);
    }
    res.json({
      totalReceipts: receipts.length,
      totalSpend,
      averagePerDay: Object.keys(byDay).length ? Math.round((totalSpend / Object.keys(byDay).length) * 100) / 100 : 0,
      byStore,
      byDay,
    });
  })
);

export default router;