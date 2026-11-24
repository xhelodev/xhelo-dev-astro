import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../pages/api/lofi";

type RouteContext = Parameters<typeof POST>[0];

function makeRequest(prompt: string): Request {
  return new Request("http://localhost/api/lofi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

function makeContext(prompt: string, ip: string): RouteContext {
  return { request: makeRequest(prompt), clientAddress: ip } as unknown as RouteContext;
}

function stubUpstreamFetch(handler: (init: RequestInit) => Response) {
  const captured: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return captured;
}

/** Removes the Upstash env from both sources so the limiter runs locally and
 *  the stubbed fetch only ever sees OpenRouter calls. */
function unsetUpstashEnv(): void {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  delete metaEnv.UPSTASH_REDIS_REST_URL;
  delete metaEnv.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

/** Sets the Upstash env in both sources so the limiter runs distributed. */
function setUpstashEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  metaEnv.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
  metaEnv.UPSTASH_REDIS_REST_TOKEN = "test-token";
}

const VALID_COMPOSITION = JSON.stringify({
  title: "Retry OK",
  key: "A minor",
  bpm: 72,
  swing: 0.56,
  chords: [{ notes: [57, 60, 64], bass: 45 }],
  melody: [{ midi: 69, start: 0.5, dur: 1 }],
  drums: { kick: [0, 8], snare: [4, 12], closedHat: [0, 2, 4, 6] },
});

describe("POST /api/lofi", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.OPENROUTER_MODEL;
    unsetUpstashEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("sends a bounded reasoning budget and enough output tokens to OpenRouter", async () => {
    const captured = stubUpstreamFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
    );

    await POST(makeContext("rainy tokyo night", "10.0.0.1"));

    expect(captured.length).toBe(1);
    const payload = captured[0]!;
    expect(payload.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it("returns 502 when the model returns empty content on every attempt", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(init);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
          { status: 200 },
        );
      }),
    );

    const res = await POST(makeContext("rainy tokyo night", "10.0.0.2"));

    expect(res.status).toBe(502);
    expect(calls.length).toBe(2); // one retry before giving up
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("AI returned an empty composition.");
  });

  it("retries once with reasoning disabled when the model returns empty content, then succeeds", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const empty = payloads.length === 1;
        const content = empty ? null : VALID_COMPOSITION;
        return new Response(
          JSON.stringify({ choices: [{ message: { content }, finish_reason: empty ? "length" : "stop" }] }),
          { status: 200 },
        );
      }),
    );

    const res = await POST(makeContext("dark cyberpunk alley", "10.0.0.3"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { track?: { seed?: string } };
    expect(body.track?.seed).toBe("Retry OK");
    expect(payloads.length).toBe(2);
    expect(payloads[0]?.reasoning).toEqual({ effort: "low" });
    expect(payloads[1]?.reasoning).toEqual({ enabled: false });
  });

  it("enforces the distributed rate limit before calling the AI provider", async () => {
    setUpstashEnv();
    const openrouter: unknown[] = [];
    const limiterCalls: Array<string[][]> = [];
    const counts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as unknown[];
        if (Array.isArray(body[0]) && (body[0] as unknown[])[0] === "INCR") {
          limiterCalls.push(body as string[][]);
          const key = String((body[0] as unknown[])[1]);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });
        }
        openrouter.push(body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: VALID_COMPOSITION }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }),
    );
    const ip = "10.4.9.9";

    for (let i = 0; i < 10; i++) {
      const res = await POST(makeContext("rainy tokyo night", ip));
      expect(res.status).toBe(200);
    }

    const res = await POST(makeContext("rainy tokyo night", ip));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // The 11th request is counted and blocked without reaching OpenRouter.
    expect(limiterCalls.length).toBe(11);
    expect(openrouter.length).toBe(10);
    expect(limiterCalls[0]?.[0]?.[1]).toBe(`rl:lofi:gen:${ip}:${Math.floor(Date.now() / 600_000)}`);
  });
});
