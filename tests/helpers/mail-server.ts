// A mail host that lives in memory, for tests and for trying mailbox screens locally:
// an SMTP server that takes mail, and an IMAP server (over TLS, with a certificate made
// on the spot) that the same mail can be read back from. It speaks only as much of each
// protocol as Linki uses. Nothing it is given ever leaves the machine.
//
//   const server = await startMailServer();
//   server.addUser("a@one.test", "secret");
//   ... point a mailbox at localhost:server.smtpPort / server.imapPort, allow_self_signed = 1 ...
//   await server.stop();
import { execFileSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import tls from "tls";

export interface StoredMessage {
  uid: number;
  folder: string;
  from: string;
  to: string;
  /** The message as it would sit in the mailbox: the headers the server added, then what was sent. */
  raw: string;
  messageId: string | null;
  subject: string | null;
}

export interface MailServerOptions {
  smtpPort?: number;
  imapPort?: number;
  /** Folders every mailbox has besides INBOX. Default: Spam (marked \Junk) and Sent. */
  folders?: Array<{ name: string; attribs?: string[] }>;
  /** Which folder a delivered message goes to. Default: INBOX. */
  route?: (message: { from: string; to: string; raw: string; subject: string | null }) => string;
  /** The Authentication-Results the server writes on mail it takes. Null: none. */
  authResults?: string | null;
  /** Behave like Gmail for reading: announce X-GM-EXT-1 and answer category searches from `gmailTab`. */
  gmail?: boolean;
  gmailTab?: (message: StoredMessage) => string | null;
}

export interface MailServer {
  host: "localhost";
  smtpPort: number;
  imapPort: number;
  addUser(address: string, password: string): void;
  /** Change a user's password, as when one is revoked at the provider. */
  setPassword(address: string, password: string): void;
  /** Everything delivered to an address, in every folder. */
  mailbox(address: string): StoredMessage[];
  /** Every message taken by the SMTP server, in order. */
  received: StoredMessage[];
  stop(): Promise<void>;
}

let certificate: { key: string; cert: string } | null = null;

/** A throwaway certificate for localhost. Needs the openssl program. */
export function localCertificate(): { key: string; cert: string } {
  if (certificate) return certificate;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-mail-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "3", "-subj", "/CN=localhost"], { stdio: "ignore" });
  certificate = { key: fs.readFileSync(key, "utf8"), cert: fs.readFileSync(cert, "utf8") };
  fs.rmSync(dir, { recursive: true, force: true });
  return certificate;
}

export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const header = (raw: string, name: string): string | null => {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  return new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1]?.trim() ?? null;
};

const DEFAULT_FOLDERS = [{ name: "Spam", attribs: ["\\Junk"] }, { name: "Sent", attribs: ["\\Sent"] }];
const DEFAULT_AUTH = "mx.localhost; spf=pass smtp.mailfrom=sender; dkim=pass header.d=sender; dmarc=pass header.from=sender";

