/**
 * Edge-case pins from the T19 independent verification (L38): fallback
 * triggers that must never fail open or closed, bucket-boundary arithmetic,
 * IP-source hardening, and cross-budget independence at the route level.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, getClientIp, type RateLimitRule } from "./rate-limit";
import { POST as LOFI_POST } from "../../pages/api/lofi";
import { POST as TRACKS_POST } from "../../pages/api/tracks";
import { GET as TRACK_GET } from "../../pages/api/tracks/[id]";
import { generateLofiTrack } from "./generator";

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_SEC = 600;

function makeRule(prefix: string, max: number): RateLimitRule {
  return { keyPrefix: prefix, max, windowMs: WINDOW_MS };
}

/** Sets the Upstash env in both sources so getUpstashConfig() finds it. */
function setUpstashEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  metaEnv.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  metaEnv.UPSTASH_REDIS_REST_TOKEN = "test-token";
}

function unsetUpstashEnv(): void {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  delete metaEnv.UPSTASH_REDIS_REST_URL;
  delete metaEnv.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

const AI_COMPOSITION = JSON.stringify({
  title: "Probe",
  key: "A minor",
  bpm: 72,
  swing: 0.56,
  chords: [{ notes: [57, 60, 64], bass: 45 }],
  melody: [{ midi: 69, start: 0.5, dur: 1 }],
  drums: { kick: [0, 8], snare: [4, 12], closedHat: [0, 2, 4, 6] },
});

/** Full Upstash + OpenRouter stub: counting INCR pipelines, SET → OK,
 *  GET+EXPIRE pipeline → stored track, openrouter.ai → AI composition. */
function stubFullStack(): { limiterKeys: string[] } {
  const counts = new Map<string, number>();
  const limiterKeys: string[] = [];
  const track = JSON.stringify(generateLofiTrack("probe-xroute"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as unknown;
      if (String(url).includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: AI_COMPOSITION }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }
      const arr = body as unknown[];
      if (Array.isArray(arr[0])) {
        if ((arr[0] as unknown[])[0] === "INCR") {
          const key = String((arr[0] as unknown[])[1]);
          limiterKeys.push(key);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });
        }
        return new Response(JSON.stringify([{ result: track }, { result: 1 }]), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }),
  );
  return { limiterKeys };
}

afterEach(() => {
  vi.unstubAllGlobals();
  unsetUpstashEnv();
  vi.useRealTimers();
  delete process.env.OPENROUTER_API_KEY;
});

describe("fallback triggers (never fail-open / fail-closed)", () => {
  it("falls back to memory when fetch throws (network unreachable)", async () => {
    setUpstashEnv();
    let fetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetches++;
        throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
      }),
    );
    const ip = "10.90.0.1";
    const rule = makeRule("lofi:gen", 2);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    const blocked = await checkRateLimit(ip, rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    // Every attempt tried Upstash first; none failed open.
    expect(fetches).toBe(3);
  });

  it("falls back to memory on an Upstash HTTP 200 command-error body", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "ERR max requests limit exceeded" }), { status: 200 })),
    );
    const rule = makeRule("lofi:share", 1);
    expect((await checkRateLimit("10.90.0.2", rule)).allowed).toBe(true);
    expect((await checkRateLimit("10.90.0.2", rule)).allowed).toBe(false);
  });

  it("falls back to memory on a garbage (non-JSON) Upstash body", async () => {
    setUpstashEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 })));
    const rule = makeRule("lofi:read", 1);
    expect((await checkRateLimit("10.90.0.3", rule)).allowed).toBe(true);
    expect((await checkRateLimit("10.90.0.3", rule)).allowed).toBe(false);
  });

  it("falls back to memory when INCR answers a non-numeric count", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ result: "NaN-ish" }, { result: 1 }]), { status: 200 })),
    );
    const rule = makeRule("lofi:gen", 1);
    expect((await checkRateLimit("10.90.0.4", rule)).allowed).toBe(true);
    // Counted in memory, not fail-open.
    expect((await checkRateLimit("10.90.0.4", rule)).allowed).toBe(false);
  });
});

describe("bucket boundaries and TTL arithmetic", () => {
  it("answers Retry-After 600 at bucket start and 1 at bucket end (never 0)", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ result: 99 }, { result: 1 }]), { status: 200 })),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.001Z"));
    expect((await checkRateLimit("10.90.1.1", makeRule("lofi:gen", 0))).retryAfterSec).toBe(600);
    vi.setSystemTime(new Date("2026-01-01T00:09:59.999Z"));
    expect((await checkRateLimit("10.90.1.2", makeRule("lofi:gen", 0))).retryAfterSec).toBe(1);
  });

  it("keeps the EXPIRE TTL (601) ahead of the worst-case remaining bucket time", async () => {
    setUpstashEnv();
    const calls: Array<unknown[]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)) as unknown[]);
        return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await checkRateLimit("10.90.2.1", makeRule("lofi:gen", 10));
    const bucket = Math.floor(Date.now() / WINDOW_MS);
    expect(calls[0]).toEqual([
      ["INCR", `rl:lofi:gen:10.90.2.1:${bucket}`],
      ["EXPIRE", `rl:lofi:gen:10.90.2.1:${bucket}`, String(WINDOW_SEC + 1)],
    ]);
  });
});

