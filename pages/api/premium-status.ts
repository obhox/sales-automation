// Capability discovery for optional UI surfaces.
import type { NextApiRequest, NextApiResponse } from "next";
import { capabilities, hasPremium } from "@/lib/premium";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ hasPremium, capabilities });
}
