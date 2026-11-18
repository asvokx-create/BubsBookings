import "server-only";

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { database } from "./database";
import { safeHttpUrl } from "./safe-url";

type EmailInput = {
  to: string;
  subject: string;
  heading: string;
  message: string;
  sections?: Array<{ heading: string; message: string }>;
  tips?: string[];
  actionLabel?: string;
  actionUrl?: string;
  actions?: Array<{ label: string; url: string }>;
  userId?: string;
  bookingId?: string;
  emailType: string;
  renderVersion?: "stacked-actions-v1";
  idempotencyKey?: string;
};

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
export const ACCOUNT_VERIFICATION_COOLDOWN_MS = 15 * 60 * 1000;

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export function verificationEmailIdempotencyKey(email: string, now = Date.now()) {
  const recipientHash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
  return `account-verification-${recipientHash}-${Math.floor(now / ACCOUNT_VERIFICATION_COOLDOWN_MS)}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function absoluteUrl(value: string) {
  return safeHttpUrl(value, appUrl, appUrl) ?? appUrl;
}

async function recordDelivery(input: EmailInput, status: "sent" | "skipped" | "failed", providerMessageId = "", errorMessage = "") {
  try {
    await database.query(
      `INSERT INTO email_delivery_log (user_id, booking_id, email_type, recipient, provider_message_id, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.userId ?? null, input.bookingId ?? null, input.emailType, input.to, providerMessageId || null, status, errorMessage.slice(0, 500)],
    );
  } catch (error) {
    console.warn("Email delivery could not be recorded", error);
  }
}

export async function sendTransactionalEmail(input: EmailInput) {
  if (!isEmailConfigured()) {
    await recordDelivery(input, "skipped", "", "Email provider is not configured.");
    return { sent: false, skipped: true, providerMessageId: "", error: "Email provider is not configured." };
  }

  const actions = input.actions?.length
    ? input.actions.slice(0, 3).map((action) => ({ label: action.label, url: absoluteUrl(action.url) }))
    : input.actionUrl ? [{ label: input.actionLabel ?? "Open BubsBookings", url: absoluteUrl(input.actionUrl) }] : [];
  const idempotencyKey = (input.idempotencyKey
    ?? (input.bookingId && input.userId ? [input.emailType, input.bookingId, input.userId].join("-") : ""))
    .slice(0, 250);
  const tipsHtml = input.tips?.length
    ? `<div style="margin:24px 0 0;background:#f4f6ef;border-radius:18px;padding:18px 20px"><p style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px">Tips for a strong start</p><ul style="color:#4f6257;font-size:15px;line-height:1.55;margin:0;padding-left:20px">${input.tips.map((tip) => `<li style="margin:0 0 9px">${escapeHtml(tip)}</li>`).join("")}</ul></div>`
    : "";
  const sectionsHtml = input.sections?.map((section) => `<div style="margin:24px 0 0;background:#fff9d9;border:1px solid #e5d970;border-radius:18px;padding:18px 20px"><h2 style="font-size:18px;line-height:1.3;margin:0 0 8px">${escapeHtml(section.heading)}</h2><p style="font-size:15px;line-height:1.6;color:#5f7067;margin:0">${escapeHtml(section.message)}</p></div>`).join("") ?? "";
  const legacyActionsHtml = actions.length ? `<div style="margin:28px 0 0">${actions.map((action, index) => `<a href="${escapeHtml(action.url)}" style="display:inline-block;margin:${index ? "10px 10px 0 0" : "0 10px 0 0"};background:${index ? "#183126" : "#eee25a"};color:${index ? "#fff" : "#183126"};text-decoration:none;font-weight:700;padding:14px 22px;border-radius:999px">${escapeHtml(action.label)}</a>`).join("")}</div>` : "";
  // Separate table rows survive mail clients that strip anchor margins/styles.
  const stackedActionsHtml = actions.length ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0;width:100%"><tbody>${actions.map((action, index) => `<tr><td style="padding:0 0 12px"><a href="${escapeHtml(action.url)}" style="display:inline-block;max-width:100%;box-sizing:border-box;line-height:1.5;overflow-wrap:anywhere;background:${index ? "#183126" : "#eee25a"};color:${index ? "#fff" : "#183126"};text-decoration:none;font-weight:700;padding:14px 22px;border-radius:999px">${escapeHtml(action.label)}</a></td></tr>`).join("\n")}</tbody></table>` : "";
  const actionsHtml = input.renderVersion === "stacked-actions-v1" ? stackedActionsHtml : legacyActionsHtml;
  const text = input.renderVersion === "stacked-actions-v1" ? [input.heading, input.message,
    ...(input.sections ?? []).map(section => `${section.heading}\n${section.message}`),
    ...(input.tips ?? []).map(tip => `- ${tip}`),
    ...actions.map(action => `${action.label}:\n${action.url}`),
    "BubsBookings will never ask for your password by email."].join("\n\n") : undefined;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4ef;font-family:Arial,sans-serif;color:#183126"><div style="max-width:600px;margin:0 auto;padding:32px 18px"><div style="background:#fff;border:1px solid #dfe5df;border-radius:24px;padding:32px"><p style="font-weight:700;font-size:20px;margin:0 0 28px">BubsBookings</p><h1 style="font-size:28px;line-height:1.15;margin:0 0 16px">${escapeHtml(input.heading)}</h1><p style="font-size:16px;line-height:1.65;color:#5f7067;margin:0;white-space:pre-line">${escapeHtml(input.message)}</p>${sectionsHtml}${tipsHtml}${actionsHtml}<p style="font-size:12px;line-height:1.5;color:#829087;margin:30px 0 0">BubsBookings will never ask for your password by email.</p></div></div></body></html>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [input.to], subject: input.subject, html, ...(text !== undefined ? { text } : {}) }),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok) throw new Error(result.message ?? `Email provider returned ${response.status}.`);
    await recordDelivery(input, "sent", result.id ?? "");
    return { sent: true, skipped: false, providerMessageId: result.id ?? "", error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email error";
    await recordDelivery(input, "failed", "", message);
    console.error("Transactional email failed", { type: input.emailType, message });
    return { sent: false, skipped: false, providerMessageId: "", error: message };
  }
}