describe("getClientIp hardening", () => {
  it("keeps a spoofed x-forwarded-for out of the limiter key when clientAddress exists", async () => {
    setUpstashEnv();
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as string[][];
        keys.push(String(body[0]?.[1]));
        return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
      }),
    );
    const request = new Request("http://localhost/x", { headers: { "x-forwarded-for": "9.9.9.9" } });
    const ip = getClientIp(request, "203.0.113.5");
    await checkRateLimit(ip, makeRule("lofi:gen", 10));
    expect(keys[0]).not.toContain("9.9.9.9");
    expect(keys[0]?.startsWith("rl:lofi:gen:203.0.113.5:")).toBe(true);
  });

  it("lets a whitespace-only clientAddress fall through to x-forwarded-for", () => {
    const request = new Request("http://localhost/x", { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(getClientIp(request, "   ")).toBe("6.6.6.6");
  });

  it("treats unknown as the last resort and shares one bucket key", async () => {
    setUpstashEnv();
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as string[][];
        keys.push(String(body[0]?.[1]));
        return new Response(JSON.stringify([{ result: keys.length }, { result: 1 }]), { status: 200 });
      }),
    );
    const ip = getClientIp(new Request("http://localhost/x"), undefined);
    expect(ip).toBe("unknown");
    const rule = makeRule("lofi:gen", 1);
    expect((await checkRateLimit(ip, rule)).allowed).toBe(true);
    // Both hits count under the same key.
    expect((await checkRateLimit(ip, rule)).allowed).toBe(false);
    expect(keys.every((key) => key.startsWith(`rl:lofi:gen:unknown:${Math.floor(Date.now() / WINDOW_MS)}`))).toBe(true);
  });
});

describe("route-level cross-budget independence (Upstash configured)", () => {
  it("keeps share and read budgets intact after gen is exhausted", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    setUpstashEnv();
    const { limiterKeys } = stubFullStack();
    const ip = "10.91.0.1";
    const lofiCtx = (): Parameters<typeof LOFI_POST>[0] =>
      ({
        request: new Request("http://localhost/api/lofi", {
          method: "POST",
          body: JSON.stringify({ prompt: "rainy tokyo night probe" }),
        }),
        clientAddress: ip,
      }) as unknown as Parameters<typeof LOFI_POST>[0];

    for (let i = 0; i < 10; i++) {
      const res = await LOFI_POST(lofiCtx());
      expect(res.status).toBe(200);
    }
    const blocked = await LOFI_POST(lofiCtx());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    // Same IP: the share budget is untouched.
    const track = generateLofiTrack("probe-xroute");
    const saveRes = await TRACKS_POST({
      request: new Request("http://localhost/api/tracks", {
        method: "POST",
        body: JSON.stringify({ track }),
      }),
      clientAddress: ip,
    } as unknown as Parameters<typeof TRACKS_POST>[0]);
    expect(saveRes.status).toBe(200);
    const { id } = (await saveRes.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{12}$/);

    // Same IP: the read budget is untouched.
    const getRes = await TRACK_GET({
      params: { id },
      request: new Request(`http://localhost/api/tracks/${id}`),
      clientAddress: ip,
    } as unknown as Parameters<typeof TRACK_GET>[0]);
    expect(getRes.status).toBe(200);

    const prefixes = new Set(limiterKeys.map((key) => key.split(":").slice(0, 3).join(":")));
    expect(prefixes).toEqual(new Set(["rl:lofi:gen", "rl:lofi:share", "rl:lofi:read"]));
    expect(limiterKeys.every((key) => key.includes(ip))).toBe(true);
  });

  it("keeps the 503 env gate ahead of the 429 limiter (baseline order)", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    setUpstashEnv();
    stubFullStack();
    const ip = "10.91.1.1";
    const lofiCtx = (): Parameters<typeof LOFI_POST>[0] =>
      ({
        request: new Request("http://localhost/api/lofi", {
          method: "POST",
          body: JSON.stringify({ prompt: "aa" }),
        }),
        clientAddress: ip,
      }) as unknown as Parameters<typeof LOFI_POST>[0];
    for (let i = 0; i < 10; i++) await LOFI_POST(lofiCtx());
    process.env.OPENROUTER_API_KEY = "";
    const res = await LOFI_POST(lofiCtx());
    expect(res.status).toBe(503);
  });
});

describe("in-memory fallback budget independence and growth", () => {
  it("does not block the share budget after gen is exhausted in fallback mode", async () => {
    unsetUpstashEnv();
    vi.stubGlobal("fetch", vi.fn());
    const gen = makeRule("lofi:gen", 10);
    for (let i = 0; i < 10; i++) expect((await checkRateLimit("10.92.0.1", gen)).allowed).toBe(true);
    expect((await checkRateLimit("10.92.0.1", gen)).allowed).toBe(false);
    expect((await checkRateLimit("10.92.0.1", makeRule("lofi:share", 10))).allowed).toBe(true);
    expect((await checkRateLimit("10.92.0.1", makeRule("lofi:read", 30))).allowed).toBe(true);
  });

  it("keeps per-IP budgets intact across 501 distinct IPs (cleanup threshold)", async () => {
    unsetUpstashEnv();
    vi.stubGlobal("fetch", vi.fn());
    const rule = makeRule("lofi:gen", 1);
    for (let i = 0; i < 501; i++) {
      expect((await checkRateLimit(`10.93.${Math.floor(i / 256)}.${i % 256}`, rule)).allowed).toBe(true);
    }
    // A second hit on a known IP is still limited.
    expect((await checkRateLimit("10.93.0.0", rule)).allowed).toBe(false);
  });
});
