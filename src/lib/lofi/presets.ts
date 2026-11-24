/**
 * Pure DSP preset definitions for the 16-bit Web Audio synthesizer.
 *
 * Zero browser APIs so presets are directly unit-testable in Node and cleanly
 * consumed by `audio-engine.ts`. Supports both SNES-style warm pads + echo
 * (SPC700 vibe) and Sega Genesis-style multi-op FM bass/brass (YM2612 vibe).
 */

import type { SoundPreset } from "./types";

export type WaveType = "sine" | "square" | "sawtooth" | "triangle";

export interface ChordVoicePreset {
  wave: WaveType;
  detuneSpread: number;
  /** Optional unison detune in cents (> 0 spawns a 2nd detuned voice). */
  unisonDetune: number;
  /** 2-op FM ratio (0 disables FM). */
  fmRatio: number;
  fmIndex: number;
  fmDecay: number;
  filterHz: number;
  filterEndHz: number;
  filterQ: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustainRatio: number;
  release: number;
  level: number;
}

export interface MelodyVoicePreset {
  wave: WaveType;
  fmRatio: number;
  fmIndex: number;
  fmDecay: number;
  filterHz: number;
  attack: number;
  decay: number;
  /** 0 = pure pluck/bell decay; > 0 = holds sustain until note end. */
  sustainRatio: number;
  release: number;
  level: number;
  vibratoHz: number;
  vibratoDepthCents: number;
}

export interface BassVoicePreset {
  wave: WaveType;
  /** Optional 2-op FM ratio for Sega Genesis / YM2612 slap bass (0 disables FM). */
  fmRatio: number;
  fmIndex: number;
  fmDecay: number;
  filterHz: number;
  filterEndHz: number;
  filterQ: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustainRatio: number;
  release: number;
  level: number;
  /** Initial pitch multiplier for punchy 808/synth attacks (1 = none). */
  pitchPunch: number;
}

export interface DrumKitPreset {
  kickWave: WaveType;
  kickStartHz: number;
  kickEndHz: number;
  kickSweepS: number;
  kickDecay: number;
  kickLength: number;
  kickLevel: number;
  snareNoiseHz: number;
  snareNoiseQ: number;
  snareNoiseDecay: number;
  snareNoiseLevel: number;
  snareBodyWave: WaveType;
  snareBodyHz: number;
  snareBodyDecay: number;
  snareBodyLevel: number;
  snareLength: number;
  hatFilterType: "highpass" | "bandpass";
  hatHz: number;
  hatQ: number;
  hatLevel: number;
  hatDecayScale: number;
}

export interface SynthPresetConfig {
  id: SoundPreset;
  masterLowpassHz: number;
  reverbSend: number;
  /** SNES-style tempo-synced echo send (0 = off). */
  echoSend: number;
  /** Echo feedback gain (capped <= 0.45 for stability). */
  echoFeedback: number;
  /** Echo delay length in beats (e.g. 0.75 = dotted 8th). */
  echoBeats: number;
  /** Duck gain floor on kick hit (1 = no ducking, 0.5 = strong sidechain). */
  duckAmount: number;
  chord: ChordVoicePreset;
  melody: MelodyVoicePreset;
  bass: BassVoicePreset;
  drums: DrumKitPreset;
}

