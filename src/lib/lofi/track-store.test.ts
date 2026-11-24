import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLofiTrack } from "./generator";
import {
  TRACK_TTL_SECONDS,
  isTrackId,
  loadSharedTrack,
  newTrackId,
  saveSharedTrack,
  trackKey,
  validateLofiTrack,
  type UpstashConfig,
} from "./track-store";
import type { LofiTrack, NoteEvent } from "./types";

const CONFIG: UpstashConfig = { url: "https://test-cache.upstash.io", token: "test-token" };

function cloneTrack(): LofiTrack {
  return JSON.parse(JSON.stringify(generateLofiTrack("validation-fixture"))) as LofiTrack;
}

/** Stub global fetch with an Upstash-shaped JSON response; captures the
 *  request URLs so tests can pin the real endpoint layout ("/" for single
 *  commands, "/pipeline" for pipelines). */
function stubUpstash(result: unknown, status = 200): { commands: Array<unknown[]>; urls: string[] } {
  const commands: Array<unknown[]> = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      urls.push(String(url));
      commands.push(JSON.parse(String(init.body)) as unknown[]);
      return new Response(JSON.stringify({ result }), { status });
    }),
  );
  return { commands, urls };
}

describe("validateLofiTrack", () => {
  it("accepts a freshly generated track unchanged", () => {
    const track = cloneTrack();
    expect(validateLofiTrack(track)).toEqual(track);
  });

  it("accepts a valid optional preset", () => {
    const track = cloneTrack();
    track.preset = "snes-rpg";
    expect(validateLofiTrack(track)).toEqual(track);
  });

  it("rejects non-object input", () => {
    for (const input of [null, undefined, 42, "track", [], true]) {
      expect(validateLofiTrack(input)).toBeNull();
    }
  });

  it("rejects bad seed values", () => {
    for (const seed of [undefined, 42, "", "x".repeat(65)]) {
      const track = cloneTrack();
      (track as unknown as Record<string, unknown>).seed = seed;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects bpm outside 55-120 or non-finite", () => {
    for (const bpm of [54, 121, Number.NaN, "80"]) {
      const track = cloneTrack();
      track.bpm = bpm as number;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects bad bars values", () => {
    for (const bars of [0, 33, 2.5, undefined]) {
      const track = cloneTrack();
      track.bars = bars as number;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects bad key values", () => {
    for (const key of [undefined, 42, "x".repeat(33)]) {
      const track = cloneTrack();
      track.key = key as unknown as string;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects swing outside 0.50-0.65", () => {
    for (const swing of [0.49, 0.66, Number.NaN]) {
      const track = cloneTrack();
      track.swing = swing;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects unknown presets", () => {
    const track = cloneTrack();
    track.preset = "nope" as LofiTrack["preset"];
    expect(validateLofiTrack(track)).toBeNull();
  });

  it("rejects missing or non-array lanes", () => {
    const missing = cloneTrack();
    delete (missing.tracks as unknown as Record<string, unknown>).melody;
    expect(validateLofiTrack(missing)).toBeNull();

    const notArray = cloneTrack();
    (notArray.tracks as unknown as Record<string, unknown>).chords = {};
    expect(validateLofiTrack(notArray)).toBeNull();
  });

  it("rejects events with out-of-range or non-integer midi", () => {
    for (const midi of [-1, 128, 60.5, Number.NaN]) {
      const track = cloneTrack();
      track.tracks.chords[0]!.midi = midi;
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects drums notes outside the GM map", () => {
    const track = cloneTrack();
    track.tracks.drums[0]!.midi = 60;
    expect(validateLofiTrack(track)).toBeNull();
  });

  it("rejects bad velocity, startBeat and durationBeats", () => {
    const cases: Array<Partial<NoteEvent>> = [
      { velocity: -0.01 },
      { velocity: 1.01 },
      { velocity: Number.NaN },
      { startBeat: -0.5 },
      { durationBeats: 0 },
      { durationBeats: -1 },
      { durationBeats: Number.NaN },
    ];
    for (const patch of cases) {
      const track = cloneTrack();
      Object.assign(track.tracks.melody[0]!, patch);
      expect(validateLofiTrack(track)).toBeNull();
    }
  });

  it("rejects non-object events inside a lane", () => {
    const track = cloneTrack();
    (track.tracks.bass as unknown[])[0] = null;
    expect(validateLofiTrack(track)).toBeNull();
  });

  it("rejects lanes with more than 512 events", () => {
    const track = cloneTrack();
    const proto = track.tracks.melody[0]!;
    track.tracks.melody = Array.from({ length: 513 }, () => ({ ...proto }));
    expect(validateLofiTrack(track)).toBeNull();
  });
});

describe("share ids and keys", () => {
  it("generates 12-char lowercase hex ids", () => {
    const id = newTrackId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("generates distinct ids", () => {
    expect(newTrackId()).not.toBe(newTrackId());
  });

  it("recognizes valid ids only", () => {
    expect(isTrackId("a7c0f9e01bd4")).toBe(true);
    for (const bad of ["", "short", "a7c0f9e01bd40", "AXK9Q01BD4F", 42, null, undefined]) {
      expect(isTrackId(bad)).toBe(false);
    }
  });

  it("prefixes cache keys", () => {
    expect(trackKey("a7c0f9e01bd4")).toBe("lofi:t:a7c0f9e01bd4");
  });

  it("pins the sliding TTL to 7 days", () => {
    expect(TRACK_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe("saveSharedTrack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores with SET EX NX and returns the id", async () => {
    const { commands, urls } = stubUpstash("OK");
    const track = cloneTrack();

    const id = await saveSharedTrack(CONFIG, track);

    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(commands.length).toBe(1);
    expect(urls[0]).toBe(CONFIG.url);
    expect(commands[0]).toEqual([
      "SET",
      `lofi:t:${id}`,
      JSON.stringify(track),
      "EX",
      String(TRACK_TTL_SECONDS),
      "NX",
    ]);
  });

  it("sends the Upstash REST auth header", async () => {
    const calls: Array<RequestInit> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }),
    );

    await saveSharedTrack(CONFIG, cloneTrack());

    expect(calls[0]!.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("retries once with a fresh id on collision (NX miss)", async () => {
    const commands: Array<string[]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        commands.push(JSON.parse(String(init.body)) as string[]);
        // First id collides; the second SET succeeds.
        return new Response(JSON.stringify({ result: commands.length > 1 ? "OK" : null }), { status: 200 });
      }),
    );

    const id = await saveSharedTrack(CONFIG, cloneTrack());

    expect(commands.length).toBe(2);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(commands[0]![1]).not.toBe(commands[1]![1]);
  });

  it("gives up after two collisions", async () => {
    stubUpstash(null);
    expect(await saveSharedTrack(CONFIG, cloneTrack())).toBeNull();
  });

  it("returns null when Upstash answers 200 with an error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "ERR unsupported arg type" }), { status: 200 })),
    );
    expect(await saveSharedTrack(CONFIG, cloneTrack())).toBeNull();
  });
});

describe("loadSharedTrack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads and refreshes the TTL in one pipeline (sliding expiry)", async () => {
    const track = cloneTrack();
    const { commands, urls } = stubUpstash([{ result: JSON.stringify(track) }, { result: 1 }]);

    const loaded = await loadSharedTrack(CONFIG, "a7c0f9e01bd4");

    expect(loaded).toEqual(track);
    expect(commands.length).toBe(1);
    expect(urls[0]).toBe(`${CONFIG.url}/pipeline`);
    expect(commands[0]).toEqual([
      ["GET", "lofi:t:a7c0f9e01bd4"],
      ["EXPIRE", "lofi:t:a7c0f9e01bd4", String(TRACK_TTL_SECONDS)],
    ]);
  });

  it("returns null when the key is gone (expired or never existed)", async () => {
    stubUpstash([{ result: null }, { result: 0 }]);
    expect(await loadSharedTrack(CONFIG, "a7c0f9e01bd4")).toBeNull();
  });

  it("returns null when the cached JSON is corrupted", async () => {
    stubUpstash([{ result: "{not json" }, { result: 1 }]);
    expect(await loadSharedTrack(CONFIG, "a7c0f9e01bd4")).toBeNull();
  });

  it("returns null when the cached payload fails validation", async () => {
    const track = cloneTrack();
    track.tracks.melody[0]!.midi = 999;
    stubUpstash([{ result: JSON.stringify(track) }, { result: 1 }]);
    expect(await loadSharedTrack(CONFIG, "a7c0f9e01bd4")).toBeNull();
  });

  it("returns null when Upstash answers 200 with an error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "ERR unsupported arg type" }), { status: 200 })),
    );
    expect(await loadSharedTrack(CONFIG, "a7c0f9e01bd4")).toBeNull();
  });

  it("returns null on upstream errors", async () => {
    stubUpstash(null, 500);
    expect(await loadSharedTrack(CONFIG, "a7c0f9e01bd4")).toBeNull();
  });
});
