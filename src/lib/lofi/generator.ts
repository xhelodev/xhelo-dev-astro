/**
 * Deterministic lofi composition generator (S4 + S5).
 *
 * `generateLofiTrack(seed)` is pure: every musical decision consumes the
 * seeded PRNG, so the same seed always produces an identical `LofiTrack`.
 * All timing (swing, strum, laid-back snares) is encoded into fractional
 * `startBeat` values; the audio engine and the `.mid` exporter just
 * interpret them.
 */

import type { FxSettings, LofiTrack, NoteEvent, TrackMap } from "./types";
import { chance, createRng, pick } from "./prng";
import {
  DRUM,
  DRUM_TEMPLATES,
  KEYS,
  MODES,
  MAJOR_PROGRESSIONS,
  MINOR_PROGRESSIONS,
  PENTATONICS,
  bassRoot,
  foldToRange,
  voiceChord,
  type DrumTemplate,
  type Mode,
  type Progression,
} from "./theory";

/** Bars per generated loop (4/4). */
const BARS = 4;
/** Beats per bar (4/4). */
const BEATS_PER_BAR = 4;
/** Nominal default FX settings for a fresh track (the UI owns live changes). */
export const DEFAULT_FX: FxSettings = { crackle: true, wobble: true, volume: 0.8 };

/** Milliseconds -> fractional beats at `bpm`. */
function msToBeats(ms: number, bpm: number): number {
  return (ms / 1000) * (bpm / 60);
}

/** ±12% velocity jitter around `base` (S5). */
function jitterVelocity(rng: () => number, base: number): number {
  return clampVelocity(base * (1 + (rng() * 2 - 1) * 0.12));
}

function clampVelocity(v: number): number {
  return Math.min(1, Math.max(0.05, v));
}

/** Swing an off-beat 16th-grid position (S5): 8th off-beats shift late by
 *  (swing - 0.5) * 0.5 beats, 16th off-beats by (swing - 0.5) * 0.25. */
function applySwing(step: number, swing: number): number {
  const pos = step * 0.25;
  if (step % 4 === 2) return pos + (swing - 0.5) * 0.5;
  if (step % 2 === 1) return pos + (swing - 0.5) * 0.25;
  return pos;
}

function note(midi: number, startBeat: number, durationBeats: number, velocity: number): NoteEvent {
  return { midi, startBeat, durationBeats, velocity };
}

function buildChords(rng: () => number, tonicPc: number, bpm: number, progression: Progression): NoteEvent[] {
  const events: NoteEvent[] = [];
  const strumMs = 10 + rng() * 15; // 10-25 ms between chord notes (S5)
  const strumBeats = msToBeats(strumMs, bpm);
  progression.forEach((chord, bar) => {
    const barStart = bar * BEATS_PER_BAR;
    const voicing = voiceChord(tonicPc, chord);
    // Drop the lowest voice half the time for a rootless, lighter voicing
    // (L17: thins the low-mid buildup).
    const tones = voicing.length >= 4 && chance(rng, 0.5) ? voicing.slice(1) : voicing;
    tones.forEach((midi, i) => {
      events.push(note(midi, barStart + i * strumBeats, 3.8, jitterVelocity(rng, 0.45)));
    });
  });
  return events;
}

function buildBass(rng: () => number, tonicPc: number, progression: Progression): NoteEvent[] {
  const events: NoteEvent[] = [];
  progression.forEach((chord, bar) => {
    const barStart = bar * BEATS_PER_BAR;
    const root = bassRoot(tonicPc, chord);
    // Deep sub bass (S5/L17): shorter notes with air between them — the low
    // end breathes instead of droning through the whole bar.
    events.push(note(root, barStart, 1.8, jitterVelocity(rng, 0.55)));
    // Occasional short octave pass at the very end of a bar (folded back
    // into the 36-47 bass register).
    if (chance(rng, 0.25)) {
      events.push(note(foldToRange(root + 12, 36, 47), barStart + 3.5, 0.4, jitterVelocity(rng, 0.35)));
    }
  });
  return events;
}

