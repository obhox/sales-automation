import nodemailer from "nodemailer";
import Imap from "imap";

export interface EmailAccount {
  id: string;
  from_email: string;
  from_name: string | null;
  reply_to?: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0 = STARTTLS, 1 = SSL
  username: string;
  password: string;
  allow_self_signed?: number;
}

export interface SendReceipt { messageId: string; providerMessageId?: string; response?: string; accepted?: string[]; rejected?: string[] }

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string,
  options: { messageId?: string; headers?: Record<string,string>; html?: string } = {},
): Promise<SendReceipt> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.username,
      pass: account.password,
    },
    // Secure by default. Self-signed SMTP is an explicit per-mailbox opt-in.
    tls: { rejectUnauthorized: account.allow_self_signed !== 1 },
  });

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;

  const info = await transporter.sendMail({
    from, to, subject, text: body,
    ...(options.html ? { html: options.html } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });
  return { messageId: info.messageId, response: info.response, accepted: info.accepted?.map(String), rejected: info.rejected?.map(String) };
}

/**
 * Verifies SMTP connectivity — used by the test-connection endpoint.
 * Returns null on success, error message string on failure.
 */
export async function testSmtpConnection(account: Omit<EmailAccount, "id">): Promise<string | null> {
  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_secure === 1,
      auth: { user: account.username, pass: account.password },
      tls: { rejectUnauthorized: account.allow_self_signed !== 1 },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    await transporter.verify();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ImapTestAccount {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
  allow_self_signed?: number;
}

/**
 * Verifies IMAP connectivity — connects, authenticates, then disconnects.
 * Returns null on success, error message string on failure.
 */
export async function testImapConnection(account: ImapTestAccount): Promise<string | null> {
  return new Promise((resolve) => {
    const imap = new Imap({
      host: account.imap_host,
      port: account.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: account.allow_self_signed !== 1 },
      user: account.imap_username ?? account.username,
      password: account.imap_password ?? account.password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    imap.once("ready", () => {
      try { imap.end(); } catch { /* ignore */ }
      resolve(null);
    });

    imap.once("error", (err: Error) => {
      resolve(err.message ?? String(err));
    });

    imap.connect();
  });
}
