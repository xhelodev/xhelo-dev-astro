/**
 * Music theory data for the lofi generator (S5, latin dreamy lofi/trap style):
 * keys, scales, curated progression pools (minor-weighted), chill half-time
 * trap drum templates with triplet hat rolls, and voicing helpers.
 * Pure data + pure functions; the generator owns the PRNG so seeds stay
 * reproducible.
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

/** Dreamy minor pools — the default latin lofi identity (S5/L13). */
export const MINOR_PROGRESSIONS: readonly Progression[] = [
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
  // i9 -> bVImaj7 -> bIIImaj7 -> bVII7 (aeolian, dreamy color)
  [
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 8, intervals: [0, 4, 7, 11] },
    { rootOffset: 3, intervals: [0, 4, 7, 11] },
    { rootOffset: 10, intervals: [0, 4, 7, 10] },
  ],
  // i9 -> bVII -> bVImaj7 -> bVII7 (loop)
  [
    { rootOffset: 0, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 10, intervals: [0, 4, 7, 10] },
    { rootOffset: 8, intervals: [0, 4, 7, 11] },
    { rootOffset: 10, intervals: [0, 4, 7, 10] },
  ],
];

/** Cuco-style dreamy major pools — relaxed lush voicings (L19: no altered
 *  tensions; sus colors instead of #9s). */
export const MAJOR_PROGRESSIONS: readonly Progression[] = [
  // ii9 -> V13 -> Imaj9 -> VI9 (classic dreamy turnaround)
  [
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 4, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 9, intervals: [0, 4, 7, 10, 14] },
  ],
  // IVmaj7 -> iii7 -> vi9 -> ii9 (nostalgic dreamy vibe)
  [
    { rootOffset: 5, intervals: [0, 4, 7, 11] },
    { rootOffset: 4, intervals: [0, 3, 7, 10] },
    { rootOffset: 9, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
  ],
  // Imaj9 -> vi9 -> ii9 -> V7sus9 (suspended, relaxed dominant)
  [
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 9, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 2, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 7, intervals: [0, 5, 7, 10, 14] },
  ],
  // IVmaj9 -> iv9 -> Imaj9 -> Imaj9 (minor-iv modal interchange)
  [
    { rootOffset: 5, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 5, intervals: [0, 3, 7, 10, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
    { rootOffset: 0, intervals: [0, 4, 7, 11, 14] },
  ],
];

/** GM drum map notes used by the generator (S5). */
export const DRUM = {
  kick: 36,
  snare: 38,
  closedHat: 42,
  openHat: 46,
} as const;

/**
 * One chill trap half-time template (S5/L13). All step fields index the
 * 16-step (16th-note) grid of a single bar; `hatRolls` indexes the eight
 * 8th-note slots (0-7) that become 16th-triplet rolls.
 */
export interface DrumTemplate {
  kick: readonly number[];
  kickGhosts: readonly number[];
  /** Half-time: the snare sits on beat 3 (step 8), never on 2 & 4. */
  snare: readonly number[];
  snareGhosts: readonly number[];
  hatRolls: readonly number[];
  hats: "eighths";
  openHat: readonly number[];
}

export const DRUM_TEMPLATES: readonly DrumTemplate[] = [
  { kick: [0, 6], kickGhosts: [11], snare: [8], snareGhosts: [], hatRolls: [5], hats: "eighths", openHat: [14] },
  { kick: [0, 10, 13], kickGhosts: [], snare: [8], snareGhosts: [15], hatRolls: [7], hats: "eighths", openHat: [] },
  { kick: [0, 7], kickGhosts: [14], snare: [8], snareGhosts: [], hatRolls: [3], hats: "eighths", openHat: [6] },
];

/** Shift a MIDI note by octaves until it fits [lo, hi]. */
export function foldToRange(midi: number, lo: number, hi: number): number {
  let note = midi;
  while (note < lo) note += 12;
  while (note > hi) note -= 12;
  return note;
}

/** Voice a chord as a cluster within MIDI 50-74 (drop-2 / rootless flavor,
 *  brightened per L16/L17): root folded into [50, 61], upper voices folded
 *  into [55, 74]. The caller may drop the root for a rootless voicing. */
export function voiceChord(tonicPc: number, chord: ChordSpec): number[] {
  const root = foldToRange(48 + ((tonicPc + chord.rootOffset) % 12), 50, 61);
  const upper = chord.intervals.slice(1).map((interval) => foldToRange(root + interval, 55, 74));
  return [...new Set([root, ...upper])].sort((a, b) => a - b);
}

/** Bass root for a chord, folded into MIDI 36-47. */
export function bassRoot(tonicPc: number, chord: ChordSpec): number {
  return foldToRange(48 + ((tonicPc + chord.rootOffset) % 12), 36, 47);
}
