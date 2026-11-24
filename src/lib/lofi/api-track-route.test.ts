import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../pages/api/tracks";
import { GET } from "../../pages/api/tracks/[id]";
import { generateLofiTrack } from "./generator";
import type { LofiTrack } from "./types";

type PostContext = Parameters<typeof POST>[0];
type GetContext = Parameters<typeof GET>[0];

function makeTrack(): LofiTrack {
  return JSON.parse(JSON.stringify(generateLofiTrack("route-fixture"))) as LofiTrack;
}

function postContext(track: unknown, ip: string): PostContext {
  return {
    request: new Request("http://localhost/api/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track }),
    }),
    clientAddress: ip,
  } as unknown as PostContext;
}

function rawPostContext(body: string, ip: string): PostContext {
  return {
    request: new Request("http://localhost/api/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    clientAddress: ip,
  } as unknown as PostContext;
}

function getContext(id: string, ip: string): GetContext {
  return {
    params: { id },
    request: new Request(`http://localhost/api/tracks/${id}`),
    clientAddress: ip,
  } as unknown as GetContext;
}

function stubUpstash(result: unknown): Array<unknown[]> {
  const commands: Array<unknown[]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as unknown[];
      // Rate-limit pipelines answer a bare array with count 1 (always
      // allowed); everything else is captured as before.
      if (Array.isArray(body[0]) && (body[0] as unknown[])[0] === "INCR") {
        return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
      }
      commands.push(body);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }),
  );
  return commands;
}

/** Stubs Upstash with a counting rate-limit pipeline: INCR pipelines return a
 *  per-key increasing count (the real fixed-window behavior), SET commands
 *  answer `singleResult()`, and other pipelines answer `pipelineResult()`. */
function stubUpstashCounting(
  singleResult: () => unknown,
  pipelineResult: () => unknown,
): { limiterCalls: Array<string[][]>; commands: Array<unknown[]>; otherPipelines: Array<unknown[][]> } {
  const limiterCalls: Array<string[][]> = [];
  const commands: Array<unknown[]> = [];
  const otherPipelines: Array<unknown[][]> = [];
  const counts = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as unknown[];
      if (!Array.isArray(body[0])) {
        commands.push(body);
        return new Response(JSON.stringify({ result: singleResult() }), { status: 200 });
      }
      if ((body[0] as unknown[])[0] !== "INCR") {
        otherPipelines.push(body as unknown[][]);
        return new Response(JSON.stringify({ result: pipelineResult() }), { status: 200 });
      }
      limiterCalls.push(body as string[][]);
      const key = String((body[0] as unknown[])[1]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });
    }),
  );
  return { limiterCalls, commands, otherPipelines };
}

