/**
 * A mail server on this machine for trying mailboxes without a real one: it takes mail
 * over SMTP and lets the same mail be read back over IMAP. Nothing it is given leaves the
 * machine. It is the server the mailbox tests use (tests/helpers/mail-server.ts).
 *
 *   npx tsx scripts/dev-mail-server.ts
 *   MAIL_USERS="ada@one.test:secret,seed@one.test:secret" npx tsx scripts/dev-mail-server.ts
 *
 * Then connect a mailbox in Linki with SMTP and IMAP:
 *   SMTP server localhost, port 2525, STARTTLS · IMAP server localhost, port 9993
 *   "Accept a self-signed certificate" switched on · the address and password of a user below
 *
 * Mail whose subject contains "spam" is filed in Spam, so both outcomes of a test send can
 * be seen. Needs the openssl program (for the IMAP server's throwaway certificate).
 */
import { startMailServer } from "../tests/helpers/mail-server";

const DEFAULT_USERS = "ada@linki-local.test:local-test,seed@linki-local.test:local-test";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("dev-mail-server does not run in production.");
  const server = await startMailServer({
    smtpPort: Number(process.env.MAIL_SMTP_PORT) || 2525,
    imapPort: Number(process.env.MAIL_IMAP_PORT) || 9993,
    route: (message) => (/spam/i.test(message.subject ?? "") ? "Spam" : "INBOX"),
  });
  const users = (process.env.MAIL_USERS || DEFAULT_USERS).split(",").map((pair) => pair.trim().split(":")).filter((pair) => pair.length === 2);
  for (const [address, password] of users) server.addUser(address, password);
  console.log(`SMTP on localhost:${server.smtpPort} (STARTTLS setting, no encryption offered) · IMAP on localhost:${server.imapPort} (TLS, self-signed)`);
  console.log(`Users: ${users.map(([address]) => address).join(", ")}`);
  let seen = 0;
  setInterval(() => {
    for (const message of server.received.slice(seen)) console.log(`  ${message.from} → ${message.to} [${message.folder}] ${message.subject ?? ""}`);
    seen = server.received.length;
  }, 1000);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
