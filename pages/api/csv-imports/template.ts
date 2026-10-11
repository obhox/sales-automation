import type { NextApiRequest, NextApiResponse } from "next";
import { buildCsvTemplate } from "@/lib/csv-import";
import { requireWorkspace } from "@/lib/workspace";

/** GET : a CSV file with the columns Linki recognises and one example row. The same file a list's own template link gives. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res); if (!ctx) return;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="linki-contacts-template.csv"');
  return res.status(200).send(buildCsvTemplate());
}
