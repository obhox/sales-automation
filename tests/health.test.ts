import { describe, it, expect } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/health";

// Minimal res double capturing status/json/end and header calls.
function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

function mockReq(method: string, query: Record<string, string> = {}) {
  return { method, query } as unknown as NextApiRequest;
}

describe("GET /api/health", () => {
  it("returns 200 ok for liveness without touching the DB", () => {
    const res = mockRes();
    handler(mockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBeUndefined();
    expect(typeof res.body.uptime).toBe("number");
  });

  it("reports db up for readiness against the test database", () => {
    const res = mockRes();
    handler(mockReq("GET", { ready: "1" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("up");
  });

  it("rejects non-GET methods with 405", () => {
    const res = mockRes();
    handler(mockReq("POST"), res);
    expect(res.statusCode).toBe(405);
  });
});