async function sendVerificationEmailWithCooldown(input: { to: string; name?: string; url: string }) {
  const recipient = input.to.trim().toLowerCase();
  if (!recipient) return { sent: false, skipped: true, cooldown: false };

  const lockKey = `account-verification:${recipient}`;
  let client: PoolClient | null = null;
  let lockHeld = false;
  try {
    client = await database.connect();
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [lockKey],
    );
    lockHeld = Boolean(lock.rows[0]?.locked);
    if (!lockHeld) {
      await recordDelivery({ to: recipient, emailType: "account_verification", subject: "", heading: "", message: "" }, "skipped", "", "A verification email is already being prepared.");
      return { sent: false, skipped: true, cooldown: true };
    }

    const recent = await client.query<{ created_at: Date }>(
      `SELECT created_at
       FROM email_delivery_log
       WHERE email_type = 'account_verification'
         AND lower(recipient) = $1
         AND status = 'sent'
         AND created_at > now() - interval '15 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [recipient],
    );
    if (recent.rows[0]) {
      await recordDelivery({ to: recipient, emailType: "account_verification", subject: "", heading: "", message: "" }, "skipped", "", "Verification email cooldown is active.");
      return { sent: false, skipped: true, cooldown: true };
    }

    const result = await sendTransactionalEmail({
      to: recipient,
      subject: "Verify your BubsBookings email",
      heading: "Verify your email address",
      message: `Hi ${input.name || "there"}, confirm this email address to finish securing your BubsBookings account.`,
      actionLabel: "Verify email",
      actionUrl: input.url,
      emailType: "account_verification",
      idempotencyKey: verificationEmailIdempotencyKey(recipient),
    });
    return { ...result, cooldown: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown verification email error";
    await recordDelivery({ to: recipient, emailType: "account_verification", subject: "", heading: "", message: "" }, "failed", "", message);
    console.error("Verification email delivery failed", { message });
    return { sent: false, skipped: false, cooldown: false };
  } finally {
    if (client && lockHeld) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    }
    client?.release();
  }
}

export async function sendAuthEmail(input: { to: string; name?: string; url: string; kind: "verify" | "reset" }) {
  const verification = input.kind === "verify";
  if (verification) return sendVerificationEmailWithCooldown(input);
  return sendTransactionalEmail({
    to: input.to,
    subject: "Reset your BubsBookings password",
    heading: "Reset your password",
    message: `Hi ${input.name || "there"}, use the secure link below to choose a new BubsBookings password. If you did not request this, you can ignore this email.`,
    actionLabel: "Reset password",
    actionUrl: input.url,
    emailType: "password_reset",
  });
}
