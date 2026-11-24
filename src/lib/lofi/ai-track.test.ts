import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_LENGTH,
  buildUserPrompt,
  compileAiComposition,
  parseAiComposition,
  sanitizePrompt,
} from "./ai-track";
import { SOUND_PRESETS } from "./types";
import { getPresetConfig } from "./presets";

const VALID_JSON = JSON.stringify({
  title: "Bossa Lluvia",
  key: "F major",
  bpm: 88,
  swing: 0.52,
  chords: [
    { notes: [53, 57, 60, 64, 67], bass: 41, hits: [0, 1.5, 3] },
    { notes: [50, 53, 57, 60, 64], bass: 38, hits: [0, 1.5, 3] },
    { notes: [55, 58, 62, 65], bass: 43, hits: [0, 2] },
    { notes: [48, 52, 55, 58, 62], bass: 36, hits: [0, 2.5] },
  ],
  melody: [
    { midi: 69, start: 0.5, dur: 1.0, vel: 0.45 },
    { midi: 72, start: 2.0, dur: 1.5, vel: 0.5 },
    { midi: 74, start: 8.5, dur: 1.0, vel: 0.42 },
  ],
  drums: {
    kick: [0, 6, 8, 14],
    snare: [4, 12],
    closedHat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [14],
  },
});

