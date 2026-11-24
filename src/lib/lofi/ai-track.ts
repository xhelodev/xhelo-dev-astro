/**
 * AI-generated lofi composition schema, prompt builder, and compiler.
 *
 * Pure module (no browser or Node-only APIs). Converts a compact musical JSON
 * response from an LLM into a validated, engine-ready `LofiTrack`.
 */

import { SOUND_PRESETS, type LofiTrack, type NoteEvent, type SoundPreset, type TrackMap } from "./types";
import { DRUM, foldToRange } from "./theory";

export const MAX_PROMPT_LENGTH = 140;
const BARS = 4;
const BEATS_PER_BAR = 4;
const TOTAL_BEATS = BARS * BEATS_PER_BAR;

export interface AiChordBar {
  /** Chord MIDI pitches (3–5 notes). */
  notes: number[];
  /** Bass root MIDI pitch (folded to 36–47). */
  bass: number;
  /** Optional beat offsets within the bar (0–3.75) for chord comping rhythm. */
  hits?: number[];
}

export interface AiMelodyNote {
  midi: number;
  start: number;
  dur: number;
  vel?: number;
}

export interface AiDrumBar {
  kick: number[];
  snare: number[];
  closedHat: number[];
  openHat?: number[];
}

export interface AiDrumPattern extends AiDrumBar {
  /** Optional bar-4 fill/variation pattern overriding bars 1-3 on the last bar. */
  bar4?: Partial<AiDrumBar>;
}

export interface AiComposition {
  title: string;
  key: string;
  bpm: number;
  swing: number;
  preset: SoundPreset;
  chords: AiChordBar[];
  melody: AiMelodyNote[];
  drums: AiDrumPattern;
}

export const SYSTEM_PROMPT = `You are a versatile 16-bit / MIDI composer. Given a user's style or mood prompt, compose a cohesive, musical 4-bar loop in 4/4 (16 beats total) for a 4-track 16-bit Web Audio synthesizer (chords, bass, melody, drums) and pick the best matching synth preset.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "title": "SHORT TITLE (1-3 words, ASCII)",
  "key": "<tonic> <mode/scale>",
  "bpm": <integer 55-120>,
  "swing": <number 0.50-0.65>,
  "preset": "lofi-rhodes" | "snes-rpg" | "genesis-fm" | "synthwave" | "jazz-warm" | "bossa-nylon" | "ambient-pad" | "trap-dark",
  "chords": [
    { "notes": [<3-5 MIDI ints 48-76>], "bass": <MIDI int 36-47>, "hits": [<beat offsets 0-3.75>] }
  ],
  "melody": [
    { "midi": <MIDI int 60-84>, "start": <beat 0-15.75>, "dur": <beats 0.15-4>, "vel": <0.1-0.9> }
  ],
  "drums": {
    "kick": [<16th steps 0-15>],
    "snare": [<16th steps 0-15>],
    "closedHat": [<16th steps 0-15>],
    "openHat": [<16th steps 0-15>],
    "bar4": { "kick": [...], "snare": [...], "closedHat": [...], "openHat": [...] }
  }
}

Preset guide (ALWAYS choose the preset that genuinely fits the user's prompt):
- "lofi-rhodes": chill lofi, rainy study beats, bedroom pop, nostalgic chillhop
- "snes-rpg": SNES / 16-bit RPG, Chrono Trigger / Donkey Kong vibe, fantasy village, nostalgic game, dreamy strings + echo
- "genesis-fm": Sega Genesis / Mega Drive, 16-bit arcade, action game, upbeat retro FM slap bass + brass, 8-bit/chip
- "synthwave": synthwave, cyberpunk, 80s retro, outrun, electronic, neon, disco
- "jazz-warm": jazz, neo-soul, cafe, midnight lounge, swing
- "bossa-nylon": bossa nova, latin, cumbia, salsa, tropical, beach, acoustic guitar
- "ambient-pad": ambient, space, dreamy, meditation, cinematic, ethereal
- "trap-dark": trap, dark hip-hop, phonk, moody urban, heavy 808

Musical rules:
- Provide exactly 4 chord bars tailored to the requested genre (different keys, voicings, and chord comping hits — e.g. syncopated hits for bossa/cumbia/funk, pulsing 8ths for synthwave/genesis, [0] for dreamy pads/RPG).
- Match tempo and groove strictly to the genre: e.g. ambient 55-68, lofi/trap 65-82, snes-rpg 75-100, bossa/cumbia 88-105, synthwave/genesis-fm 100-120.
- Melody MUST sound intentional: write a singable 2-bar motif (beats 0-8) and answer/vary it in bars 3-4 (beats 8-16). Favor stepwise motion, chord tones on strong beats, and 12-26 notes total across 16 beats.
- Include a subtle "bar4" drum fill/variation when drums are used (empty drum arrays allowed for ambient/drumless).
- Chord notes in MIDI 48-76, bass in MIDI 36-47, melody in MIDI 60-84. Drum steps are integers 0-15.`;

