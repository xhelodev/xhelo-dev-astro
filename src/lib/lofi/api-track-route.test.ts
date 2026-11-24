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
      commands.push(JSON.parse(String(init.body)) as unknown[]);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }),
  );
  return commands;
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
        commands.push(JSON.parse(String(init.body)) as unknown[]);
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

  it("answers 429 with Retry-After past the write rate limit", async () => {
    stubUpstash("OK");
    const ip = "10.1.9.9";

    for (let i = 0; i < 10; i++) {
      const res = await POST(postContext(makeTrack(), ip));
      expect(res.status).toBe(200);
    }

    const res = await POST(postContext(makeTrack(), ip));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
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
    const commands = stubUpstash([JSON.stringify(track), 1]);

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
    stubUpstash([null, 0]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.4"));

    expect(res.status).toBe(404);
  });

  it("returns 404 on a corrupted cache payload", async () => {
    stubUpstash(["{not json", 1]);

    const res = await GET(getContext("a7c0f9e01bd4", "10.2.0.5"));

    expect(res.status).toBe(404);
  });

  it("answers 429 past the read rate limit", async () => {
    const track = makeTrack();
    stubUpstash([JSON.stringify(track), 1]);
    const ip = "10.2.9.9";

    for (let i = 0; i < 30; i++) {
      const res = await GET(getContext("a7c0f9e01bd4", ip));
      expect(res.status).toBe(200);
    }

    const res = await GET(getContext("a7c0f9e01bd4", ip));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
  });
});