/** Removes the Upstash env from both sources so the "not configured" path runs. */
function unsetUpstashEnv(): void {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  delete metaEnv.UPSTASH_REDIS_REST_URL;
  delete metaEnv.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

describe("POST /api/tracks", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("returns 503 when the cache is not configured", async () => {
    unsetUpstashEnv();
    const commands = stubUpstash("OK");

    const res = await POST(postContext(makeTrack(), "10.1.0.1"));

    expect(res.status).toBe(503);
    expect(commands.length).toBe(0);
  });

  it("returns 400 on an invalid JSON body", async () => {
    const commands = stubUpstash("OK");

    const res = await POST(rawPostContext("not json", "10.1.0.2"));

    expect(res.status).toBe(400);
    expect(commands.length).toBe(0);
  });

  it("returns 400 on an invalid track and never touches the cache", async () => {
    const commands = stubUpstash("OK");
    const track = makeTrack();
    track.tracks.melody[0]!.midi = 999;

    const res = await POST(postContext(track, "10.1.0.3"));

    expect(res.status).toBe(400);
    expect(commands.length).toBe(0);
  });

  it("stores the track with EX+NX and returns the share id", async () => {
    const commands = stubUpstash("OK");
    const track = makeTrack();

    const res = await POST(postContext(track, "10.1.0.4"));
    const payload = (await res.json()) as { id?: string };

    expect(res.status).toBe(200);
    expect(payload.id).toMatch(/^[0-9a-f]{12}$/);
    expect(commands.length).toBe(1);
    const command = commands[0] as string[];
    expect(command[0]).toBe("SET");
    expect(command[1]).toBe(`lofi:t:${payload.id}`);
    expect(command[3]).toBe("EX");
    expect(command[4]).toBe("604800");
    expect(command[5]).toBe("NX");
    expect(JSON.parse(command[2] as string)).toEqual(track);
  });

  it("retries once with a fresh id on collision", async () => {
    const commands: Array<unknown[]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as unknown[];
        if (Array.isArray(body[0]) && (body[0] as unknown[])[0] === "INCR") {
          return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
        }
        commands.push(body);
        return new Response(JSON.stringify({ result: commands.length > 1 ? "OK" : null }), { status: 200 });
      }),
    );

    const res = await POST(postContext(makeTrack(), "10.1.0.5"));
    const payload = (await res.json()) as { id?: string };

    expect(res.status).toBe(200);
    expect(commands.length).toBe(2);
    expect(payload.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns 502 when the cache cannot store the track", async () => {
    stubUpstash(null);

    const res = await POST(postContext(makeTrack(), "10.1.0.6"));

    expect(res.status).toBe(502);
  });

  it("answers 429 with Retry-After past the distributed write rate limit", async () => {
    const { limiterCalls, commands } = stubUpstashCounting(() => "OK", () => null);
    const ip = "10.1.9.9";

    for (let i = 0; i < 10; i++) {
      const res = await POST(postContext(makeTrack(), ip));
      expect(res.status).toBe(200);
    }

    const res = await POST(postContext(makeTrack(), ip));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // The budget lives in Upstash: 11 counted attempts, only 10 stores.
    expect(limiterCalls.length).toBe(11);
    expect(commands.length).toBe(10);
    expect(limiterCalls[0]?.[0]?.[1]).toBe(`rl:lofi:share:${ip}:${Math.floor(Date.now() / 600_000)}`);
  });
});

describe("GET /api/tracks/[id]", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://test-cache.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("returns 503 when the cache is not configured", async () => {
    unsetUpstashEnv();
    const commands = stubUpstash([null, 0]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.1"));

    expect(res.status).toBe(503);
    expect(commands.length).toBe(0);
  });

  it("returns 400 on a malformed id", async () => {
    const commands = stubUpstash([null, 0]);

    const res = await GET(getContext("not-an-id", "10.2.0.2"));

    expect(res.status).toBe(400);
    expect(commands.length).toBe(0);
  });

  it("returns the track and refreshes its TTL in the same pipeline", async () => {
    const track = makeTrack();
    const commands = stubUpstash([{ result: JSON.stringify(track) }, { result: 1 }]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.3"));
    const payload = (await res.json()) as { track?: LofiTrack };

    expect(res.status).toBe(200);
    expect(payload.track).toEqual(track);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual([
      ["GET", "lofi:t:a7c0f9e01bd4"],
      ["EXPIRE", "lofi:t:a7c0f9e01bd4", "604800"],
    ]);
  });

  it("returns 404 when the track expired or never existed", async () => {
    stubUpstash([{ result: null }, { result: 0 }]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.4"));

    expect(res.status).toBe(404);
  });

  it("returns 404 on a corrupted cache payload", async () => {
    stubUpstash([{ result: "{not json" }, { result: 1 }]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.5"));

    expect(res.status).toBe(404);
  });

  it("answers 429 with Retry-After past the distributed read rate limit", async () => {
    const track = makeTrack();
    const { limiterCalls, otherPipelines } = stubUpstashCounting(
      () => null,
      () => [{ result: JSON.stringify(track) }, { result: 1 }],
    );
    const ip = "10.2.9.9";

    for (let i = 0; i < 30; i++) {
      const res = await GET(getContext("a7c0f9e01bd4", ip));
      expect(res.status).toBe(200);
    }

    const res = await GET(getContext("a7c0f9e01bd4", ip));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // 31 counted attempts; the blocked one never loads the track.
    expect(limiterCalls.length).toBe(31);
    expect(otherPipelines.length).toBe(30);
    expect(limiterCalls[0]?.[0]?.[1]).toBe(`rl:lofi:read:${ip}:${Math.floor(Date.now() / 600_000)}`);
  });
});
