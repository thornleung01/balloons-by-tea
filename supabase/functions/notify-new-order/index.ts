// notify-new-order — Supabase Edge Function (Deno).
//
// Sends a "you've got a new order" email to the owner (Resend), optionally a
// short SMS (Twilio) and optionally a "we got your request" email to the
// customer. Set up and deployed as described in docs/admin-notifications.md.
//
// Who may call it (deploy with JWT verification OFF, this function does its
// own checks):
//   1. The database (pg_net trigger in supabase-migrations/20-notifications.sql,
//      or a Dashboard "Database Webhook") sending the header
//      `x-notify-secret: <NOTIFY_WEBHOOK_SECRET>`.
//   2. The logged-in admin from admin.html (Authorization: Bearer <their JWT>),
//      checked by calling public.is_admin() as that user. Admin calls can only
//      send a TEST notification (sample order) or read the setup status, so a
//      leaked admin session can't be used to email arbitrary customers.
//
// Request bodies accepted:
//   { type: "INSERT", table: "orders", record: {...} }  (trigger / webhook)
//   { action: "test" }                                   (admin only)
//   { action: "status" }                                 (admin only)
//
// Secrets (Supabase Dashboard -> Edge Functions -> Secrets):
//   RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM   required for email
//   NOTIFY_WEBHOOK_SECRET                                required for the trigger
//   ADMIN_URL                                            e.g. https://example.com/admin.html
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, NOTIFY_SMS_TO   optional SMS
//   NOTIFY_CUSTOMER=true                                 optional customer email
//   BUSINESS_NAME                                        optional, default "Balloons by Tea"
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

type Json = Record<string, unknown>;

interface OrderLine {
  name: string;
  qty: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  variant: string;
  addons: string;
}

interface NormalizedOrder {
  id: string;
  kind: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  eventWhen: string;
  fulfillment: string;
  items: OrderLine[];
  summary: string;
  total: string;
  notes: string;
  attachmentCount: number;
  source: string;
}

