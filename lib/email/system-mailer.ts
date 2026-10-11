import nodemailer from "nodemailer";

// Mail the instance itself sends: password resets and signup confirmation. It has its own
// SMTP settings (SYSTEM_SMTP_*) rather than borrowing a campaign mailbox, because someone
// who has just signed up, or cannot sign in, has no workspace mailbox to send through.
// Without these settings the instance simply does not send account mail: there is no
// password reset by email, and new signups are not asked to confirm their address.

type Env = Record<string, string | undefined>;

export function systemMailerConfigured(env: Env = process.env): boolean {
  return Boolean(env.SYSTEM_SMTP_HOST?.trim() && env.SYSTEM_SMTP_FROM?.trim());
}

export async function sendSystemEmail(message: { to: string; subject: string; text: string }): Promise<void> {
  const env = process.env;
  if (!systemMailerConfigured(env)) throw new Error("System mail is not configured (SYSTEM_SMTP_HOST, SYSTEM_SMTP_FROM)");
  const port = Number(env.SYSTEM_SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: env.SYSTEM_SMTP_HOST,
    port,
    // Port 465 is SSL from the first byte; anything else upgrades with STARTTLS.
    secure: env.SYSTEM_SMTP_SECURE ? env.SYSTEM_SMTP_SECURE === "true" : port === 465,
    auth: env.SYSTEM_SMTP_USER ? { user: env.SYSTEM_SMTP_USER, pass: env.SYSTEM_SMTP_PASSWORD ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from: env.SYSTEM_SMTP_FROM, to: message.to, subject: message.subject, text: message.text });
}
