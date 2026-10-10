import Imap from "imap";
import { decryptSecret } from "@/lib/crypto";

// Finding an email in a mailbox this workspace can read, and saying where it landed.
//
// Used for a mailbox's test send and for inbox placement tests: the email is looked up by
// its Message-ID, and the folder it is in is the answer. The mailbox is opened read-only
// and nothing in it is changed.

/**
 * Where an email landed. `primary`, `promotions`, `social`, `updates` and `forums` are
 * Gmail's tabs, which only Gmail can tell apart; any other server says `inbox`. `other` is
 * a folder that is neither the inbox nor spam (a filter moved it).
 */
export type Placement = "inbox" | "primary" | "promotions" | "social" | "updates" | "forums" | "spam" | "other";

export const PLACEMENTS: readonly Placement[] = ["inbox", "primary", "promotions", "social", "updates", "forums", "spam", "other"];

/** What the receiving server made of the sender's SPF, DKIM and DMARC, as it wrote it on the email. */
export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface ReadBack {
  found: boolean;
  placement: Placement | null;
  folder: string | null;
  auth: AuthResults | null;
  /** Set when the mailbox could not be read at all. */
  error?: string;
}

export interface ReadableMailbox {
  imap_host: string | null;
  imap_port: number | null;
  username: string;
  /** As stored (encrypted). */
  password: string;
  imap_username: string | null;
  imap_password: string | null;
  allow_self_signed?: number | null;
}

const GMAIL_TABS = ["promotions", "social", "updates", "forums"] as const;

/** At most this many folders beyond the inbox and spam are looked in. */
const MAX_OTHER_FOLDERS = 12;

const READ_DEADLINE_MS = 25_000;

interface Folder {
  path: string;
  attribs: string[];
}

function flatten(boxes: Imap.MailBoxes, prefix = ""): Folder[] {
  const out: Folder[] = [];
  for (const [name, box] of Object.entries(boxes ?? {})) {
    const path = prefix ? `${prefix}${box.delimiter}${name}` : name;
    out.push({ path, attribs: (box.attribs ?? []).map((attrib) => String(attrib).toLowerCase()) });
    if (box.children) out.push(...flatten(box.children, path));
  }
  return out;
}

const has = (folder: Folder, attrib: string) => folder.attribs.includes(attrib);
const isSpam = (folder: Folder) => has(folder, "\\junk") || /(^|[^a-z])(spam|junk|bulk)([^a-z]|$)/i.test(folder.path);
const isInbox = (folder: Folder) => folder.path.toUpperCase() === "INBOX";
// Folders that hold what the mailbox itself sent or threw away, or everything at once.
const isSkipped = (folder: Folder) =>
  ["\\noselect", "\\sent", "\\drafts", "\\trash", "\\all", "\\flagged", "\\important"].some((attrib) => has(folder, attrib)) ||
  /(^|[^a-z])(sent|drafts?|trash|deleted|outbox|all mail)([^a-z]|$)/i.test(folder.path);

/** The folders to look in, in order: the inbox, spam, then the rest. */
export function searchOrder(boxes: Imap.MailBoxes): Array<Folder & { kind: "inbox" | "spam" | "other" }> {
  const folders = flatten(boxes);
  const inbox = folders.filter(isInbox).map((folder) => ({ ...folder, kind: "inbox" as const }));
  const spam = folders.filter((folder) => !isInbox(folder) && isSpam(folder) && !has(folder, "\\noselect")).map((folder) => ({ ...folder, kind: "spam" as const }));
  const other = folders.filter((folder) => !isInbox(folder) && !isSpam(folder) && !isSkipped(folder)).slice(0, MAX_OTHER_FOLDERS).map((folder) => ({ ...folder, kind: "other" as const }));
  return [...inbox, ...spam, ...other];
}

/** spf, dkim and dmarc out of an Authentication-Results header (the topmost one, which the receiving server wrote). */
export function parseAuthResults(header: string | null | undefined): AuthResults | null {
  if (!header) return null;
  const text = header.replace(/\r?\n[ \t]+/g, " ");
  const first = text.split(/\r?\n(?=authentication-results:)/i)[0];
  const read = (name: string) => new RegExp(`(?:^|[\\s;])${name}=([a-z]+)`, "i").exec(first)?.[1]?.toLowerCase() ?? null;
  const auth = { spf: read("spf"), dkim: read("dkim"), dmarc: read("dmarc") };
  return auth.spf || auth.dkim || auth.dmarc ? auth : null;
}

