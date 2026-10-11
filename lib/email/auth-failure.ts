// Telling "the mail server refused these credentials" from every other way a connection
// can fail. Kept free of imports: the sender and the mail queue both ask.

/**
 * Whether an SMTP error means the server refused the sign-in, as against a network failure
 * or a refusal that passes on its own (a 4xx, such as Gmail's temporary 454).
 */
export function isSmtpAuthFailure(error: unknown): boolean {
  const e = error as { code?: string; responseCode?: number } | null;
  if (!e || e.code !== "EAUTH") return false;
  return e.responseCode === undefined || e.responseCode >= 500;
}

/** Whether an IMAP error means the server refused the sign-in (node-imap marks those). */
export function isImapAuthFailure(error: unknown): boolean {
  const e = error as { source?: string; textCode?: string } | null;
  return Boolean(e) && (e!.source === "authentication" || e!.textCode === "AUTHENTICATIONFAILED");
}

/** What is said when an IMAP server is given as an IP address: Node refuses to open a secure connection to one by number. */
export const IP_ADDRESS_HOST = "Enter the IMAP server's name, not its IP address. A secure connection is checked against the server's name.";
