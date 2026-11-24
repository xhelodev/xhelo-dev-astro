import { describe, expect, it } from "vitest";
import { buildUserPrompt, compileAiComposition, parseAiComposition } from "./ai-track";

/**
 * Diversity contract (L29): different style prompts (Spanish and English) must
 * produce different music, and every compiled track must stay valid.
 *
 * The model supplies the variation; these tests pin the pipeline around it:
 * - the prompt reaches the model verbatim (different words -> different input);
 * - different compositions compile to different tracks;
 * - the compiler itself is deterministic (variation never comes from jitter);
 * - every fixture compiles to a structurally valid LofiTrack.
 */

interface Fixture {
  prompt: string;
  modelJson: string;
}

const FIXTURES: Fixture[] = [
  {
    prompt: "lluvia melancólica en buenos aires",
    modelJson: JSON.stringify({
      title: "Lluvia Portena",
      key: "D minor",
      bpm: 70,
      swing: 0.57,
      chords: [
        { notes: [50, 57, 60, 64], bass: 38, hits: [0] },
        { notes: [55, 58, 62, 65], bass: 43, hits: [0] },
        { notes: [48, 55, 59, 62], bass: 36, hits: [0] },
        { notes: [53, 57, 60, 65], bass: 41, hits: [0] },
      ],
      melody: [
        { midi: 69, start: 0.5, dur: 1.0, vel: 0.45 },
        { midi: 65, start: 2.0, dur: 0.75, vel: 0.4 },
        { midi: 64, start: 4.5, dur: 1.0, vel: 0.42 },
        { midi: 62, start: 8.0, dur: 1.5, vel: 0.48 },
        { midi: 65, start: 12.0, dur: 1.0, vel: 0.4 },
      ],
      drums: { kick: [0, 10], snare: [4, 12], closedHat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [14] },
    }),
  },
  {
    prompt: "noche de cumbia en la playa",
    modelJson: JSON.stringify({
      title: "Noche Playa",
      key: "A minor",
      bpm: 94,
      swing: 0.54,
      chords: [
        { notes: [57, 60, 64, 67], bass: 45, hits: [0, 1.5, 3] },
        { notes: [52, 55, 60, 64], bass: 40, hits: [0, 1.5, 3] },
        { notes: [55, 59, 62, 67], bass: 43, hits: [0, 2] },
        { notes: [50, 57, 60, 64], bass: 38, hits: [0, 2.5] },
      ],
      melody: [
        { midi: 76, start: 0.5, dur: 0.5, vel: 0.5 },
        { midi: 72, start: 1.5, dur: 0.5, vel: 0.45 },
        { midi: 69, start: 2.5, dur: 0.75, vel: 0.42 },
        { midi: 71, start: 8.0, dur: 0.5, vel: 0.5 },
        { midi: 72, start: 9.5, dur: 0.5, vel: 0.45 },
      ],
      drums: { kick: [0, 3, 6, 8, 11, 14], snare: [4, 12], closedHat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
    }),
  },
  {
    prompt: "sunny beach morning",
    modelJson: JSON.stringify({
      title: "Sunny Shore",
      key: "F major",
      bpm: 82,
      swing: 0.55,
      chords: [
        { notes: [53, 57, 60, 65], bass: 41, hits: [0, 2] },
        { notes: [50, 53, 57, 62], bass: 38, hits: [0, 2] },
        { notes: [55, 59, 62, 67], bass: 43, hits: [0] },
        { notes: [48, 52, 55, 60], bass: 36, hits: [0, 1.5] },
      ],
      melody: [
        { midi: 69, start: 0.0, dur: 1.0, vel: 0.46 },
        { midi: 72, start: 1.5, dur: 0.5, vel: 0.44 },
        { midi: 76, start: 2.5, dur: 1.0, vel: 0.5 },
        { midi: 74, start: 8.0, dur: 0.75, vel: 0.42 },
        { midi: 72, start: 9.5, dur: 1.0, vel: 0.4 },
      ],
      drums: { kick: [0, 8], snare: [4, 12], closedHat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [6, 14] },
    }),
  },
  {
    prompt: "dark cyberpunk alley",
    modelJson: JSON.stringify({
      title: "Neon Alley",
      key: "D minor",
      bpm: 78,
      swing: 0.58,
      chords: [
        { notes: [50, 53, 57, 60], bass: 38, hits: [0] },
        { notes: [50, 53, 57, 60], bass: 38, hits: [0] },
        { notes: [48, 51, 55, 58], bass: 36, hits: [0] },
        { notes: [52, 55, 59, 62], bass: 40, hits: [0] },
      ],
      melody: [
        { midi: 62, start: 0.5, dur: 0.5, vel: 0.38 },
        { midi: 65, start: 1.0, dur: 0.5, vel: 0.36 },
        { midi: 64, start: 2.0, dur: 0.75, vel: 0.4 },
        { midi: 60, start: 8.5, dur: 1.0, vel: 0.42 },
        { midi: 62, start: 12.0, dur: 1.5, vel: 0.44 },
      ],
      drums: { kick: [0, 6, 10], snare: [4, 12], closedHat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [14] },
    }),
  },
];

const DRUM_GM = new Set([36, 38, 42, 46]);

function compileFixture(f: Fixture) {
  return compileAiComposition(parseAiComposition(f.modelJson, f.prompt));
}

function musicalFingerprint(t: ReturnType<typeof compileAiComposition>): string {
  return JSON.stringify([t.bpm, t.key, t.swing, t.tracks]);
}

describe("AI track diversity (ES/EN prompts)", () => {
  it("sends Spanish and English prompts verbatim into different user messages", () => {
    const es = buildUserPrompt("lluvia melancólica en buenos aires");
    const en = buildUserPrompt("sunny beach morning");
    expect(es).toContain("lluvia melancólica en buenos aires");
    expect(en).toContain("sunny beach morning");
    expect(es).not.toBe(en);
    for (const f of FIXTURES) {
      expect(buildUserPrompt(f.prompt)).toContain(f.prompt);
    }
  });

  it("compiles different compositions into different music (pairwise distinct)", () => {
    const fingerprints = FIXTURES.map((f) => musicalFingerprint(compileFixture(f)));
    for (let i = 0; i < fingerprints.length; i++) {
      for (let j = i + 1; j < fingerprints.length; j++) {
        expect(fingerprints[i]).not.toBe(fingerprints[j]);
      }
    }
    // Diversity must be musical, not just titles: at least three of the four
    // fixtures differ on bpm, key, or swing compared with the first one.
    const first = compileFixture(FIXTURES[0]);
    let differingAxes = 0;
    for (const f of FIXTURES.slice(1)) {
      const t = compileFixture(f);
      if (t.bpm !== first.bpm || t.key !== first.key || t.swing !== first.swing) differingAxes++;
    }
    expect(differingAxes).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic for a given composition — variation comes from the model, not the compiler", () => {
    for (const f of FIXTURES) {
      const a = compileAiComposition(parseAiComposition(f.modelJson, f.prompt));
      const b = compileAiComposition(parseAiComposition(f.modelJson, f.prompt));
      expect(a).toEqual(b);
    }
  });

  it("every fixture compiles to a structurally valid track", () => {
    for (const f of FIXTURES) {
      const t = compileFixture(f);
      expect(t.bars).toBe(4);
      expect(t.bpm).toBeGreaterThanOrEqual(55);
      expect(t.bpm).toBeLessThanOrEqual(120);
      expect(t.swing).toBeGreaterThanOrEqual(0.5);
      expect(t.swing).toBeLessThanOrEqual(0.65);
      expect(t.seed.length).toBeGreaterThan(0);
      expect(t.key.length).toBeGreaterThan(0);
      expect(t.tracks.chords.length).toBeGreaterThan(0);
      expect(t.tracks.bass.length).toBeGreaterThanOrEqual(4);
      expect(t.tracks.melody.length).toBeGreaterThan(0);

      for (const e of t.tracks.chords) {
        expect(e.midi).toBeGreaterThanOrEqual(48);
        expect(e.midi).toBeLessThanOrEqual(76);
      }
      for (const e of t.tracks.bass) {
        expect(e.midi).toBeGreaterThanOrEqual(36);
        expect(e.midi).toBeLessThanOrEqual(47);
      }
      for (const e of t.tracks.melody) {
        expect(e.midi).toBeGreaterThanOrEqual(55);
        expect(e.midi).toBeLessThanOrEqual(86);
      }
      for (const e of t.tracks.drums) {
        expect(DRUM_GM.has(e.midi)).toBe(true);
      }
      for (const events of Object.values(t.tracks)) {
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          expect(e.startBeat).toBeGreaterThanOrEqual(0);
          expect(e.startBeat).toBeLessThan(16);
          expect(e.durationBeats).toBeGreaterThan(0);
          expect(e.velocity).toBeGreaterThan(0);
          expect(e.velocity).toBeLessThanOrEqual(1);
          if (i > 0) expect(e.startBeat).toBeGreaterThanOrEqual(events[i - 1].startBeat);
        }
      }
    }
  });
});