export function buildUserPrompt(rawPrompt: string): string {
  const cleaned = sanitizePrompt(rawPrompt);
  return `Compose a 4-bar MIDI loop matching this exact style and mood: "${cleaned}"`;
}

export function sanitizePrompt(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LENGTH);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function applySwing(step: number, swing: number): number {
  const pos = step * 0.25;
  if (step % 4 === 2) return pos + (swing - 0.5) * 0.5;
  if (step % 2 === 1) return pos + (swing - 0.5) * 0.25;
  return pos;
}

function cleanAsciiLabel(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function sanitizeTitle(title: unknown, fallbackPrompt: string): string {
  const fromTitle = typeof title === "string" ? cleanAsciiLabel(title) : "";
  if (fromTitle.length > 0) return fromTitle;
  const fromPrompt = cleanAsciiLabel(fallbackPrompt);
  return fromPrompt.length > 0 ? fromPrompt : "AI LOFI";
}

const PRESET_SET = new Set<string>(SOUND_PRESETS);

function parsePreset(raw: unknown): SoundPreset {
  if (typeof raw !== "string") return "lofi-rhodes";
  const normalized = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (PRESET_SET.has(normalized)) return normalized as SoundPreset;
  if (/snes|rpg|chrono|zelda|fantasy|spc/.test(normalized)) return "snes-rpg";
  if (/genesis|mega-?drive|16-?bit|8-?bit|chip|arcade|nes|retro-?game|pixel|ym2612|fm/.test(normalized)) return "genesis-fm";
  if (/synth|cyber|outrun|neon|vapor|electro|disco|wave/.test(normalized)) return "synthwave";
  if (/jazz|soul|lounge|cafe|wurlitzer/.test(normalized)) return "jazz-warm";
  if (/bossa|nylon|latin|cumbia|salsa|tropical|guitar|acoustic|samba/.test(normalized)) return "bossa-nylon";
  if (/ambient|pad|space|dream|medit|ethereal|cinematic/.test(normalized)) return "ambient-pad";
  if (/trap|dark|phonk|808|drill|hip-?hop/.test(normalized)) return "trap-dark";
  return "lofi-rhodes";
}

function parseSteps(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  const unique = new Set<number>();
  for (const item of arr) {
    const n = toFiniteNumber(item);
    if (n !== null) {
      const step = Math.round(n);
      if (step >= 0 && step <= 15) unique.add(step);
    }
  }
  return [...unique].sort((a, b) => a - b);
}

function safeFoldMidi(raw: number, lo: number, hi: number): number {
  return foldToRange(clamp(Math.round(raw), 0, 127), lo, hi);
}

function parseChordBar(raw: unknown): AiChordBar | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.notes)) return null;
  const notes = obj.notes
    .map(toFiniteNumber)
    .filter((n): n is number => n !== null)
    .map((n) => safeFoldMidi(n, 48, 76));
  const uniqueNotes = [...new Set(notes)].sort((a, b) => a - b).slice(0, 6);
  if (uniqueNotes.length === 0) return null;

  const rawBass = toFiniteNumber(obj.bass);
  const bass = safeFoldMidi(rawBass ?? uniqueNotes[0], 36, 47);

  let hits: number[] | undefined;
  if (Array.isArray(obj.hits)) {
    const parsedHits = obj.hits
      .map(toFiniteNumber)
      .filter((n): n is number => n !== null && n >= 0 && n < BEATS_PER_BAR)
      .sort((a, b) => a - b);
    if (parsedHits.length > 0) hits = [...new Set(parsedHits)].slice(0, 8);
  }

  return { notes: uniqueNotes, bass, hits };
}

