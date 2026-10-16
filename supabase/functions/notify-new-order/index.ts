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

/* ---------- HTML email (inline CSS only, table layout, 600px) ----------
   Brand colours: cream page #FFF5E3, white card, coral #FF7F7F used for the button with a
   dark brown label (never white on coral), brown text #4A3028. Every cell that sits on a
   colour sets BOTH the bgcolor attribute and a background-color style, and every text
   element sets its own colour, so Gmail's dark-mode inversion cannot leave dark text on a
   dark fill. `color-scheme: light dark` plus a prefers-color-scheme block gives Apple Mail
   a proper dark version; the inline light colours are what every other client shows. */

const EM = {
  page: "#FFF5E3",
  card: "#FFFFFF",
  well: "#FFF5E3",
  line: "#EAD9C8",
  text: "#4A3028",
  soft: "#6F564B",
  link: "#B34848",
  coral: "#FF7F7F",
  warnBg: "#FFF4D6",
  warnText: "#6B5200",
};
const EM_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function multiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/* One label/value row of the key facts table. */
function row(label: string, valueHtml: string): string {
  return `<tr><td class="em-soft em-label" valign="top" width="112" style="padding:8px 12px 8px 0;border-top:1px solid ${EM.line};font-family:${EM_FONT};font-size:13px;line-height:20px;color:${EM.soft}">${escapeHtml(label)}</td><td class="em-text" valign="top" style="padding:8px 0;border-top:1px solid ${EM.line};font-family:${EM_FONT};font-size:15px;line-height:20px;color:${EM.text}">${valueHtml}</td></tr>`;
}

function emLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" class="em-link" style="color:${EM.link};text-decoration:underline">${escapeHtml(label)}</a>`;
}

function emHeading(text: string): string {
  return `<p class="em-text" style="margin:28px 0 8px;font-family:${EM_FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EM.soft}">${escapeHtml(text)}</p>`;
}