describe("ai-track", () => {
  it("sanitizes and caps prompts to MAX_PROMPT_LENGTH", () => {
    const longPrompt = `  bossa   nova\n\t${"a".repeat(200)}  `;
    const cleaned = sanitizePrompt(longPrompt);
    expect(cleaned.length).toBe(MAX_PROMPT_LENGTH);
    expect(cleaned.startsWith("bossa nova a")).toBe(true);
  });

  it("parses JSON wrapped in markdown fences and compiles a valid LofiTrack", () => {
    const wrapped = "```json\n" + VALID_JSON + "\n```";
    const comp = parseAiComposition(wrapped, "bossa nova lluviosa");
    const track = compileAiComposition(comp);

    expect(track.seed).toBe("Bossa Lluvia");
    expect(track.bpm).toBe(88);
    expect(track.bars).toBe(4);
    expect(track.key).toBe("F major");
    expect(track.tracks.chords.length).toBeGreaterThan(0);
    expect(track.tracks.bass.length).toBeGreaterThanOrEqual(4);
    expect(track.tracks.melody).toHaveLength(3);
    expect(track.tracks.drums.length).toBeGreaterThan(0);

    for (const events of Object.values(track.tracks)) {
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
  });

  it("clamps out-of-range bpm, swing, midi pitches, and pads short chord arrays", () => {
    const raw = JSON.stringify({
      title: "!!!",
      key: "",
      bpm: 999,
      swing: 0.99,
      chords: [{ notes: [20, 120], bass: 99 }],
      melody: [{ midi: 110, start: 15.5, dur: 10, vel: 5 }],
      drums: { kick: [-1, 0, 20], snare: [], closedHat: [] },
    });
    const comp = parseAiComposition(raw, "ambient space");
    expect(comp.bpm).toBe(120);
    expect(comp.swing).toBe(0.65);
    expect(comp.title).toBe("ambient space");
    expect(comp.chords).toHaveLength(4);
    expect(comp.chords[0].bass).toBeGreaterThanOrEqual(36);
    expect(comp.chords[0].bass).toBeLessThanOrEqual(47);
    expect(comp.melody[0].dur).toBeCloseTo(0.5);
    expect(comp.drums.kick).toEqual([0]);
  });

  it("clamps extreme numeric MIDI values without hanging foldToRange", () => {
    const raw = JSON.stringify({
      title: "Extreme",
      key: "C minor",
      bpm: 75,
      swing: 0.55,
      chords: [{ notes: [1e20, -1e20], bass: 1e20 }],
      melody: [{ midi: -1e20, start: 0, dur: 1 }],
      drums: { kick: [0], snare: [8], closedHat: [] },
    });
    const comp = parseAiComposition(raw, "extreme");
    expect(comp.chords[0].notes.every((n) => n >= 48 && n <= 76)).toBe(true);
    expect(comp.chords[0].bass).toBeGreaterThanOrEqual(36);
    expect(comp.chords[0].bass).toBeLessThanOrEqual(47);
    expect(comp.melody[0].midi).toBeGreaterThanOrEqual(55);
    expect(comp.melody[0].midi).toBeLessThanOrEqual(86);
  });

  it("rejects malformed JSON or missing chords", () => {
    expect(() => parseAiComposition("not json", "jazz")).toThrow(/Invalid JSON/);
    expect(() => parseAiComposition(JSON.stringify({ chords: [] }), "jazz")).toThrow(/chords/);
  });

  it("parses and propagates sound presets with fallback to lofi-rhodes", () => {
    const withPreset = JSON.stringify({ ...JSON.parse(VALID_JSON), preset: "snes-rpg" });
    const comp = parseAiComposition(withPreset, "chrono trigger town");
    expect(comp.preset).toBe("snes-rpg");
    expect(compileAiComposition(comp).preset).toBe("snes-rpg");

    const withGenesis = JSON.stringify({ ...JSON.parse(VALID_JSON), preset: "16-bit arcade" });
    expect(parseAiComposition(withGenesis, "arcade").preset).toBe("genesis-fm");

    const withSnesAlias = JSON.stringify({ ...JSON.parse(VALID_JSON), preset: "rpg" });
    expect(parseAiComposition(withSnesAlias, "fantasy village").preset).toBe("snes-rpg");

    const withoutPreset = parseAiComposition(VALID_JSON, "rainy day");
    expect(withoutPreset.preset).toBe("lofi-rhodes");
    expect(compileAiComposition(withoutPreset).preset).toBe("lofi-rhodes");
  });

  it("does not force lofi in buildUserPrompt when another style is requested", () => {
    const prompt = buildUserPrompt("80s synthwave arcade");
    expect(prompt.toLowerCase()).toContain("80s synthwave arcade");
    expect(prompt.toLowerCase()).not.toContain("lofi");
  });

  it("supports optional bar4 drum variation in compileAiComposition", () => {
    const base = JSON.parse(VALID_JSON);
    base.drums.bar4 = {
      kick: [0, 6, 8, 12, 14],
      snare: [4, 10, 12, 14, 15],
      closedHat: [0, 2, 4, 6],
      openHat: [12],
    };
    const track = compileAiComposition(parseAiComposition(JSON.stringify(base), "funky"));
    const bar1Snares = track.tracks.drums.filter((e) => e.startBeat < 4 && e.midi === 38);
    const bar4Snares = track.tracks.drums.filter((e) => e.startBeat >= 12 && e.midi === 38);
    expect(bar1Snares).toHaveLength(2);
    expect(bar4Snares).toHaveLength(5);
  });

  it("defines distinct, safe DSP configs for every SoundPreset", () => {
    expect(SOUND_PRESETS).toContain("snes-rpg");
    expect(SOUND_PRESETS).toContain("genesis-fm");
    const configs = SOUND_PRESETS.map((p) => getPresetConfig(p));
    const signatures = new Set(
      configs.map(
        (c) =>
          `${c.chord.wave}:${c.melody.wave}:${c.bass.wave}:${c.bass.fmIndex}:${c.masterLowpassHz}:${c.reverbSend}:${c.echoSend}`,
      ),
    );
    expect(signatures.size).toBe(SOUND_PRESETS.length);
    for (const c of configs) {
      expect(c.masterLowpassHz).toBeGreaterThanOrEqual(1500);
      expect(c.masterLowpassHz).toBeLessThanOrEqual(16000);
      expect(c.reverbSend).toBeGreaterThanOrEqual(0);
      expect(c.reverbSend).toBeLessThanOrEqual(0.6);
      expect(c.echoSend).toBeGreaterThanOrEqual(0);
      expect(c.echoSend).toBeLessThanOrEqual(0.5);
      expect(c.echoFeedback).toBeGreaterThanOrEqual(0);
      expect(c.echoFeedback).toBeLessThanOrEqual(0.5);
      expect(c.duckAmount).toBeGreaterThanOrEqual(0.3);
      expect(c.duckAmount).toBeLessThanOrEqual(1);
    }
  });
});