export const PRESET_CONFIGS: Record<SoundPreset, SynthPresetConfig> = {
  "lofi-rhodes": {
    id: "lofi-rhodes",
    masterLowpassHz: 4600,
    reverbSend: 0.2,
    echoSend: 0.08,
    echoFeedback: 0.2,
    echoBeats: 0.75,
    duckAmount: 0.68,
    chord: {
      wave: "sine",
      detuneSpread: 6,
      unisonDetune: 0,
      fmRatio: 2,
      fmIndex: 1.4,
      fmDecay: 0.25,
      filterHz: 2800,
      filterEndHz: 2200,
      filterQ: 0.7,
      filterDecay: 0.4,
      attack: 0.02,
      decay: 0.4,
      sustainRatio: 0.6,
      release: 0.08,
      level: 0.2,
    },
    melody: {
      wave: "sine",
      fmRatio: 3.5,
      fmIndex: 1.2,
      fmDecay: 0.12,
      filterHz: 3500,
      attack: 0.012,
      decay: 0.35,
      sustainRatio: 0,
      release: 0.2,
      level: 0.28,
      vibratoHz: 0,
      vibratoDepthCents: 0,
    },
    bass: {
      wave: "sine",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 240,
      filterEndHz: 200,
      filterQ: 0.7,
      filterDecay: 0.3,
      attack: 0.02,
      decay: 0.4,
      sustainRatio: 0.85,
      release: 0.05,
      level: 0.2,
      pitchPunch: 1,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 145,
      kickEndHz: 58,
      kickSweepS: 0.1,
      kickDecay: 0.09,
      kickLength: 0.18,
      kickLevel: 0.4,
      snareNoiseHz: 1200,
      snareNoiseQ: 1.2,
      snareNoiseDecay: 0.045,
      snareNoiseLevel: 0.2,
      snareBodyWave: "triangle",
      snareBodyHz: 330,
      snareBodyDecay: 0.03,
      snareBodyLevel: 0.08,
      snareLength: 0.15,
      hatFilterType: "highpass",
      hatHz: 7000,
      hatQ: 0.7,
      hatLevel: 0.22,
      hatDecayScale: 1,
    },
  },

  "snes-rpg": {
    id: "snes-rpg",
    masterLowpassHz: 6800,
    reverbSend: 0.24,
    echoSend: 0.32,
    echoFeedback: 0.36,
    echoBeats: 0.75,
    duckAmount: 0.88,
    chord: {
      wave: "triangle",
      detuneSpread: 5,
      unisonDetune: 8,
      fmRatio: 2,
      fmIndex: 0.55,
      fmDecay: 0.35,
      filterHz: 2900,
      filterEndHz: 1800,
      filterQ: 0.9,
      filterDecay: 0.5,
      attack: 0.075,
      decay: 0.55,
      sustainRatio: 0.72,
      release: 0.22,
      level: 0.15,
    },
    melody: {
      wave: "triangle",
      fmRatio: 3,
      fmIndex: 0.7,
      fmDecay: 0.18,
      filterHz: 4200,
      attack: 0.018,
      decay: 0.32,
      sustainRatio: 0.55,
      release: 0.18,
      level: 0.25,
      vibratoHz: 5.4,
      vibratoDepthCents: 12,
    },
    bass: {
      wave: "triangle",
      fmRatio: 1,
      fmIndex: 0.35,
      fmDecay: 0.15,
      filterHz: 480,
      filterEndHz: 280,
      filterQ: 0.9,
      filterDecay: 0.22,
      attack: 0.012,
      decay: 0.3,
      sustainRatio: 0.65,
      release: 0.07,
      level: 0.24,
      pitchPunch: 1,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 155,
      kickEndHz: 56,
      kickSweepS: 0.085,
      kickDecay: 0.085,
      kickLength: 0.16,
      kickLevel: 0.36,
      snareNoiseHz: 2100,
      snareNoiseQ: 1.0,
      snareNoiseDecay: 0.06,
      snareNoiseLevel: 0.2,
      snareBodyWave: "triangle",
      snareBodyHz: 250,
      snareBodyDecay: 0.04,
      snareBodyLevel: 0.1,
      snareLength: 0.16,
      hatFilterType: "bandpass",
      hatHz: 6800,
      hatQ: 1.1,
      hatLevel: 0.19,
      hatDecayScale: 1.1,
    },
  },

  "genesis-fm": {
    id: "genesis-fm",
    masterLowpassHz: 10500,
    reverbSend: 0.1,
    echoSend: 0.18,
    echoFeedback: 0.26,
    echoBeats: 0.5,
    duckAmount: 0.82,
    chord: {
      wave: "sine",
      detuneSpread: 2,
      unisonDetune: 5,
      fmRatio: 2,
      fmIndex: 2.6,
      fmDecay: 0.16,
      filterHz: 5600,
      filterEndHz: 2600,
      filterQ: 1.1,
      filterDecay: 0.24,
      attack: 0.008,
      decay: 0.26,
      sustainRatio: 0.5,
      release: 0.07,
      level: 0.13,
    },
    melody: {
      wave: "sine",
      fmRatio: 3,
      fmIndex: 2.8,
      fmDecay: 0.2,
      filterHz: 6800,
      attack: 0.006,
      decay: 0.22,
      sustainRatio: 0.55,
      release: 0.08,
      level: 0.22,
      vibratoHz: 6.2,
      vibratoDepthCents: 14,
    },
    bass: {
      wave: "sine",
      fmRatio: 2,
      fmIndex: 2.4,
      fmDecay: 0.13,
      filterHz: 1800,
      filterEndHz: 520,
      filterQ: 1.4,
      filterDecay: 0.14,
      attack: 0.005,
      decay: 0.2,
      sustainRatio: 0.5,
      release: 0.04,
      level: 0.24,
      pitchPunch: 1.08,
    },
    drums: {
      kickWave: "triangle",
      kickStartHz: 195,
      kickEndHz: 54,
      kickSweepS: 0.065,
      kickDecay: 0.075,
      kickLength: 0.14,
      kickLevel: 0.4,
      snareNoiseHz: 2600,
      snareNoiseQ: 0.85,
      snareNoiseDecay: 0.075,
      snareNoiseLevel: 0.24,
      snareBodyWave: "triangle",
      snareBodyHz: 220,
      snareBodyDecay: 0.035,
      snareBodyLevel: 0.12,
      snareLength: 0.17,
      hatFilterType: "highpass",
      hatHz: 9200,
      hatQ: 0.7,
      hatLevel: 0.2,
      hatDecayScale: 0.75,
    },
  },

  synthwave: {
    id: "synthwave",
    masterLowpassHz: 9500,
    reverbSend: 0.28,
    echoSend: 0.24,
    echoFeedback: 0.32,
    echoBeats: 0.75,
    duckAmount: 0.5,
    chord: {
      wave: "sawtooth",
      detuneSpread: 4,
      unisonDetune: 9,
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 3200,
      filterEndHz: 850,
      filterQ: 1.8,
      filterDecay: 0.35,
      attack: 0.025,
      decay: 0.35,
      sustainRatio: 0.65,
      release: 0.15,
      level: 0.11,
    },
    melody: {
      wave: "sawtooth",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 4800,
      attack: 0.01,
      decay: 0.25,
      sustainRatio: 0.55,
      release: 0.14,
      level: 0.18,
      vibratoHz: 5.5,
      vibratoDepthCents: 12,
    },
    bass: {
      wave: "sawtooth",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 1200,
      filterEndHz: 260,
      filterQ: 2.4,
      filterDecay: 0.18,
      attack: 0.008,
      decay: 0.22,
      sustainRatio: 0.55,
      release: 0.06,
      level: 0.2,
      pitchPunch: 1,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 175,
      kickEndHz: 52,
      kickSweepS: 0.08,
      kickDecay: 0.11,
      kickLength: 0.2,
      kickLevel: 0.44,
      snareNoiseHz: 2400,
      snareNoiseQ: 0.8,
      snareNoiseDecay: 0.12,
      snareNoiseLevel: 0.26,
      snareBodyWave: "triangle",
      snareBodyHz: 195,
      snareBodyDecay: 0.06,
      snareBodyLevel: 0.14,
      snareLength: 0.26,
      hatFilterType: "highpass",
      hatHz: 9000,
      hatQ: 0.7,
      hatLevel: 0.2,
      hatDecayScale: 0.9,
    },
  },

  "jazz-warm": {
    id: "jazz-warm",
    masterLowpassHz: 5800,
    reverbSend: 0.24,
    echoSend: 0.06,
    echoFeedback: 0.15,
    echoBeats: 0.5,
    duckAmount: 0.86,
    chord: {
      wave: "sine",
      detuneSpread: 5,
      unisonDetune: 0,
      fmRatio: 3,
      fmIndex: 1.1,
      fmDecay: 0.18,
      filterHz: 2400,
      filterEndHz: 1800,
      filterQ: 0.8,
      filterDecay: 0.35,
      attack: 0.015,
      decay: 0.38,
      sustainRatio: 0.55,
      release: 0.1,
      level: 0.2,
    },
    melody: {
      wave: "triangle",
      fmRatio: 2,
      fmIndex: 0.45,
      fmDecay: 0.2,
      filterHz: 3000,
      attack: 0.022,
      decay: 0.45,
      sustainRatio: 0.35,
      release: 0.18,
      level: 0.28,
      vibratoHz: 4.8,
      vibratoDepthCents: 10,
    },
    bass: {
      wave: "triangle",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 520,
      filterEndHz: 260,
      filterQ: 1.1,
      filterDecay: 0.22,
      attack: 0.008,
      decay: 0.28,
      sustainRatio: 0.35,
      release: 0.06,
      level: 0.26,
      pitchPunch: 1,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 120,
      kickEndHz: 55,
      kickSweepS: 0.09,
      kickDecay: 0.08,
      kickLength: 0.16,
      kickLevel: 0.34,
      snareNoiseHz: 3200,
      snareNoiseQ: 0.7,
      snareNoiseDecay: 0.09,
      snareNoiseLevel: 0.18,
      snareBodyWave: "sine",
      snareBodyHz: 210,
      snareBodyDecay: 0.035,
      snareBodyLevel: 0.05,
      snareLength: 0.2,
      hatFilterType: "bandpass",
      hatHz: 6200,
      hatQ: 1.2,
      hatLevel: 0.22,
      hatDecayScale: 1.6,
    },
  },

  "bossa-nylon": {
    id: "bossa-nylon",
    masterLowpassHz: 7200,
    reverbSend: 0.16,
    echoSend: 0.08,
    echoFeedback: 0.18,
    echoBeats: 0.5,
    duckAmount: 0.88,
    chord: {
      wave: "triangle",
      detuneSpread: 3,
      unisonDetune: 0,
      fmRatio: 2,
      fmIndex: 0.7,
      fmDecay: 0.09,
      filterHz: 3600,
      filterEndHz: 1400,
      filterQ: 0.9,
      filterDecay: 0.22,
      attack: 0.005,
      decay: 0.26,
      sustainRatio: 0.18,
      release: 0.08,
      level: 0.22,
    },
    melody: {
      wave: "triangle",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 3800,
      attack: 0.028,
      decay: 0.3,
      sustainRatio: 0.6,
      release: 0.12,
      level: 0.26,
      vibratoHz: 5.2,
      vibratoDepthCents: 11,
    },
    bass: {
      wave: "sine",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 360,
      filterEndHz: 260,
      filterQ: 0.8,
      filterDecay: 0.2,
      attack: 0.01,
      decay: 0.28,
      sustainRatio: 0.55,
      release: 0.05,
      level: 0.24,
      pitchPunch: 1.08,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 130,
      kickEndHz: 62,
      kickSweepS: 0.08,
      kickDecay: 0.09,
      kickLength: 0.17,
      kickLevel: 0.36,
      snareNoiseHz: 1850,
      snareNoiseQ: 2.6,
      snareNoiseDecay: 0.028,
      snareNoiseLevel: 0.18,
      snareBodyWave: "triangle",
      snareBodyHz: 460,
      snareBodyDecay: 0.022,
      snareBodyLevel: 0.11,
      snareLength: 0.1,
      hatFilterType: "bandpass",
      hatHz: 5800,
      hatQ: 1.4,
      hatLevel: 0.2,
      hatDecayScale: 1.2,
    },
  },

  "ambient-pad": {
    id: "ambient-pad",
    masterLowpassHz: 6200,
    reverbSend: 0.42,
    echoSend: 0.36,
    echoFeedback: 0.42,
    echoBeats: 0.75,
    duckAmount: 0.84,
    chord: {
      wave: "triangle",
      detuneSpread: 6,
      unisonDetune: 7,
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 2400,
      filterEndHz: 1600,
      filterQ: 0.7,
      filterDecay: 0.9,
      attack: 0.26,
      decay: 0.7,
      sustainRatio: 0.78,
      release: 0.35,
      level: 0.14,
    },
    melody: {
      wave: "sine",
      fmRatio: 4,
      fmIndex: 1.5,
      fmDecay: 0.35,
      filterHz: 5200,
      attack: 0.015,
      decay: 0.65,
      sustainRatio: 0,
      release: 0.4,
      level: 0.24,
      vibratoHz: 0,
      vibratoDepthCents: 0,
    },
    bass: {
      wave: "sine",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 190,
      filterEndHz: 170,
      filterQ: 0.7,
      filterDecay: 0.6,
      attack: 0.12,
      decay: 0.6,
      sustainRatio: 0.9,
      release: 0.2,
      level: 0.2,
      pitchPunch: 1,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 110,
      kickEndHz: 50,
      kickSweepS: 0.12,
      kickDecay: 0.1,
      kickLength: 0.2,
      kickLevel: 0.28,
      snareNoiseHz: 1600,
      snareNoiseQ: 0.9,
      snareNoiseDecay: 0.07,
      snareNoiseLevel: 0.14,
      snareBodyWave: "sine",
      snareBodyHz: 260,
      snareBodyDecay: 0.04,
      snareBodyLevel: 0.04,
      snareLength: 0.18,
      hatFilterType: "highpass",
      hatHz: 8500,
      hatQ: 0.7,
      hatLevel: 0.14,
      hatDecayScale: 1.3,
    },
  },

  "trap-dark": {
    id: "trap-dark",
    masterLowpassHz: 7600,
    reverbSend: 0.22,
    echoSend: 0.16,
    echoFeedback: 0.24,
    echoBeats: 0.5,
    duckAmount: 0.56,
    chord: {
      wave: "triangle",
      detuneSpread: 8,
      unisonDetune: 5,
      fmRatio: 2,
      fmIndex: 0.9,
      fmDecay: 0.2,
      filterHz: 2000,
      filterEndHz: 1200,
      filterQ: 1.1,
      filterDecay: 0.4,
      attack: 0.03,
      decay: 0.45,
      sustainRatio: 0.6,
      release: 0.14,
      level: 0.14,
    },
    melody: {
      wave: "sine",
      fmRatio: 2.5,
      fmIndex: 1.7,
      fmDecay: 0.15,
      filterHz: 4200,
      attack: 0.006,
      decay: 0.3,
      sustainRatio: 0,
      release: 0.18,
      level: 0.26,
      vibratoHz: 0,
      vibratoDepthCents: 0,
    },
    bass: {
      wave: "sine",
      fmRatio: 0,
      fmIndex: 0,
      fmDecay: 0.1,
      filterHz: 320,
      filterEndHz: 220,
      filterQ: 1.2,
      filterDecay: 0.25,
      attack: 0.008,
      decay: 0.45,
      sustainRatio: 0.8,
      release: 0.08,
      level: 0.28,
      pitchPunch: 1.35,
    },
    drums: {
      kickWave: "sine",
      kickStartHz: 185,
      kickEndHz: 48,
      kickSweepS: 0.09,
      kickDecay: 0.14,
      kickLength: 0.26,
      kickLevel: 0.44,
      snareNoiseHz: 2200,
      snareNoiseQ: 1.1,
      snareNoiseDecay: 0.065,
      snareNoiseLevel: 0.26,
      snareBodyWave: "triangle",
      snareBodyHz: 260,
      snareBodyDecay: 0.035,
      snareBodyLevel: 0.1,
      snareLength: 0.18,
      hatFilterType: "highpass",
      hatHz: 8500,
      hatQ: 0.7,
      hatLevel: 0.22,
      hatDecayScale: 0.8,
    },
  },
};

export function getPresetConfig(preset?: SoundPreset): SynthPresetConfig {
  if (preset && preset in PRESET_CONFIGS) {
    return PRESET_CONFIGS[preset];
  }
  return PRESET_CONFIGS["lofi-rhodes"];
}
