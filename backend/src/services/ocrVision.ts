import { config } from "../config";
import { AppError } from "../utils/errors";

/**
 * In-app receipt OCR via OpenRouter vision (same model the n8n image workflow
 * uses). We call the vision step directly (per docs/n8n-ocr-webhook.md) so the
 * parsed receipt persists into the *logged-in user's* org — routing through the
 * n8n image webhook would land every upload in the hard-coded "n8n OCR Bot" org.
 */

export interface OcrItem {
  name: string;
  quantity?: number;
  price?: number;
}

export interface OcrReceipt {
  store_name?: string;
  date?: string; // "YYYY-MM-DD"
  time?: string;
  total?: number;
  subtotal?: number;
  tax?: number;
  payment_method?: string;
  items?: OcrItem[];
}

const SCHEMA_HINT = `{
  "store_name": "name or merchant on the receipt",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "total": 12.34,
  "subtotal": 10.00,
  "tax": 1.34,
  "payment_method": "VISA | Mastercard | Cash | ...",
  "items": [{"name":"Milk","quantity":2,"price":1.50}]
}`;

const SYSTEM_PROMPT = `You are an OCR engine for retail receipts. Extract the fields from the receipt image. Return ONLY valid JSON, no markdown, no commentary, exactly matching this schema:\n${SCHEMA_HINT}\n
Rules:
- If a field is not visible, omit it (do not guess) except items: always include every line item you can read.
- "total" is the final amount paid. "subtotal" before tax. "tax" the GST/VAT line.
- numeric fields must be plain numbers (no currency symbols, no commas).
- date always as YYYY-MM-DD, time as HH:MM (24h).
- If the image is not a receipt, return {"store_name":null} and nothing else.`;

/** Runs OCR on an image buffer via OpenRouter vision. Throws on failure. */
export async function ocrReceiptImage(buffer: Buffer, mime = "image/jpeg"): Promise<OcrReceipt> {
  if (!config.openRouterKey) {
    throw new AppError(503, "ocr_not_configured", "OPENROUTER_API_KEY not set on the server");
  }
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openRouterKey}`,
      "X-Title": "expense-tracker-inapp-ocr",
    },
    body: JSON.stringify({
      model: config.openRouterVisionModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the receipt fields from this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new AppError(502, "ocr_upstream_error", `Vision model error (${res.status})`, txt.slice(0, 500));
  }
  const json = await res.json() as { choices?: { message?: { content?: string } }[] };
  const raw = json.choices?.[0]?.message?.content || "";
  return parseOcrJson(raw, mime);
}

function parseOcrJson(raw: string, mime: string): OcrReceipt {
  let obj: Record<string, unknown>;
  try {
    // Strip any accidental markdown fences the model may wrap around the JSON.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    obj = JSON.parse(cleaned);
  } catch {
    // Fallback: keep the raw text as a stub so the receipt still persists.
    return { store_name: "OCR parse failed — see raw", items: [] };
  }
  const num = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  };
  const items = Array.isArray(obj.items)
    ? obj.items
        .map((it) => {
          const i = it as Record<string, unknown>;
          return {
            name: String(i.name ?? "").trim(),
            quantity: num(i.quantity),
            price: num(i.price),
          };
        })
        .filter((i) => i.name)
    : undefined;

  return {
    store_name: typeof obj.store_name === "string" && obj.store_name !== "null" ? obj.store_name : undefined,
    date: typeof obj.date === "string" ? obj.date : undefined,
    time: typeof obj.time === "string" ? obj.time : undefined,
    total: num(obj.total),
    subtotal: num(obj.subtotal),
    tax: num(obj.tax),
    payment_method: typeof obj.payment_method === "string" ? obj.payment_method : undefined,
    items: items?.length ? items : undefined,
  };
}