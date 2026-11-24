import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, getClientIp, type RateLimitRule } from "./rate-limit";

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_SEC = 600;

function makeRule(keyPrefix: string, max: number): RateLimitRule {
  return { keyPrefix, max, windowMs: WINDOW_MS };
}

/** Sets the Upstash env in both sources so getUpstashConfig() finds it. */
function setUpstashEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  metaEnv.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  metaEnv.UPSTASH_REDIS_REST_TOKEN = "test-token";
}

/** Removes the Upstash env from both sources so the fallback path runs. */
function unsetUpstashEnv(): void {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  delete metaEnv.UPSTASH_REDIS_REST_URL;
  delete metaEnv.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

/** Answers every rate-limit pipeline (first command INCR) with a per-key
 *  increasing count, and fails on any other Upstash command. */
function stubCountingPipeline(): { limiterCalls: Array<string[][]>; counts: Map<string, number> } {
  const limiterCalls: Array<string[][]> = [];
  const counts = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as unknown[][];
      const first = body[0] ?? [];
      if (first[0] !== "INCR") throw new Error(`unexpected Upstash command: ${JSON.stringify(body)}`);
      const key = String(first[1]);
      limiterCalls.push(body as string[][]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });
    }),
  );
  return { limiterCalls, counts };
}

function currentBucket(): number {
  return Math.floor(Date.now() / WINDOW_MS);
}

describe("getClientIp", () => {
  it("prefers the platform clientAddress over spoofable forwarded headers", () => {
    const request = new Request("http://localhost/api/x", {
      headers: { "x-forwarded-for": "6.6.6.6, 7.7.7.7", "x-real-ip": "8.8.8.8" },
    });

    expect(getClientIp(request, "203.0.113.9")).toBe("203.0.113.9");
  });

  it("falls back to the first x-forwarded-for hop when clientAddress is absent", () => {
    const request = new Request("http://localhost/api/x", {
      headers: { "x-forwarded-for": "6.6.6.6, 7.7.7.7" },
    });

    expect(getClientIp(request, undefined)).toBe("6.6.6.6");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("http://localhost/api/x", { headers: { "x-real-ip": "8.8.8.8" } });

    expect(getClientIp(request, undefined)).toBe("8.8.8.8");
  });

  it("resolves to unknown when no source is available", () => {
    const request = new Request("http://localhost/api/x");

    expect(getClientIp(request, undefined)).toBe("unknown");
  });
});

describe("checkRateLimit — Upstash fixed window", () => {
  beforeEach(() => {
    setUpstashEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    unsetUpstashEnv();
    vi.useRealTimers();
  });

  it("counts with INCR+EXPIRE under the bucketed rl:<prefix>:<ip> key", async () => {
    const { limiterCalls } = stubCountingPipeline();

    const res = await checkRateLimit("198.51.100.7", makeRule("lofi:gen", 10));

    expect(res).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(limiterCalls.length).toBe(1);
    const key = `rl:lofi:gen:198.51.100.7:${currentBucket()}`;
    expect(limiterCalls[0]).toEqual([
      ["INCR", key],
      ["EXPIRE", key, String(WINDOW_SEC + 1)],
    ]);
  });

  it("blocks past max with a Retry-After bounded by the window", async () => {
    stubCountingPipeline();
    const ip = "198.51.100.8";
    const rule = makeRule("lofi:gen", 3);

    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(ip, rule)).toEqual({ allowed: true, retryAfterSec: 0 });
    }

    const blocked = await checkRateLimit(ip, rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(WINDOW_SEC);
  });

  it("keeps budgets independent per key prefix", async () => {
    stubCountingPipeline();
    const ip = "198.51.100.9";

    expect((await checkRateLimit(ip, makeRule("lofi:gen", 1))).allowed).toBe(true);
    expect((await checkRateLimit(ip, makeRule("lofi:gen", 1))).allowed).toBe(false);
    // Exhausting the generation budget does not touch the share budget.
    expect((await checkRateLimit(ip, makeRule("lofi:share", 1))).allowed).toBe(true);
  });

  it("allows again once the window bucket rolls over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    stubCountingPipeline();
    const ip = "198.51.100.10";
    const rule = makeRule("lofi:read", 2);

    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
  });
});

describe("checkRateLimit — in-memory fallback", () => {
  beforeEach(() => {
    unsetUpstashEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("limits locally without any fetch when Upstash is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ip = "198.51.100.11";
    const rule = makeRule("lofi:gen", 2);

    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the local limiter when Upstash is unreachable", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 500 })),
    );
    const ip = "198.51.100.12";
    const rule = makeRule("lofi:share", 2);

    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(false);
  });

  it("allows again after the window passes in the local limiter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ip = "198.51.100.13";
    const rule = makeRule("lofi:read", 2);

    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
  });
});
