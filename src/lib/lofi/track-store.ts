/**
 * Server-side shared-track cache (S11/T18): strict validation of untrusted
 * `LofiTrack` payloads, short share ids, and a thin Upstash Redis REST client
 * with a sliding TTL.
 *
 * Server-only: imported by the API routes (`src/pages/api/tracks*`), never by
 * client code — the client only needs the id pattern, kept inline there.
 */
import { SOUND_PRESETS, type LofiTrack, type NoteEvent, type TrackMap } from "./types";

/** Sliding TTL: a track nobody reads for 7 days is evicted; every read
 *  refreshes the expiry. */
export const TRACK_TTL_SECONDS = 7 * 24 * 60 * 60;

const TRACK_ID_PATTERN = /^[0-9a-f]{12}$/;
const DRUM_MIDI = new Set([36, 38, 42, 46]);
const LANES: Array<keyof TrackMap> = ["chords", "bass", "melody", "drums"];
const MAX_EVENTS_PER_LANE = 512;
const MAX_SEED_CHARS = 64;
const MAX_KEY_CHARS = 32;
const BPM_MIN = 55;
const BPM_MAX = 120;
const BARS_MAX = 32;
const SWING_MIN = 0.5;
const SWING_MAX = 0.65;

export function trackKey(id: string): string {
  return `lofi:t:${id}`;
}

/** 12 hex chars (48 bits): enough uniqueness at sharing scale, short in URLs. */
export function newTrackId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isTrackId(value: unknown): value is string {
  return typeof value === "string" && TRACK_ID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidEvent(event: unknown, drums: boolean): event is NoteEvent {
  if (event === null || typeof event !== "object") return false;
  const ev = event as Record<string, unknown>;
  if (!Number.isInteger(ev.midi) || (ev.midi as number) < 0 || (ev.midi as number) > 127) return false;
  if (drums && !DRUM_MIDI.has(ev.midi as number)) return false;
  if (!isFiniteNumber(ev.startBeat) || ev.startBeat < 0) return false;
  if (!isFiniteNumber(ev.durationBeats) || ev.durationBeats <= 0) return false;
  if (!isFiniteNumber(ev.velocity) || ev.velocity < 0 || ev.velocity > 1) return false;
  return true;
}

/**
 * Validates an untrusted `LofiTrack` (client JSON or cached JSON) against the
 * contract bounds and rebuilds it with only the known fields. Returns null on
 * any violation — the caller answers 400/404 instead of storing or serving.
 */
export function validateLofiTrack(input: unknown): LofiTrack | null {
  if (input === null || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  if (typeof raw.seed !== "string" || raw.seed.length === 0 || raw.seed.length > MAX_SEED_CHARS) return null;
  if (!isFiniteNumber(raw.bpm) || raw.bpm < BPM_MIN || raw.bpm > BPM_MAX) return null;
  if (!Number.isInteger(raw.bars) || (raw.bars as number) < 1 || (raw.bars as number) > BARS_MAX) return null;
  if (typeof raw.key !== "string" || raw.key.length === 0 || raw.key.length > MAX_KEY_CHARS) return null;
  if (!isFiniteNumber(raw.swing) || raw.swing < SWING_MIN || raw.swing > SWING_MAX) return null;
  if (raw.preset !== undefined && !(SOUND_PRESETS as readonly string[]).includes(String(raw.preset))) return null;

  if (raw.tracks === null || typeof raw.tracks !== "object") return null;
  const lanes = raw.tracks as Record<string, unknown>;
  const tracks: TrackMap = {} as TrackMap;
  for (const lane of LANES) {
    const events = lanes[lane];
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_LANE) return null;
    for (const event of events) {
      if (!isValidEvent(event, lane === "drums")) return null;
    }
    tracks[lane] = events as NoteEvent[];
  }

  const validated: LofiTrack = {
    seed: raw.seed,
    bpm: raw.bpm,
    bars: raw.bars as number,
    key: raw.key,
    swing: raw.swing,
    tracks,
  };
  if (raw.preset !== undefined) validated.preset = raw.preset as LofiTrack["preset"];
  return validated;
}

// ---- Upstash Redis REST client (zero dependencies) -------------------------

export interface UpstashConfig {
  url: string;
  token: string;
}

export function getUpstashConfig(): UpstashConfig | null {
  const url = (import.meta.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (import.meta.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  if (!url || !token) return null;
  return { url, token };
}

/** Runs one REST request against `config.url + path`; null on any
 *  transport failure, non-2xx status, or command error. Upstash answers
 *  command errors as HTTP 200 + {"error": ...} — those are logged, never
 *  swallowed silently (a silent null here reads as "track expired" to the
 *  caller). */
async function upstashRequest(config: UpstashConfig, path: string, body: string): Promise<unknown> {
  const label = path || "/";
  try {
    const res = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[track-store] Upstash ${label} failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) return data; // /pipeline: one {result} object per command
    const record = data as { result?: unknown; error?: string } | null;
    if (record && typeof record === "object" && typeof record.error === "string") {
      console.error(`[track-store] Upstash ${label} command error: ${record.error}`);
      return null;
    }
    return record?.result ?? null;
  } catch (err) {
    console.error(`[track-store] Upstash ${label} request failed:`, err);
    return null;
  }
}

export async function upstashCommand<T>(config: UpstashConfig, command: string[]): Promise<T | null> {
  return (await upstashRequest(config, "", JSON.stringify(command))) as T | null;
}

/** Pipelines POST to `/pipeline` (the root endpoint rejects array-of-array
 *  bodies with `ERR unsupported arg type`) and answer with a bare array of
 *  per-command `{ result }` objects. */
export async function upstashPipeline(
  config: UpstashConfig,
  commands: string[][],
): Promise<Array<{ result?: unknown }> | null> {
  const data = await upstashRequest(config, "/pipeline", JSON.stringify(commands));
  if (!Array.isArray(data)) return null;
  return data as Array<{ result?: unknown }>;
}

// ---- Share operations ------------------------------------------------------

/** Stores a validated track with a fresh id (`SET ... EX TTL NX`); retries once
 *  on an id collision (NX miss). Returns the id or null. */
export async function saveSharedTrack(config: UpstashConfig, track: LofiTrack): Promise<string | null> {
  const json = JSON.stringify(track);
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = newTrackId();
    const ok = await upstashCommand<string>(config, [
      "SET",
      trackKey(id),
      json,
      "EX",
      String(TRACK_TTL_SECONDS),
      "NX",
    ]);
    if (ok === "OK") return id;
  }
  return null;
}

/** Loads a shared track and slides its TTL forward in one pipeline
 *  (`GET` + `EXPIRE`). Null when missing/expired, corrupted, or invalid. */
export async function loadSharedTrack(config: UpstashConfig, id: string): Promise<LofiTrack | null> {
  const key = trackKey(id);
  const results = await upstashPipeline(config, [
    ["GET", key],
    ["EXPIRE", key, String(TRACK_TTL_SECONDS)],
  ]);
  const stored = results?.[0]?.result ?? null;
  if (typeof stored !== "string") return null;
  try {
    return validateLofiTrack(JSON.parse(stored));
  } catch {
    return null;
  }
}