/** Parse and validate raw LLM text into a normalized `AiComposition`. */
export function parseAiComposition(rawText: string, fallbackPrompt: string): AiComposition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(rawText));
  } catch {
    throw new Error("Invalid JSON returned by model");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model response must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const rawChords = Array.isArray(obj.chords) ? obj.chords.map(parseChordBar).filter((c): c is AiChordBar => c !== null) : [];
  if (rawChords.length === 0) {
    throw new Error("Model response missing valid chords");
  }
  // Ensure exactly 4 bars by repeating or slicing cleanly.
  const chords: AiChordBar[] = [];
  for (let i = 0; i < BARS; i++) {
    chords.push(rawChords[i % rawChords.length]);
  }

  const melody: AiMelodyNote[] = [];
  if (Array.isArray(obj.melody)) {
    for (const item of obj.melody) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const midi = toFiniteNumber(m.midi);
      const start = toFiniteNumber(m.start);
      const dur = toFiniteNumber(m.dur);
      if (midi === null || start === null || dur === null) continue;
      if (start < 0 || start >= TOTAL_BEATS) continue;
      const vel = toFiniteNumber(m.vel);
      melody.push({
        midi: safeFoldMidi(midi, 55, 86),
        start,
        dur: clamp(dur, 0.15, Math.min(4, TOTAL_BEATS - start)),
        vel: vel !== null ? clamp(vel, 0.1, 0.9) : 0.4,
      });
    }
  }

  const rawDrums = obj.drums && typeof obj.drums === "object" ? (obj.drums as Record<string, unknown>) : {};
  const rawBar4 =
    rawDrums.bar4 && typeof rawDrums.bar4 === "object" ? (rawDrums.bar4 as Record<string, unknown>) : null;
  const bar4: Partial<AiDrumBar> | undefined = rawBar4
    ? {
        ...(Array.isArray(rawBar4.kick) ? { kick: parseSteps(rawBar4.kick) } : {}),
        ...(Array.isArray(rawBar4.snare) ? { snare: parseSteps(rawBar4.snare) } : {}),
        ...(Array.isArray(rawBar4.closedHat) ? { closedHat: parseSteps(rawBar4.closedHat) } : {}),
        ...(Array.isArray(rawBar4.openHat) ? { openHat: parseSteps(rawBar4.openHat) } : {}),
      }
    : undefined;
  const drums: AiDrumPattern = {
    kick: parseSteps(rawDrums.kick),
    snare: parseSteps(rawDrums.snare),
    closedHat: parseSteps(rawDrums.closedHat),
    openHat: parseSteps(rawDrums.openHat),
    ...(bar4 && Object.keys(bar4).length > 0 ? { bar4 } : {}),
  };

  const bpm = Math.round(clamp(toFiniteNumber(obj.bpm) ?? 74, 55, 120));
  const swing = Number(clamp(toFiniteNumber(obj.swing) ?? 0.55, 0.5, 0.65).toFixed(3));
  const key =
    typeof obj.key === "string" && obj.key.trim().length > 0
      ? obj.key.trim().slice(0, 24)
      : "C minor";
  const preset = parsePreset(obj.preset);

  return {
    title: sanitizeTitle(obj.title, fallbackPrompt),
    key,
    bpm,
    swing,
    preset,
    chords,
    melody: melody.slice(0, 64),
    drums,
  };
}