type SendResult = { status: "sent" | "skipped" | "failed"; detail?: string };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-notify-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FETCH_TIMEOUT_MS = 10_000;

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function str(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(n: number | null): string {
  return n === null ? "" : `$${n.toFixed(2)}`;
}

// Constant-time compare so the secret can't be guessed byte by byte.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/* ---------- Order normalization (works with or without the new columns) ---------- */

function addonsText(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((a) => (a && typeof a === "object" ? str((a as Json).name ?? (a as Json).label ?? JSON.stringify(a), 200) : str(a, 200)))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") return str(JSON.stringify(value), 500);
  return str(value, 500);
}

function normalizeItems(value: unknown): OrderLine[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((line): OrderLine[] => {
    if (!line || typeof line !== "object") return [];
    const l = line as Json;
    const variant = l.variant && typeof l.variant === "object" ? addonsText([l.variant]) : str(l.variant, 200);
    return [{
      name: str(l.name, 300) || "Item",
      qty: num(l.qty),
      unitPrice: num(l.unit_price),
      lineTotal: num(l.line_total),
      variant,
      addons: addonsText(l.addons),
    }];
  });
}

function normalizeOrder(r: Json): NormalizedOrder {
  const eventOn = str(r.event_on, 40);
  const eventTime = str(r.event_time, 60);
  const eventWhen = eventOn ? [eventOn, eventTime].filter(Boolean).join(" at ") : str(r.event_date, 100);
  const totalAmount = num(r.total_amount);
  const attachments = Array.isArray(r.attachments) ? r.attachments.length : 0;
  return {
    id: str(r.id, 60),
    kind: str(r.kind, 40) || "checkout",
    name: str(r.name, 200),
    phone: str(r.phone, 200),
    email: str(r.email, 200),
    address: str(r.address, 500),
    eventWhen,
    fulfillment: str(r.fulfillment, 40),
    items: normalizeItems(r.items),
    summary: str(r.summary, 10000),
    total: totalAmount !== null ? money(totalAmount) : str(r.total, 200),
    notes: str(r.notes, 8000),
    attachmentCount: attachments,
    source: str(r.source, 100),
  };
}

const SAMPLE_ORDER: Json = {
  id: "TEST",
  kind: "checkout",
  name: "Test Customer (sample)",
  phone: "+1 555 010 0000",
  email: "",
  address: "123 Sample Street",
  event_on: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  event_time: "2:00 PM",
  fulfillment: "delivery",
  items: [
    { name: "Organic Balloon Garland", qty: 1, unit_price: 180, line_total: 180, variant: "6 ft", addons: ["Gold accents"] },
    { name: "Number Balloon", qty: 2, unit_price: 25, line_total: 50 },
  ],
  total_amount: 230,
  notes: "This is a test notification sent from the admin page. No real order was placed.",
  attachments: ["sample-1.jpg"],
  source: "admin-test",
};

/* ---------- Email / SMS content ---------- */

function businessName(): string {
  return env("BUSINESS_NAME") || "Balloons by Tea";
}

function adminLink(): string {
  const base = env("ADMIN_URL");
  if (!base) return "";
  return base.split("#")[0] + "#orders";
}

function itemLineText(l: OrderLine): string {
  const parts = [`${l.qty ?? 1} x ${l.name}`];
  if (l.variant) parts.push(`(${l.variant})`);
  if (l.addons) parts.push(`+ ${l.addons}`);
  const price = money(l.lineTotal ?? (l.unitPrice !== null && l.qty !== null ? l.unitPrice * l.qty : null));
  return parts.join(" ") + (price ? ` - ${price}` : "");
}

function ownerSubject(o: NormalizedOrder, test: boolean): string {
  const kind = o.kind === "custom" ? "custom request" : "order";
  const who = o.name || "a customer";
  return `${test ? "[TEST] " : ""}New ${kind} from ${who}${o.eventWhen ? ` for ${o.eventWhen}` : ""}`.slice(0, 200);
}

function ownerText(o: NormalizedOrder, test: boolean): string {
  const lines: string[] = [];
  if (test) lines.push("TEST NOTIFICATION - no real order was placed.", "");
  lines.push(`New ${o.kind === "custom" ? "custom request" : "order"}${o.id ? ` #${o.id}` : ""}`, "");
  lines.push(`Customer: ${o.name || "-"}`);
  lines.push(`Phone: ${o.phone || "-"}`);
  lines.push(`Email: ${o.email || "-"}`);
  if (o.eventWhen) lines.push(`Event: ${o.eventWhen}`);
  if (o.fulfillment) lines.push(`Fulfillment: ${o.fulfillment}`);
  if (o.address) lines.push(`Address: ${o.address}`);
  lines.push("");
  if (o.items.length) {
    lines.push("Items:", ...o.items.map((l) => `  - ${itemLineText(l)}`));
  } else if (o.summary) {
    lines.push("Summary:", o.summary);
  }
  if (o.total) lines.push("", `Total: ${o.total}`);
  if (o.notes) lines.push("", "Notes:", o.notes);
  if (o.attachmentCount) lines.push("", `Photos attached: ${o.attachmentCount}`);
  const link = adminLink();
  if (link) lines.push("", `Open in admin: ${link}`);
  return lines.join("\n");
}

function row(label: string, valueHtml: string): string {
  return `<tr><td style="padding:6px 12px 6px 0;color:#8a7468;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px;color:#3d2b22">${valueHtml}</td></tr>`;
}

function multiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function ownerHtml(o: NormalizedOrder, test: boolean): string {
  const phoneHref = o.phone.replace(/[^\d+]/g, "");
  const rows = [
    row("Customer", escapeHtml(o.name || "-")),
    row("Phone", o.phone ? (phoneHref ? `<a href="tel:${escapeHtml(phoneHref)}" style="color:#d9776b">${escapeHtml(o.phone)}</a>` : escapeHtml(o.phone)) : "-"),
    row("Email", o.email ? `<a href="mailto:${escapeHtml(o.email)}" style="color:#d9776b">${escapeHtml(o.email)}</a>` : "-"),
  ];
  if (o.eventWhen) rows.push(row("Event", escapeHtml(o.eventWhen)));
  if (o.fulfillment) rows.push(row("Fulfillment", escapeHtml(o.fulfillment)));
  if (o.address) rows.push(row("Address", multiline(o.address)));
  if (o.total) rows.push(row("Total", `<strong>${escapeHtml(o.total)}</strong>`));
  if (o.attachmentCount) rows.push(row("Photos", `${o.attachmentCount} attached (view them in admin)`));

  let itemsHtml = "";
  if (o.items.length) {
    itemsHtml = `<h3 style="font-size:15px;margin:20px 0 8px;color:#3d2b22">Items</h3><ul style="margin:0;padding-left:20px;font-size:14px;color:#3d2b22;line-height:1.6">${
      o.items.map((l) => `<li>${escapeHtml(itemLineText(l))}</li>`).join("")
    }</ul>`;
  } else if (o.summary) {
    itemsHtml = `<h3 style="font-size:15px;margin:20px 0 8px;color:#3d2b22">Summary</h3><p style="margin:0;font-size:14px;color:#3d2b22;line-height:1.6">${multiline(o.summary)}</p>`;
  }
  const notesHtml = o.notes
    ? `<h3 style="font-size:15px;margin:20px 0 8px;color:#3d2b22">Notes</h3><p style="margin:0;font-size:14px;color:#3d2b22;line-height:1.6">${multiline(o.notes)}</p>`
    : "";
  const link = adminLink();
  const button = link
    ? `<p style="margin:28px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#d9776b;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;font-size:14px">Open in admin</a></p>`
    : "";
  const banner = test
    ? `<p style="margin:0 0 16px;padding:10px 14px;background:#fff4d6;border-radius:8px;font-size:13px;color:#6b5200">Test notification: no real order was placed.</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fbf6f2;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
${banner}<h2 style="margin:0 0 4px;font-size:20px;color:#3d2b22">New ${o.kind === "custom" ? "custom request" : "order"}${o.id ? ` #${escapeHtml(o.id)}` : ""}</h2>
<p style="margin:0 0 16px;font-size:13px;color:#8a7468">${escapeHtml(businessName())}</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows.join("")}</table>
${itemsHtml}${notesHtml}${button}
</div></body></html>`;
}

function smsText(o: NormalizedOrder, test: boolean): string {
  const bits = [
    `${test ? "[TEST] " : ""}New ${o.kind === "custom" ? "request" : "order"}: ${o.name || "customer"}`,
    o.phone,
    o.eventWhen ? `event ${o.eventWhen}` : "",
    o.total,
  ].filter(Boolean);
  const link = adminLink();
  return (bits.join(", ") + (link ? ` ${link}` : "")).slice(0, 300);
}

/* ---------- Customer confirmation (text editable via site_settings) ---------- */

const DEFAULT_CUSTOMER_SUBJECT = "We got your request - {business}";
const DEFAULT_CUSTOMER_BODY =
  "Hi {name},\n\nThank you for reaching out to {business}! We've received your request{event} and will be in touch shortly to confirm the details.\n\nTalk soon,\n{business}";

function fillTemplate(template: string, o: NormalizedOrder): string {
  return template
    .replaceAll("{name}", o.name || "there")
    .replaceAll("{business}", businessName())
    .replaceAll("{event}", o.eventWhen ? ` for ${o.eventWhen}` : "")
    .replaceAll("{event_date}", o.eventWhen || "");
}

async function readCustomerSettings(): Promise<{ subject: string; body: string }> {
  const out = { subject: DEFAULT_CUSTOMER_SUBJECT, body: DEFAULT_CUSTOMER_BODY };
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_ANON_KEY");
  if (!url || !key) return out;
  try {
    const client = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await client
      .from("site_settings")
      .select("key,value")
      .in("key", ["notify_customer_subject", "notify_customer_body"]);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as { key: string; value: string | null }[]) {
      const v = (r.value ?? "").trim();
      if (!v) continue;
      if (r.key === "notify_customer_subject") out.subject = v.slice(0, 200);
      if (r.key === "notify_customer_body") out.body = v.slice(0, 5000);
    }
  } catch (_e) {
    // Settings are optional; fall back to the defaults.
  }
  return out;
}

/* ---------- Senders ---------- */

async function readError(res: Response): Promise<string> {
  try {
    return `${res.status} ${(await res.text()).slice(0, 300)}`;
  } catch {
    return String(res.status);
  }
}

async function sendEmail(to: string[], subject: string, html: string, text: string, replyTo?: string): Promise<SendResult> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("NOTIFY_EMAIL_FROM");
  if (!apiKey || !from || !to.length) return { status: "skipped", detail: "Email secrets not set" };
  try {
    const body: Json = { from, to, subject, html, text };
    if (replyTo) body.reply_to = replyTo;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "failed", detail: `Resend: ${await readError(res)}` };
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", detail: `Resend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function smsConfigured(): boolean {
  return Boolean(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("TWILIO_FROM") && env("NOTIFY_SMS_TO"));
}

async function sendSms(text: string): Promise<SendResult> {
  if (!smsConfigured()) return { status: "skipped", detail: "SMS secrets not set" };
  const sid = env("TWILIO_ACCOUNT_SID");
  const results: string[] = [];
  let anyOk = false;
  for (const to of env("NOTIFY_SMS_TO").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${env("TWILIO_AUTH_TOKEN")}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: env("TWILIO_FROM"), Body: text }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) anyOk = true;
      else results.push(`Twilio (${to}): ${await readError(res)}`);
    } catch (e) {
      results.push(`Twilio (${to}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (results.length) return { status: anyOk ? "sent" : "failed", detail: results.join("; ") };
  return { status: "sent" };
}

function emailList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}

/* ---------- Main ---------- */

async function notify(record: Json, test: boolean): Promise<Response> {
  const order = normalizeOrder(record);
  const ownerTo = emailList(env("NOTIFY_EMAIL_TO"));

  const owner = ownerTo.length
    ? await sendEmail(ownerTo, ownerSubject(order, test), ownerHtml(order, test), ownerText(order, test), looksLikeEmail(order.email) ? order.email : undefined)
    : { status: "skipped", detail: "NOTIFY_EMAIL_TO not set" } as SendResult;

  const sms = await sendSms(smsText(order, test));

  let customer: SendResult = { status: "skipped", detail: "NOTIFY_CUSTOMER is not true" };
  if (env("NOTIFY_CUSTOMER").toLowerCase() === "true") {
    // A test sends the customer email to the owner so they can preview it.
    const to = test ? ownerTo : (looksLikeEmail(order.email) ? [order.email] : []);
    if (!to.length) {
      customer = { status: "skipped", detail: "Order has no valid email" };
    } else {
      const tpl = await readCustomerSettings();
      const subject = (test ? "[TEST preview] " : "") + fillTemplate(tpl.subject, order);
      const text = fillTemplate(tpl.body, order);
      const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fbf6f2;font-family:Helvetica,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;font-size:15px;line-height:1.6;color:#3d2b22">${multiline(text)}</div></body></html>`;
      customer = await sendEmail(to, subject, html, text, ownerTo[0]);
    }
  }

  const anySent = [owner, sms, customer].some((r) => r.status === "sent");
  const anyFailed = [owner, sms, customer].some((r) => r.status === "failed");
  const status = anyFailed && !anySent ? 502 : !anySent ? 503 : 200;
  return json(status, { ok: status === 200, test, results: { owner, sms, customer } });
}

