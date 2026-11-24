/**
 * Music theory data for the lofi generator (S5): keys, scales, curated
 * progression pools, boom-bap drum templates and voicing helpers.
 * Pure data + pure functions; no randomness in here (the generator owns the
 * PRNG so seeds stay reproducible).
 */

/** A chord as semitone offsets from the tonic: root offset + chord intervals. */
export interface ChordSpec {
  /** Semitone offset of the chord root from the key tonic (0-11). */
  rootOffset: number;
  /** Chord tones as semitone intervals above the chord root (7ths/9ths/11ths). */
  intervals: number[];
}

/** A curated 4-bar progression template. */
export type Progression = readonly [ChordSpec, ChordSpec, ChordSpec, ChordSpec];

export const KEYS = [
  { name: "F", pc: 5 },
  { name: "Eb", pc: 3 },
  { name: "Db", pc: 1 },
  { name: "Bb", pc: 10 },
  { name: "C", pc: 0 },
  { name: "Ab", pc: 8 },
] as const;

export const MODES = ["major", "dorian", "aeolian"] as const;
export type Mode = (typeof MODES)[number];

/** Major pentatonic (for major keys) and minor pentatonic (dorian/aeolian). */
export const PENTATONICS: Record<Mode, readonly number[]> = {
  major: [0, 2, 4, 7, 9],
  dorian: [0, 3, 5, 7, 10],
  aeolian: [0, 3, 5, 7, 10],
};

/** Curated jazz/lofi 4-bar pools (S5). Modal interchange between pools is
 *  idiomatic lofi, so any mode may draw from any pool. */
export const PROGRESSIONS: readonly Progression[] = [
  // ii9 -> V13 -> Imaj9 -> VI7#9 (classic jazz turnaround)
  [
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 4, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 9, intervals: [0, 4, 7, 10, 15] },
  ],
  // IVmaj7 -> iii7 -> vi9 -> ii9 (nostalgic Nujabes/Dilla vibe)
  [
    { rootOffset: 5, intervals: [0, 4, 7, 11] },
    { rootOffset: 4, intervals: [0, 3, 7, 10] },
    { rootOffset: 9, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
  ],
  // Imaj9 -> vi9 -> ii9 -> V7#9
  [
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 9, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 4, 7, 10, 15] },
  ],
  // IVmaj9 -> iv9 -> Imaj9 -> Imaj9 (minor-iv modal interchange)
  [
    { rootOffset: 5, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 5, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
  ],
  // i9 -> iv9 -> bVII7 -> i9 (dorian)
  [
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 5, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 10, intervals: [0, 4, 7, 10] },
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
  ],
  // i9 -> bVImaj7 -> bVII7 -> i9 (aeolian)
  [
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 8, intervals: [0, 4, 7, 11] },
    { rootOffset: 10, intervals: [0, 4, 7, 10] },
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
  ],
  // vi9 -> ii9 -> V13 -> Imaj9
  [
    { rootOffset: 9, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 4, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
  ],
  // ii9 -> V13 -> Imaj9 -> IVmaj7
  [
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 4, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 5, intervals: [0, 4, 7, 11] },
  ],
];

/** GM drum map notes used by the generator (S5). */
export const DRUM = {
  kick: 36,
  snare: 38,
  closedHat: 42,
  openHat: 46,
} as const;

/** One boom-bap template on a 16-step (16th notes) grid. */
export interface DrumTemplate {
  kick: readonly number[];
  kickGhosts: readonly number[];
  snare: readonly number[];
  snareGhosts: readonly number[];
  /** 8th-note hats with alternating accent/ghost velocities. */
  hats: "eighths";
  openHat: readonly number[];
}

export const DRUM_TEMPLATES: readonly DrumTemplate[] = [
  { kick: [0, 6, 10], kickGhosts: [7], snare: [4, 12], snareGhosts: [11], hats: "eighths", openHat: [14] },
  { kick: [0, 3, 10], kickGhosts: [11], snare: [4, 12], snareGhosts: [15], hats: "eighths", openHat: [14] },
  { kick: [0, 8, 10], kickGhosts: [14], snare: [4, 12], snareGhosts: [], hats: "eighths", openHat: [6] },
  { kick: [0, 6, 11], kickGhosts: [], snare: [4, 12], snareGhosts: [7], hats: "eighths", openHat: [14] },
];

/** Shift a MIDI note by octaves until it fits [lo, hi]. */
export function foldToRange(midi: number, lo: number, hi: number): number {
  let note = midi;
  while (note < lo) note += 12;
  while (note > hi) note -= 12;
  return note;
}

/** Voice a chord as a cluster within MIDI 48-72 (drop-2 / rootless flavor):
 *  root folded into [48, 59], upper voices folded into [52, 72]. The caller
 *  may occasionally drop the root for a rootless voicing. */
export function voiceChord(tonicPc: number, chord: ChordSpec): number[] {
  const root = foldToRange(48 + ((tonicPc + chord.rootOffset) % 12), 48, 59);
  const upper = chord.intervals.slice(1).map((interval) => foldToRange(root + interval, 52, 72));
  return [...new Set([root, ...upper])].sort((a, b) => a - b);
}

/** Bass root for a chord, folded into MIDI 36-47. */
export function bassRoot(tonicPc: number, chord: ChordSpec): number {
  return foldToRange(48 + ((tonicPc + chord.rootOffset) % 12), 36, 47);
}
