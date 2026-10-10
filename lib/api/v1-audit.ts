// Every change made through the public API leaves an entry in the workspace's audit log,
// saying which key made it and from where.
import type { NextApiRequest, NextApiResponse } from "next";
import { clientIp } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/workspace";

interface ApiWrite {
  workspaceId: string;
  /** The API key's name: who the entry is attributed to. */
  keyName: string;
  resource: string;
  id?: string;
  action?: string;
}

/** What a write is called in the log, matching the names the app uses for the same change. */
export function apiWriteAction(method: string, resource: string, id?: string, action?: string): { action: string; entityType: string } {
  const verb = method === "POST" ? "created" : method === "DELETE" ? "deleted" : "updated";
  if (resource === "contacts") {
    if (id === "verify") return { action: "contact.emails_verified", entityType: "contact" };
    if (action === "send") return { action: "contact.email_sent", entityType: "contact" };
    return { action: `contact.${verb}`, entityType: "contact" };
  }
  if (resource === "signals") return { action: `signal.${verb}`, entityType: "signal" };
  if (resource === "events") return { action: "domain_event.emitted", entityType: "domain_event" };
  if (resource === "opportunities") return { action: `opportunity.${verb}`, entityType: "opportunity" };
  return { action: `${resource.replace(/s$/, "")}.${verb}`, entityType: resource.replace(/s$/, "") };
}

/**
 * Record the write this request makes, once it has succeeded. Call it before the route
 * does its work: the entry is written as the response is sent, and only for a 2xx.
 */
export function auditApiWrite(req: NextApiRequest, res: NextApiResponse, write: ApiWrite): void {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const named = apiWriteAction(req.method ?? "POST", write.resource, write.id, write.action);
        const created = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
        const entityId = write.id && write.id !== "verify" ? write.id : created;
        const ip = clientIp(req);
        recordAudit(
          { workspaceId: write.workspaceId, userId: null, role: "member", source: "api", via: write.keyName, ip: ip === "unknown" ? null : ip },
          named.action, named.entityType, entityId,
        );
      }
    } catch (error) {
      // The change is made; failing to note it must not turn it into an error.
      console.warn("[api] could not record an audit entry:", error instanceof Error ? error.message : error);
    }
    return send(body);
  }) as typeof res.json;
}