/** "<abc@example.com>" → "abc@example.com": what to search a Message-ID header for. */
const bare = (messageId: string) => messageId.trim().replace(/^<|>$/g, "");

/**
 * Look for an email by Message-ID in a mailbox. Never throws: a mailbox that cannot be
 * opened comes back as not found, with the error.
 */
export function findMessage(mailbox: ReadableMailbox, messageId: string): Promise<ReadBack> {
  const missing: ReadBack = { found: false, placement: null, folder: null, auth: null };
  if (!mailbox.imap_host) return Promise.resolve({ ...missing, error: "This mailbox has no IMAP server, so it cannot be read." });
  const wanted = bare(messageId);
  let password: string;
  try {
    password = decryptSecret(mailbox.imap_password) ?? decryptSecret(mailbox.password) ?? "";
  } catch {
    return Promise.resolve({ ...missing, error: "The password stored for this mailbox cannot be read, so it cannot be opened." });
  }

  return new Promise((resolve) => {
    const imap = new Imap({
      host: mailbox.imap_host!,
      port: mailbox.imap_port ?? 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: mailbox.allow_self_signed !== 1, servername: mailbox.imap_host! },
      user: mailbox.imap_username ?? mailbox.username,
      password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    let settled = false;
    const finish = (result: ReadBack) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { imap.end(); } catch { /* already closed */ }
      resolve(result);
    };
    const deadline = setTimeout(() => {
      try { imap.destroy(); } catch { /* already closed */ }
      finish({ ...missing, error: "The mailbox took too long to answer." });
    }, READ_DEADLINE_MS);
    deadline.unref?.();

    imap.once("error", (error: Error) => finish({ ...missing, error: error.message }));
    imap.once("end", () => finish(missing));
    imap.once("close", () => finish(missing));

    imap.once("ready", () => {
      imap.getBoxes((listError, boxes) => {
        if (listError) return finish({ ...missing, error: listError.message });
        const folders = searchOrder(boxes);
        let index = 0;

        const next = () => {
          const folder = folders[index++];
          if (!folder) return finish(missing);
          imap.openBox(folder.path, true, (openError) => {
            if (openError) return next();
            imap.search([["HEADER", "MESSAGE-ID", wanted]], (searchError, uids) => {
              if (searchError || !uids?.length) return next();
              const uid = uids[uids.length - 1];
              readAuthHeader(imap, uid, (auth) => {
                if (folder.kind !== "inbox") return finish({ found: true, placement: folder.kind, folder: folder.path, auth });
                gmailTab(imap, wanted, (tab) => finish({ found: true, placement: tab ?? "inbox", folder: folder.path, auth }));
              });
            });
          });
        };
        next();
      });
    });

    imap.connect();
  });
}

function readAuthHeader(imap: Imap, uid: number, done: (auth: AuthResults | null) => void) {
  let header = "";
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    done(parseAuthResults(header));
  };
  try {
    const fetch = imap.fetch([uid], { bodies: "HEADER.FIELDS (AUTHENTICATION-RESULTS)" });
    fetch.on("message", (message) => {
      message.on("body", (stream) => {
        stream.on("data", (chunk: Buffer) => { header += chunk.toString("utf8"); });
      });
    });
    fetch.once("error", finish);
    fetch.once("end", finish);
  } catch {
    finish();
  }
}

/** Which Gmail tab the email in the open inbox is under, or null on a server that is not Gmail. */
function gmailTab(imap: Imap, wanted: string, done: (tab: Placement | null) => void) {
  if (!imap.serverSupports("X-GM-EXT-1")) return done(null);
  let index = 0;
  const next = () => {
    const tab = GMAIL_TABS[index++];
    if (!tab) return done("primary");
    imap.search([["X-GM-RAW", `rfc822msgid:${wanted} category:${tab}`]], (error, uids) => {
      if (!error && uids?.length) return done(tab);
      next();
    });
  };
  next();
}