function setupStatus(): Json {
  return {
    ok: true,
    email: Boolean(env("RESEND_API_KEY") && env("NOTIFY_EMAIL_FROM") && emailList(env("NOTIFY_EMAIL_TO")).length),
    sms: smsConfigured(),
    customer: env("NOTIFY_CUSTOMER").toLowerCase() === "true",
    webhookSecret: Boolean(env("NOTIFY_WEBHOOK_SECRET")),
    adminUrl: Boolean(env("ADMIN_URL")),
  };
}

// apiKeyHeader: the public (anon/publishable) key the browser sent, used if
// the SUPABASE_ANON_KEY env var isn't provided on this project.
async function callerIsAdmin(authHeader: string, apiKeyHeader: string): Promise<boolean> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_ANON_KEY") || apiKeyHeader.trim();
  if (!url || !key || !/^Bearer\s+\S+/i.test(authHeader)) return false;
  try {
    const client = createClient(url, key, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("is_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json(405, { ok: false, error: "Use POST" });

  let body: Json;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Json;
  } catch {
    return json(400, { ok: false, error: "Body must be a JSON object" });
  }

  const secret = env("NOTIFY_WEBHOOK_SECRET");
  const sentSecret = req.headers.get("x-notify-secret") ?? "";
  const viaSecret = Boolean(secret && sentSecret && safeEqual(sentSecret, secret));

  if (!viaSecret) {
    const isAdmin = await callerIsAdmin(req.headers.get("Authorization") ?? "", req.headers.get("apikey") ?? "");
    if (!isAdmin) return json(401, { ok: false, error: "Not authorized" });
    if (body.action === "status") return json(200, setupStatus());
    if (body.action === "test") return await notify(SAMPLE_ORDER, true);
    return json(400, { ok: false, error: "Admins can only send { action: \"test\" } or { action: \"status\" }" });
  }

  if (body.action === "status") return json(200, setupStatus());
  if (body.action === "test") return await notify(SAMPLE_ORDER, true);

  // Database Webhook / pg_net trigger payload.
  if (body.type !== undefined && body.type !== "INSERT") return json(200, { ok: true, skipped: "not an INSERT" });
  if (body.table !== undefined && body.table !== "orders") return json(200, { ok: true, skipped: "not the orders table" });
  const record = body.record ?? body.order;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return json(400, { ok: false, error: "Missing record" });
  }
  return await notify(record as Json, false);
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    return await handle(req);
  } catch (e) {
    console.error("notify-new-order failed", e);
    return json(500, { ok: false, error: "Internal error" });
  }
});
