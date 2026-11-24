/**
 * Shared, engine-agnostic contract for the lofi MIDI generator.
 *
 * This file is FROZEN by the parent (T1). Both consumers — the browser-only
 * Web Audio engine (`audio-engine.ts`) and the `.mid` exporter
 * (`midi-export.ts`) — code against these types. Pure modules (prng, theory,
 * generator) must never import browser APIs.
 */

/** One note in the composition. Times are in fractional beats (not seconds,
 *  not MIDI ticks) so both consumers can interpret tempo themselves. */
export interface NoteEvent {
  /** MIDI note number 0–127. On the `drums` track this is the GM drum map:
   *  36 kick, 38 snare, 42 closed hat, 46 open hat. */
  midi: number;
  /** Start time in fractional beats, 0-based, already swung/humanized. */
  startBeat: number;
  /** Duration in beats, always > 0. */
  durationBeats: number;
  /** Velocity 0.0–1.0 (peak loudness hint for the engine; MIDI export maps it
   *  to 1–127). */
  velocity: number;
}

export type TrackName = "chords" | "bass" | "melody" | "drums";

export type TrackMap = Record<TrackName, NoteEvent[]>;

/** Master FX the audio engine reads; the UI owns them. */
export interface FxSettings {
  /** Master volume 0.0–1.0 — the level the engine reads; the UI owns it. */
  volume: number;
}

/** Synth/timbre presets the 16-bit Web Audio engine can render. */
export const SOUND_PRESETS = [
  "lofi-rhodes",
  "snes-rpg",
  "genesis-fm",
  "synthwave",
  "jazz-warm",
  "bossa-nylon",
  "ambient-pad",
  "trap-dark",
] as const;

export type SoundPreset = (typeof SOUND_PRESETS)[number];

/** The full generated composition. Deterministic for a given seed. */
export interface LofiTrack {
  /** Track display name (generator seed or AI prompt slug) — powers the
   *  `<SEED>.MOD` readout; share links use `?t=<cache id>` instead (S11). */
  seed: string;
  /** Tempo in BPM, 55–120. */
  bpm: number;
  /** Composition length in 4/4 bars (the generated loop). */
  bars: number;
  /** Human-readable key, e.g. `"F major"`, `"Eb dorian"`. */
  key: string;
  /** Swing amount 0.50–0.65 (0.5 = straight). */
  swing: number;
  /** Optional synth/timbre preset chosen for the style; defaults to `"lofi-rhodes"`. */
  preset?: SoundPreset;
  tracks: TrackMap;
}
