// Writing a CSV file to a response, a batch at a time.
import type { ServerResponse } from "http";

/** One column of an export: its heading and how to read it off a row. */
export interface CsvColumn<Row> { header: string; value: (row: Row) => unknown }

// A spreadsheet runs a cell that starts with one of these as a formula, and a contact's
// name, a reply's subject or a company name is text a stranger wrote. Such a cell is
// written with a leading apostrophe, which makes it plain text.
const FORMULA_START = /^[=+\-@\t\r]/;
// Left alone: a signed figure ("-12.5") and a phone number written with its country code
// ("+44 20 7946 0958"). Neither can call a function or point at another cell, and a phone
// number with an apostrophe in front is no use to whatever the file is loaded into next.
const SIGNED_NUMBER = /^[+-]?\d+(\.\d+)?$/;
const PHONE_NUMBER = /^\+[\d\s().-]+$/;

/** One value as a CSV field: RFC 4180 quoting, and no cell a spreadsheet would run. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value !== "number" && FORMULA_START.test(text) && !SIGNED_NUMBER.test(text) && !PHONE_NUMBER.test(text)) text = `'${text}`;
  // Quoted when it holds the separator, a quote or a line break, or when its edge spaces
  // would otherwise be trimmed by whatever reads it.
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (values: unknown[]): string => `${values.map(csvCell).join(",")}\r\n`;

/** A name safe to put in a Content-Disposition header. */
export const csvFilename = (name: string): string => `${name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export"}.csv`;

const BATCH = 1000;

function write(res: ServerResponse, chunk: string): Promise<void> | void {
  if (res.write(chunk) || res.destroyed) return;
  // The reader is slower than we are: wait for it, or for it to go away.
  return new Promise<void>((resolve) => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Send rows as a CSV download and return how many were sent.
 *
 * `page(limit, offset)` is asked for one batch at a time. Each batch is a complete query,
 * so the database connection is never held open while waiting on a slow download - the
 * whole app shares that one connection, and a statement left half-read on it stops
 * everything else that needs it. The order `page` returns rows in must be a total one
 * (end it with a unique column) or a batch boundary can repeat or drop a row.
 */
export async function sendCsv<Row>(res: ServerResponse, filename: string, columns: CsvColumn<Row>[], page: (limit: number, offset: number) => Row[]): Promise<number> {
  // The first batch is read before anything is sent, so a query that fails is an error
  // response rather than a download that stops after its headings.
  let rows = page(BATCH, 0);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${csvFilename(filename)}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The byte-order mark is what makes Excel read the file as UTF-8 rather than mangle
  // every accented name.
  await write(res, `\uFEFF${csvLine(columns.map((column) => column.header))}`);
  let sent = 0;
  for (;;) {
    if (rows.length) await write(res, rows.map((row) => csvLine(columns.map((column) => column.value(row)))).join(""));
    sent += rows.length;
    if (rows.length < BATCH || res.destroyed) break;
    rows = page(BATCH, sent);
  }
  res.end();
  return sent;
}
