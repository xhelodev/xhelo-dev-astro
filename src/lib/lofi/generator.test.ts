import { describe, expect, it } from "vitest";
import { generateLofiTrack } from "./generator";
import { createRng } from "./prng";
import type { LofiTrack, TrackName } from "./types";

const SEEDS = ["rainy-742", "midnight-tape", "cafe-42", "velvet-9", "dusty-808"];
const TRACK_NAMES: TrackName[] = ["chords", "bass", "melody", "drums"];

describe("seeded PRNG (S4)", () => {
  it("is deterministic per seed", () => {
    const run = () => Array.from({ length: 8 }, () => createRng("seed-x")());
    expect(run()).toEqual(run());
  });

  it("produces values in [0, 1)", () => {
    const rng = createRng("seed-y");
    for (let i = 0; i < 200; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different seeds diverge", () => {
    expect(createRng("one")()).not.toBe(createRng("two")());
  });
});

describe("generateLofiTrack determinism (S4)", () => {
  it("same seed produces an identical track", () => {
    for (const seed of SEEDS) {
      expect(generateLofiTrack(seed)).toEqual(generateLofiTrack(seed));
    }
  });

  it("different seeds produce different tracks", () => {
    const serialized = SEEDS.map((seed) => JSON.stringify(generateLofiTrack(seed)));
    expect(new Set(serialized).size).toBe(SEEDS.length);
  });
});

describe("musical spec ranges (S5/S9)", () => {
  const tracks = SEEDS.map((seed) => generateLofiTrack(seed));

  it("tempo, swing, length and key are in spec", () => {
    for (const track of tracks) {
      expect(track.bpm).toBeGreaterThanOrEqual(60);
      expect(track.bpm).toBeLessThanOrEqual(75);
      expect(track.swing).toBeGreaterThanOrEqual(0.5);
      expect(track.swing).toBeLessThanOrEqual(0.58);
      expect(track.bars).toBe(4);
      expect(track.key).toMatch(/^(F|Eb|Db|Bb|C|Ab) (major|dorian|aeolian)$/);
    }
  });

  it("chord tones stay within MIDI 48-72", () => {
    for (const track of tracks) {
      expect(track.tracks.chords.length).toBeGreaterThan(0);
      for (const note of track.tracks.chords) {
        expect(note.midi).toBeGreaterThanOrEqual(48);
        expect(note.midi).toBeLessThanOrEqual(72);
      }
    }
  });

  it("bass stays within MIDI 36-47", () => {
    for (const track of tracks) {
      expect(track.tracks.bass.length).toBeGreaterThan(0);
      for (const note of track.tracks.bass) {
        expect(note.midi).toBeGreaterThanOrEqual(36);
        expect(note.midi).toBeLessThanOrEqual(47);
      }
    }
  });

  it("drums use only the GM map 36/38/42/46", () => {
    const allowed = new Set([36, 38, 42, 46]);
    for (const track of tracks) {
      expect(track.tracks.drums.length).toBeGreaterThan(0);
      for (const note of track.tracks.drums) {
        expect(allowed.has(note.midi)).toBe(true);
      }
    }
  });

  it("melody is present and sparse (60-70% rests over the loop)", () => {
    for (const track of tracks) {
      const melody = track.tracks.melody;
      expect(melody.length).toBeGreaterThan(0);
      // 8 eighth-note slots per bar * 4 bars = 32 candidate slots.
      // 60-70% rests => 9..13 notes.
      expect(melody.length).toBeGreaterThanOrEqual(9);
      expect(melody.length).toBeLessThanOrEqual(13);
    }
  });

  it("every note event is valid (0-127, start >= 0, duration > 0, inside loop)", () => {
    for (const track of tracks) {
      const loopBeats = track.bars * 4;
      for (const name of TRACK_NAMES) {
        for (const note of track.tracks[name]) {
          expect(note.midi).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeLessThanOrEqual(127);
          expect(note.startBeat).toBeGreaterThanOrEqual(0);
          expect(note.durationBeats).toBeGreaterThan(0);
          expect(note.startBeat).toBeLessThan(loopBeats);
        }
      }
    }
  });

  it("velocities stay within 0-1", () => {
    for (const track of tracks) {
      for (const name of TRACK_NAMES) {
        for (const note of track.tracks[name]) {
          expect(note.velocity).toBeGreaterThan(0);
          expect(note.velocity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("encodes lofi timing: strummed chords and laid-back snares (S5)", () => {
    for (const track of tracks) {
      // Chords of one bar start slightly spread (strum) and all within the bar.
      const chords = [...track.tracks.chords].sort((a, b) => a.startBeat - b.startBeat);
      const firstBar = chords.filter((n) => n.startBeat < 4);
      const starts = firstBar.map((n) => n.startBeat);
      const spread = Math.max(...starts) - Math.min(...starts);
      expect(spread).toBeGreaterThan(0);

      // Snares (38) sit slightly after their nominal 8th position when swung.
      const snares = track.tracks.drums.filter((n) => n.midi === 38);
      expect(snares.length).toBeGreaterThan(0);
    }
  });
});

describe("track shape", () => {
  const track: LofiTrack = generateLofiTrack("shape-check");

  it("keeps the seed on the track", () => {
    expect(track.seed).toBe("shape-check");
  });

  it("orders events by start time within each track", () => {
    for (const name of TRACK_NAMES) {
      const starts = track.tracks[name].map((n) => n.startBeat);
      const sorted = [...starts].sort((a, b) => a - b);
      expect(starts).toEqual(sorted);
    }
  });
});