function buildDrums(rng: () => number, swing: number, bpm: number): NoteEvent[] {
  const events: NoteEvent[] = [];
  const template: DrumTemplate = pick(rng, DRUM_TEMPLATES);
  const snareLatenessBeats = msToBeats(8 + rng() * 7, bpm); // 8-15 ms behind the beat (S5)

  for (let bar = 0; bar < BARS; bar++) {
    const barStart = bar * BEATS_PER_BAR;
    const isLastBar = bar === BARS - 1;

    for (const step of template.kick) {
      events.push(note(DRUM.kick, barStart + applySwing(step, swing), 0.25, jitterVelocity(rng, 0.7)));
    }
    for (const step of template.kickGhosts) {
      if (chance(rng, 0.7)) {
        events.push(note(DRUM.kick, barStart + applySwing(step, swing), 0.2, jitterVelocity(rng, 0.25)));
      }
    }
    // Half-time (S5/L13): the snare sits on beat 3 only, laid back.
    for (const step of template.snare) {
      events.push(note(DRUM.snare, barStart + applySwing(step, swing) + snareLatenessBeats, 0.3, jitterVelocity(rng, 0.6)));
    }
    for (const step of template.snareGhosts) {
      if (chance(rng, 0.5)) {
        events.push(note(DRUM.snare, barStart + applySwing(step, swing) + snareLatenessBeats, 0.2, jitterVelocity(rng, 0.2)));
      }
    }
    // Straight-ish 8th hats; the roll slots become 16th-triplet rolls.
    for (let slot = 0; slot < 8; slot++) {
      const slotStart = barStart + slot * 0.5;
      if (template.hatRolls.includes(slot)) {
        const rollVelocity = jitterVelocity(rng, 0.4);
        for (let k = 0; k < 3; k++) {
          events.push(note(DRUM.closedHat, slotStart + k * (0.5 / 3), 0.12, rollVelocity * (1 - k * 0.2)));
        }
        continue;
      }
      const accent = slot % 2 === 0;
      events.push(note(DRUM.closedHat, slotStart, 0.15, jitterVelocity(rng, accent ? 0.4 : 0.22)));
    }
    for (const step of template.openHat) {
      if (chance(rng, 0.8)) {
        events.push(note(DRUM.openHat, barStart + applySwing(step, swing), 0.4, jitterVelocity(rng, 0.32)));
      }
    }
    // Subtle bar-4 variation (S5): extra ghost kick + ghost rimshot.
    if (isLastBar) {
      events.push(note(DRUM.kick, barStart + applySwing(14, swing), 0.2, jitterVelocity(rng, 0.3)));
      events.push(note(DRUM.snare, barStart + applySwing(7, swing) + snareLatenessBeats, 0.2, jitterVelocity(rng, 0.22)));
    }
  }
  return events;
}

function buildMelody(
  rng: () => number,
  tonicPc: number,
  bpm: number,
  mode: Mode,
  progression: Progression,
): NoteEvent[] {
  const events: NoteEvent[] = [];
  const slots = BARS * 8; // 8th-note slots over the loop
  // 60-70% rests (S5): choose exactly round(slots * density) note slots via a
  // deterministic partial shuffle, so the sparsity is guaranteed.
  const density = 0.3 + rng() * 0.1;
  const noteCount = Math.round(slots * density);
  const order = Array.from({ length: slots }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = order.slice(0, noteCount).sort((a, b) => a - b);
  const pentatonic = PENTATONICS[mode];

  for (const slot of chosen) {
    const bar = Math.floor(slot / 8);
    const chord = progression[bar];
    const fromChordTone = chance(rng, 0.5);
    const interval = fromChordTone
      ? chord.intervals[Math.floor(rng() * chord.intervals.length)]
      : pentatonic[Math.floor(rng() * pentatonic.length)];
    const base = 67 + ((tonicPc + chord.rootOffset) % 12);
    const midi = foldToRange(base + interval, 67, 88);
    const startBeat = slot * 0.5 + msToBeats(rng() * 20, bpm); // gentle humanization
    const durationBeats = 0.5 + rng();
    events.push(note(midi, startBeat, durationBeats, 0.3 + rng() * 0.25));
  }
  return events;
}

/** Generate a deterministic lofi track from a seed string (S4). */
export function generateLofiTrack(seed: string): LofiTrack {
  const rng = createRng(`lofi:${seed}`);

  // Tempo: dreamy/slow, inside the 60-75 spec range (S5/L13).
  const bpm = 62 + Math.floor(rng() * 10);
  const key = pick(rng, KEYS);
  // Minor-leaning identity (S5/L13): aeolian 45%, dorian 35%, major 20%.
  const modeRoll = rng();
  const mode: Mode = modeRoll < 0.45 ? "aeolian" : modeRoll < 0.8 ? "dorian" : "major";
  const swing = 0.5 + rng() * 0.08; // 0.50-0.58, straighter than boom-bap (S5)
  const progression = pick(rng, mode === "major" ? MAJOR_PROGRESSIONS : MINOR_PROGRESSIONS);

  const tracks: TrackMap = {
    chords: buildChords(rng, key.pc, bpm, progression),
    bass: buildBass(rng, key.pc, progression),
    drums: buildDrums(rng, swing, bpm),
    melody: buildMelody(rng, key.pc, bpm, mode, progression),
  };
  for (const name of Object.keys(tracks) as (keyof TrackMap)[]) {
    tracks[name].sort((a, b) => a.startBeat - b.startBeat);
  }

  return {
    seed,
    bpm,
    bars: BARS,
    key: `${key.name} ${mode}`,
    swing,
    tracks,
  };
}
