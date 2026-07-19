// Health probe for container orchestration and uptime monitoring.
//
// GET /api/health           -> liveness  (process is up)
// GET /api/health?ready=1   -> readiness (process is up AND SQLite answers)
//
// This route is intentionally listed in proxy.ts PUBLIC_API_PREFIXES so the
// Docker healthcheck can reach it without a session. It performs only a
// read-only "SELECT 1" and never touches the LinkedIn/browser subsystem.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

type HealthResponse = {
  status: "ok" | "degraded";
  db?: "up" | "down";
  uptime: number;
  timestamp: string;
};

export default function handler(req: NextApiRequest, res: NextApiResponse<HealthResponse>) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).end();
  }

  const base = {
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  // Liveness only unless readiness is explicitly requested. Keeping liveness
  // dependency-free means a transient DB blip never flaps the container as
  // "unhealthy" and kills in-flight LinkedIn/email work on restart.
  const wantsReadiness = req.query.ready === "1" || req.query.ready === "true";
  if (!wantsReadiness) {
    return res.status(200).json({ status: "ok", ...base });
  }

  try {
    getDb().prepare("SELECT 1").get();
    return res.status(200).json({ status: "ok", db: "up", ...base });
  } catch {
    // Do not leak the underlying error to an unauthenticated caller.
    return res.status(503).json({ status: "degraded", db: "down", ...base });
  }
}