export async function startMailServer(options: MailServerOptions = {}): Promise<MailServer> {
  const users = new Map<string, string>();
  const stores = new Map<string, StoredMessage[]>();
  const received: StoredMessage[] = [];
  const folders = [{ name: "INBOX", attribs: [] as string[] }, ...(options.folders ?? DEFAULT_FOLDERS).map((folder) => ({ name: folder.name, attribs: folder.attribs ?? [] }))];
  const authResults = options.authResults === undefined ? DEFAULT_AUTH : options.authResults;
  const sockets = new Set<net.Socket>();
  let nextUid = 1;

  const deliver = (from: string, to: string, data: string) => {
    const subject = header(data, "Subject");
    const raw = `${authResults ? `Authentication-Results: ${authResults}\r\n` : ""}Delivered-To: ${to}\r\n${data}`;
    const folder = options.route?.({ from, to, raw, subject }) ?? "INBOX";
    const message: StoredMessage = { uid: nextUid++, folder, from, to, raw, messageId: header(data, "Message-ID"), subject };
    received.push(message);
    const key = to.toLowerCase();
    stores.set(key, [...(stores.get(key) ?? []), message]);
  };

  // ── SMTP ────────────────────────────────────────────────────────────────────
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the client went away */ });
    socket.setEncoding("utf8");
    let buffer = "";
    let from = "";
    let recipients: string[] = [];
    let inData = false;
    let authed = false;
    let awaiting: null | "plain" | "login-user" | "login-pass" = null;
    let loginUser = "";
    const say = (line: string) => socket.write(`${line}\r\n`);
    const check = (user: string, pass: string) => {
      authed = users.get(user.toLowerCase()) === pass;
      say(authed ? "235 2.7.0 Authentication successful" : "535 5.7.8 Username and password not accepted");
    };
    const plain = (encoded: string) => {
      const parts = Buffer.from(encoded, "base64").toString("utf8").split("\0");
      check(parts[1] ?? "", parts[2] ?? "");
    };
    say("220 localhost ESMTP Linki test mail server");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          const data = buffer.slice(0, end).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end + 5);
          inData = false;
          for (const to of recipients) deliver(from, to, data);
          say("250 2.0.0 Message accepted");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (awaiting === "plain") { awaiting = null; plain(line); continue; }
        if (awaiting === "login-user") { loginUser = Buffer.from(line, "base64").toString("utf8"); awaiting = "login-pass"; say("334 UGFzc3dvcmQ6"); continue; }
        if (awaiting === "login-pass") { awaiting = null; check(loginUser, Buffer.from(line, "base64").toString("utf8")); continue; }
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO" || verb === "HELO") { socket.write("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n"); continue; }
        if (verb === "AUTH") {
          const [, mechanism, initial] = line.split(" ");
          if (mechanism?.toUpperCase() === "PLAIN") { if (initial) plain(initial); else { awaiting = "plain"; say("334 "); } }
          else if (mechanism?.toUpperCase() === "LOGIN") { awaiting = "login-user"; say("334 VXNlcm5hbWU6"); }
          else say("504 5.5.4 Unrecognised authentication type");
          continue;
        }
        if (verb === "MAIL") { if (!authed) { say("530 5.7.0 Authentication required"); continue; } from = /<([^>]*)>/.exec(line)?.[1] ?? ""; recipients = []; say("250 2.1.0 OK"); continue; }
        if (verb === "RCPT") { recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? ""); say("250 2.1.5 OK"); continue; }
        if (verb === "DATA") { inData = true; say("354 End data with <CR><LF>.<CR><LF>"); continue; }
        if (verb === "RSET" || verb === "NOOP") { say("250 2.0.0 OK"); continue; }
        if (verb === "QUIT") { say("221 2.0.0 Bye"); socket.end(); return; }
        say("502 5.5.1 Command not implemented");
      }
    });
  });

  // ── IMAP ────────────────────────────────────────────────────────────────────
  const capability = `IMAP4rev1 AUTH=PLAIN${options.gmail ? " X-GM-EXT-1" : ""}`;
  /** "a b" c {x} → the arguments of a command, quoted strings as one each. */
  const args = (text: string): string[] => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]));

  const imap = tls.createServer(localCertificate(), (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the client went away */ });
    socket.setEncoding("utf8");
    let buffer = "";
    let user: string | null = null;
    let selected: string | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    const inFolder = () => (stores.get(user ?? "") ?? []).filter((message) => message.folder.toUpperCase() === (selected ?? "").toUpperCase());
    say(`* OK [CAPABILITY ${capability}] Linki test mail server ready`);

    const run = (tag: string, command: string, rest: string) => {
      const ok = (text = "completed") => say(`${tag} OK ${text}`);
      switch (command) {
        case "CAPABILITY": say(`* CAPABILITY ${capability}`); return ok();
        case "NOOP": case "CHECK": return ok();
        case "LOGOUT": say("* BYE logging out"); ok(); socket.end(); return;
        case "LOGIN": {
          const [name, password] = args(rest);
          if (users.get((name ?? "").toLowerCase()) !== password) return say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          user = name.toLowerCase();
          return ok(`[CAPABILITY ${capability}] logged in`);
        }
      }
      if (!user) return say(`${tag} BAD Sign in first`);
      switch (command) {
        case "NAMESPACE": say('* NAMESPACE (("" "/")) NIL NIL'); return ok();
        case "LIST": case "XLIST": {
          const [, pattern] = args(rest);
          if (!pattern) say('* LIST (\\Noselect) "/" ""');
          else for (const folder of folders) say(`* LIST (${["\\HasNoChildren", ...folder.attribs].join(" ")}) "/" "${folder.name}"`);
          return ok();
        }
        case "SELECT": case "EXAMINE": {
          const [name] = args(rest);
          if (!folders.some((folder) => folder.name.toUpperCase() === (name ?? "").toUpperCase())) return say(`${tag} NO No such folder`);
          selected = name;
          say("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
          say(`* ${inFolder().length} EXISTS`);
          say("* 0 RECENT");
          say("* OK [UIDVALIDITY 1] UIDs valid");
          say(`* OK [UIDNEXT ${nextUid}] Predicted next UID`);
          return ok(command === "EXAMINE" ? "[READ-ONLY] examined" : "[READ-WRITE] selected");
        }
        case "CLOSE": selected = null; return ok();
        case "UID": {
          const [sub, ...parts] = args(rest);
          if (sub?.toUpperCase() === "SEARCH") {
            const key = parts[0]?.toUpperCase();
            let found: StoredMessage[] = [];
            if (key === "HEADER") {
              const wanted = (parts[2] ?? "").toLowerCase();
              found = inFolder().filter((message) => (header(message.raw, parts[1]) ?? "").toLowerCase().includes(wanted));
            } else if (key === "X-GM-RAW" && options.gmail) {
              const query = parts[1] ?? "";
              const id = /rfc822msgid:(\S+)/.exec(query)?.[1]?.toLowerCase() ?? "";
              const tab = /category:(\S+)/.exec(query)?.[1]?.toLowerCase() ?? null;
              found = inFolder().filter((message) => (message.messageId ?? "").toLowerCase().includes(id) && (!tab || options.gmailTab?.(message) === tab));
            } else if (key === "ALL") found = inFolder();
            say(`* SEARCH${found.length ? ` ${found.map((message) => message.uid).join(" ")}` : ""}`);
            return ok();
          }
          if (sub?.toUpperCase() === "FETCH") {
            const uids = new Set((parts[0] ?? "").split(",").map(Number));
            const fields = /HEADER\.FIELDS \(([^)]*)\)/i.exec(rest)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
            const list = inFolder();
            list.forEach((message, index) => {
              if (!uids.has(message.uid)) return;
              const head = message.raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
              const lines = fields.length ? head.filter((line) => fields.some((field) => line.toLowerCase().startsWith(`${field.toLowerCase()}:`))) : head;
              const body = `${lines.join("\r\n")}${lines.length ? "\r\n" : ""}\r\n`;
              const section = fields.length ? `BODY[HEADER.FIELDS (${fields.join(" ")})]` : "BODY[HEADER]";
              socket.write(`* ${index + 1} FETCH (UID ${message.uid} FLAGS () INTERNALDATE "10-Oct-2026 09:00:00 +0000" ${section} {${Buffer.byteLength(body)}}\r\n${body})\r\n`);
            });
            return ok();
          }
          return say(`${tag} BAD Unknown UID command`);
        }
      }
      say(`${tag} BAD Unknown command`);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (match) run(match[1], match[2].toUpperCase(), match[3]);
      }
    });
  });

  const listen = (server: net.Server, port: number) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  const [smtpPort, imapPort] = [await listen(smtp, options.smtpPort ?? 0), await listen(imap, options.imapPort ?? 0)];

  return {
    host: "localhost", smtpPort, imapPort, received,
    addUser: (address, password) => { users.set(address.toLowerCase(), password); },
    setPassword: (address, password) => { users.set(address.toLowerCase(), password); },
    mailbox: (address) => stores.get(address.toLowerCase()) ?? [],
    stop: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      smtp.close(() => imap.close(() => resolve()));
    }),
  };
}
