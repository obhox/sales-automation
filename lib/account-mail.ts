import type { NextApiRequest } from "next";
import { issueAuthToken } from "@/lib/auth-tokens";
import { sendSystemEmail } from "@/lib/email/system-mailer";
import { requestOrigin } from "@/lib/mcp/auth";

// The two messages an account can be sent. Both go out in the background and failures are
// only logged: the caller answers the same way whether or not the address has an account,
// and must not take longer when it does.

export function sendPasswordResetEmail(req: NextApiRequest, user: { id: string; email: string }): void {
  const url = `${requestOrigin(req)}/reset-password?token=${encodeURIComponent(issueAuthToken(user.id, "password_reset"))}`;
  deliver(user.email, "Reset your Linki password",
    `Someone asked to reset the password for this Linki account. Open the link below to choose a new one. It works once and expires in an hour.\n\n${url}\n\nIf that wasn't you, ignore this email and your password stays as it is.`);
}

export function sendVerificationEmail(req: NextApiRequest, user: { id: string; email: string }): void {
  const url = `${requestOrigin(req)}/verify-email?token=${encodeURIComponent(issueAuthToken(user.id, "email_verify"))}`;
  deliver(user.email, "Confirm your email for Linki",
    `Confirm this address to finish creating your Linki account. The link expires in 48 hours.\n\n${url}\n\nIf you didn't sign up, ignore this email.`);
}

function deliver(to: string, subject: string, text: string): void {
  sendSystemEmail({ to, subject, text }).catch((error) => {
    console.warn(`[account-mail] could not send "${subject}":`, error instanceof Error ? error.message : error);
  });
}