/* The shared page: cream background, business name on top, white card, small print. */
function emailShell(opts: { title: string; preheader: string; inner: string; footer: string }): string {
  const business = escapeHtml(businessName());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
a { color: ${EM.link}; }
@media (max-width: 620px) {
  .em-wrap { width: 100% !important; }
  .em-pad { padding: 20px 16px !important; }
  .em-title { font-size: 24px !important; line-height: 30px !important; }
  .em-btn a { display: block !important; }
  .em-label { width: 96px !important; }
}
@media (prefers-color-scheme: dark) {
  .em-bg { background-color: #171210 !important; }
  .em-card { background-color: #262019 !important; border-color: #3B3129 !important; }
  .em-well { background-color: #1E1814 !important; }
  .em-warn { background-color: #382E14 !important; }
  .em-warn-text { color: #F2CB6B !important; }
  .em-text { color: #F2E8DE !important; border-color: #3B3129 !important; }
  .em-soft { color: #CDBEB2 !important; border-color: #3B3129 !important; }
  .em-link, a { color: #FFA39C !important; }
  .em-btn-cell { background-color: #FF8F88 !important; }
  .em-btn-cell a { color: #2B1812 !important; }
}
</style>
</head>
<body class="em-bg" bgcolor="${EM.page}" style="margin:0;padding:0;background-color:${EM.page}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${EM.page}">${escapeHtml(opts.preheader)}</div>
<table role="presentation" class="em-bg" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${EM.page}" style="background-color:${EM.page}">
<tr><td align="center" class="em-bg" bgcolor="${EM.page}" style="padding:24px 12px;background-color:${EM.page}">
<table role="presentation" class="em-wrap" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px">
<tr><td class="em-bg em-text" bgcolor="${EM.page}" style="padding:0 4px 14px;background-color:${EM.page};font-family:${EM_FONT};font-size:16px;line-height:22px;font-weight:700;color:${EM.text}">${business}</td></tr>
<tr><td class="em-card em-pad" bgcolor="${EM.card}" style="padding:28px;background-color:${EM.card};border:1px solid ${EM.line};border-radius:14px">
${opts.inner}
</td></tr>
<tr><td class="em-bg em-soft" bgcolor="${EM.page}" style="padding:16px 4px 0;background-color:${EM.page};font-family:${EM_FONT};font-size:12px;line-height:18px;color:${EM.soft}">${opts.footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function emButton(href: string, label: string): string {
  return `<table role="presentation" class="em-btn" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0"><tr><td class="em-btn-cell" bgcolor="${EM.coral}" style="background-color:${EM.coral};border-radius:999px"><a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;font-family:${EM_FONT};font-size:15px;line-height:20px;font-weight:700;color:${EM.text};text-decoration:none;text-align:center">${escapeHtml(label)}</a></td></tr></table>`;
}

function itemRowHtml(l: OrderLine): string {
  const price = money(l.lineTotal ?? (l.unitPrice !== null && l.qty !== null ? l.unitPrice * l.qty : null));
  const sub = [l.variant, l.addons ? `+ ${l.addons}` : ""].filter(Boolean).join(" ");
  return `<tr><td class="em-text" valign="top" style="padding:10px 12px 10px 0;border-top:1px solid ${EM.line};font-family:${EM_FONT};font-size:15px;line-height:20px;color:${EM.text}">${escapeHtml(`${l.qty ?? 1} x ${l.name}`)}${sub ? `<br><span class="em-soft" style="font-size:13px;color:${EM.soft}">${escapeHtml(sub)}</span>` : ""}</td><td class="em-text" align="right" valign="top" style="padding:10px 0;border-top:1px solid ${EM.line};font-family:${EM_FONT};font-size:15px;line-height:20px;color:${EM.text};white-space:nowrap">${price ? escapeHtml(price) : ""}</td></tr>`;
}

export function ownerHtml(o: NormalizedOrder, test: boolean): string {
  const phoneHref = o.phone.replace(/[^\d+]/g, "");
  const kindWord = o.kind === "custom" ? "custom request" : "order";
  const facts = [
    o.eventWhen ? row("Event", escapeHtml(o.eventWhen)) : "",
    o.fulfillment ? row("Fulfillment", escapeHtml(o.fulfillment)) : "",
    o.total ? row("Total", `<strong style="font-size:17px">${escapeHtml(o.total)}</strong>`) : "",
    row("Phone", o.phone ? (phoneHref ? emLink(`tel:${phoneHref}`, o.phone) : escapeHtml(o.phone)) : "-"),
    row("Email", o.email ? emLink(`mailto:${o.email}`, o.email) : "-"),
    o.address ? row("Address", multiline(o.address)) : "",
  ].join("");

  let items = "";
  if (o.items.length) {
    items = `${emHeading("Items")}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${o.items.map(itemRowHtml).join("")}</table>`;
  } else if (o.summary) {
    items = `${emHeading("Summary")}<p class="em-text" style="margin:0;font-family:${EM_FONT};font-size:15px;line-height:22px;color:${EM.text}">${multiline(o.summary)}</p>`;
  }
  const notes = o.notes
    ? `${emHeading("Notes from the customer")}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="em-well em-text" bgcolor="${EM.well}" style="padding:14px 16px;background-color:${EM.well};border-left:4px solid ${EM.coral};border-radius:8px;font-family:${EM_FONT};font-size:15px;line-height:22px;color:${EM.text}">${multiline(o.notes)}</td></tr></table>`
    : "";
  const photos = o.attachmentCount
    ? `<p class="em-soft" style="margin:16px 0 0;font-family:${EM_FONT};font-size:14px;line-height:20px;color:${EM.soft}">${o.attachmentCount} photo${o.attachmentCount === 1 ? "" : "s"} attached. View ${o.attachmentCount === 1 ? "it" : "them"} in admin.</p>`
    : "";
  const link = adminLink();
  const banner = test
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px"><tr><td class="em-warn em-warn-text" bgcolor="${EM.warnBg}" style="padding:10px 14px;background-color:${EM.warnBg};border-radius:8px;font-family:${EM_FONT};font-size:13px;line-height:18px;color:${EM.warnText}">Test notification: no real order was placed.</td></tr></table>`
    : "";
  const who = o.name || "a customer";
  const inner = `${banner}<p class="em-soft" style="margin:0 0 6px;font-family:${EM_FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EM.soft}">New ${kindWord}${o.id ? ` #${escapeHtml(o.id)}` : ""}</p>
<h1 class="em-text em-title" style="margin:0 0 20px;font-family:${EM_FONT};font-size:28px;line-height:34px;font-weight:700;color:${EM.text}">New ${kindWord} from ${escapeHtml(who)}</h1>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${facts}</table>
${items}${notes}${photos}${link ? emButton(link, "Open in admin") : ""}`;
  return emailShell({
    title: `New ${kindWord} from ${who}`,
    preheader: [o.eventWhen, o.total, o.phone].filter(Boolean).join(" | ") || `New ${kindWord}`,
    inner,
    footer: `You get this email because new orders at ${escapeHtml(businessName())} are sent to this address. Change who is notified in the admin under Settings, Notifications.`,
  });
}

/* Customer confirmation: the owner's own wording, in the same shell. */
export function customerHtml(text: string): string {
  const inner = `<p class="em-text" style="margin:0;font-family:${EM_FONT};font-size:16px;line-height:26px;color:${EM.text}">${multiline(text)}</p>`;
  return emailShell({
    title: businessName(),
    preheader: text.replace(/\s+/g, " ").slice(0, 90),
    inner,
    footer: `Sent by ${escapeHtml(businessName())}. Reply to this email to reach us.`,
  });
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
      const html = customerHtml(text);
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