/** Compile a validated `AiComposition` into a playable `LofiTrack`. */
export function compileAiComposition(comp: AiComposition): LofiTrack {
  const strumBeats = (0.015 * comp.bpm) / 60; // 15 ms gentle electric-piano strum
  const chords: NoteEvent[] = [];
  const bass: NoteEvent[] = [];
  const drums: NoteEvent[] = [];

  comp.chords.forEach((barChord, bar) => {
    const barStart = bar * BEATS_PER_BAR;
    const hits = barChord.hits && barChord.hits.length > 0 ? barChord.hits : [0];

    hits.forEach((hitOffset, hitIdx) => {
      const nextHit = hitIdx + 1 < hits.length ? hits[hitIdx + 1] : BEATS_PER_BAR;
      const dur = clamp(nextHit - hitOffset - 0.15, 0.35, 3.8);
      barChord.notes.forEach((midi, i) => {
        const startBeat = barStart + hitOffset + i * strumBeats;
        if (startBeat < TOTAL_BEATS) {
          chords.push({
            midi,
            startBeat,
            durationBeats: Math.min(dur, TOTAL_BEATS - startBeat),
            velocity: hitIdx === 0 ? 0.46 : 0.36,
          });
        }
      });
    });

    // Bass: breathing root note at bar start + optional syncopated touch on beat 3.
    bass.push({
      midi: barChord.bass,
      startBeat: barStart,
      durationBeats: hits.length > 1 ? 1.5 : 2.2,
      velocity: 0.56,
    });
    if (hits.length > 1 && hits[1] >= 1.5 && hits[1] <= 3.0) {
      bass.push({
        midi: barChord.bass,
        startBeat: barStart + hits[1],
        durationBeats: Math.min(1.2, BEATS_PER_BAR - hits[1] - 0.1),
        velocity: 0.44,
      });
    }
  });

  const melody: NoteEvent[] = comp.melody.map((m) => ({
    midi: m.midi,
    startBeat: m.start,
    durationBeats: m.dur,
    velocity: m.vel ?? 0.4,
  }));

  for (let bar = 0; bar < BARS; bar++) {
    const barStart = bar * BEATS_PER_BAR;
    const isLastBar = bar === BARS - 1;
    const bar4 = isLastBar ? comp.drums.bar4 : undefined;
    const kickSteps = bar4?.kick ?? comp.drums.kick;
    const snareSteps = bar4?.snare ?? comp.drums.snare;
    const closedHatSteps = bar4?.closedHat ?? comp.drums.closedHat;
    const openHatSteps = bar4?.openHat ?? comp.drums.openHat ?? [];

    for (const step of kickSteps) {
      drums.push({
        midi: DRUM.kick,
        startBeat: barStart + applySwing(step, comp.swing),
        durationBeats: 0.25,
        velocity: step === 0 ? 0.72 : 0.58,
      });
    }
    for (const step of snareSteps) {
      drums.push({
        midi: DRUM.snare,
        startBeat: barStart + applySwing(step, comp.swing),
        durationBeats: 0.3,
        velocity: 0.6,
      });
    }
    for (const step of closedHatSteps) {
      drums.push({
        midi: DRUM.closedHat,
        startBeat: barStart + applySwing(step, comp.swing),
        durationBeats: 0.15,
        velocity: step % 4 === 0 ? 0.38 : 0.22,
      });
    }
    for (const step of openHatSteps) {
      drums.push({
        midi: DRUM.openHat,
        startBeat: barStart + applySwing(step, comp.swing),
        durationBeats: 0.4,
        velocity: 0.32,
      });
    }
  }

  const tracks: TrackMap = { chords, bass, melody, drums };
  for (const name of Object.keys(tracks) as (keyof TrackMap)[]) {
    tracks[name].sort((a, b) => a.startBeat - b.startBeat);
  }

  return {
    seed: comp.title,
    bpm: comp.bpm,
    bars: BARS,
    key: comp.key,
    swing: comp.swing,
    preset: comp.preset,
    tracks,
  };
}
