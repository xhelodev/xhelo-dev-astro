/**
 * `.mid` export for the lofi generator (browser-facing module).
 *
 * The UI dynamically imports this module only when the user clicks Export, so
 * `@tonejs/midi` stays out of the initial page bundle. `buildMidi`/`buildMidiData`
 * are pure data functions (also usable in Node for tests); `downloadMidi` is the
 * browser-only trigger.
 */

import { Midi } from "@tonejs/midi";
import type { LofiTrack, TrackName } from "./types";

/** GM mapping per S7: ch 0 Electric Piano, ch 1 Electric Bass, ch 2 Vibraphone,
 *  ch 9 percussion (program change not applicable). */
const GM_CHANNELS: Record<TrackName, { channel: number; program: number | null }> = {
  chords: { channel: 0, program: 4 },
  bass: { channel: 1, program: 33 },
  melody: { channel: 2, program: 11 },
  drums: { channel: 9, program: null },
};

const TRACK_ORDER: TrackName[] = ["chords", "bass", "melody", "drums"];

/** Seconds per beat at the track's tempo. */
function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/** Build the Standard MIDI File (Type-1) for `track`, looped `loops` times so
 *  users get a usable 16–32 bar clip in any DAW. */
export function buildMidi(track: LofiTrack, loops = 6): Midi {
  const midi = new Midi();
  midi.header.setTempo(track.bpm);
  midi.header.name = `lofi ${track.key} — seed ${track.seed}`;

  const spb = secondsPerBeat(track.bpm);
  const loopBeats = track.bars * 4; // 4/4 bars

  for (const name of TRACK_ORDER) {
    const config = GM_CHANNELS[name];
    const midiTrack = midi.addTrack();
    midiTrack.channel = config.channel;
    if (config.program !== null) {
      midiTrack.instrument.number = config.program;
    }
    const notes = track.tracks[name];
    for (let loop = 0; loop < loops; loop++) {
      const offsetBeats = loop * loopBeats;
      for (const note of notes) {
        midiTrack.addNote({
          midi: note.midi,
          time: (offsetBeats + note.startBeat) * spb,
          duration: note.durationBeats * spb,
          velocity: note.velocity,
        });
      }
    }
  }
  return midi;
}

/** Raw Standard MIDI File bytes for `track` (looped `loops` times). */
export function buildMidiData(track: LofiTrack, loops = 6): Uint8Array {
  return buildMidi(track, loops).toArray();
}

/** Make a seed safe to use inside a download filename. */
function safeSeed(seed: string): string {
  const cleaned = seed.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "track";
}

/** Browser-only: build the `.mid` and trigger a download of `lofi-<seed>.mid`. */
export function downloadMidi(track: LofiTrack, loops = 6): void {
  const bytes = buildMidiData(track, loops);
  // Copy into a plain-ArrayBuffer-backed view so it satisfies BlobPart under
  // TS 5.9's ArrayBuffer generics.
  const blobPart = new Uint8Array(bytes);
  const blob = new Blob([blobPart], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lofi-${safeSeed(track.seed)}.mid`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
