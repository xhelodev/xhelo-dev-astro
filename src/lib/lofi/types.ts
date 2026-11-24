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

/** The full generated composition. Deterministic for a given seed. */
export interface LofiTrack {
  /** Seed string this track was generated from (URL-shareable). */
  seed: string;
  /** Tempo in BPM, 70–84. */
  bpm: number;
  /** Composition length in 4/4 bars (the generated loop). */
  bars: number;
  /** Human-readable key, e.g. `"F major"`, `"Eb dorian"`. */
  key: string;
  /** Swing amount 0.55–0.62 (0.5 = straight). */
  swing: number;
  tracks: TrackMap;
}
