import { describe, expect, it } from "vitest";
import { Midi } from "@tonejs/midi";
import { generateLofiTrack } from "./generator";
import { buildMidi, buildMidiData } from "./midi-export";
import type { TrackName } from "./types";

const SEED = "export-check";
const track = generateLofiTrack(SEED);
const LOOPS = 4;
const reparsed = new Midi(buildMidiData(track, LOOPS));

/** Track order used by the exporter: chords, bass, melody, drums. */
const ORDER: TrackName[] = ["chords", "bass", "melody", "drums"];

describe("midi export (S7)", () => {
  it("produces one SMF track per composition track", () => {
    expect(buildMidi(track, LOOPS).tracks.length).toBe(4);
    expect(reparsed.tracks.length).toBe(4);
  });

  it("maps GM channels and programs per spec", () => {
    expect(reparsed.tracks[0].channel).toBe(0); // Electric Piano
    expect(reparsed.tracks[0].instrument.number).toBe(4);
    expect(reparsed.tracks[1].channel).toBe(1); // Electric Bass
    expect(reparsed.tracks[1].instrument.number).toBe(33);
    expect(reparsed.tracks[2].channel).toBe(2); // Vibraphone
    expect(reparsed.tracks[2].instrument.number).toBe(11);
    expect(reparsed.tracks[3].channel).toBe(9); // GM percussion
  });

  it("loops the composition: note counts multiply by the loop count", () => {
    ORDER.forEach((name, i) => {
      expect(reparsed.tracks[i].notes.length).toBe(track.tracks[name].length * LOOPS);
    });
  });

  it("round-trips note pitches and velocities into valid MIDI ranges", () => {
    for (const midiTrack of reparsed.tracks) {
      for (const note of midiTrack.notes) {
        expect(note.midi).toBeGreaterThanOrEqual(0);
        expect(note.midi).toBeLessThanOrEqual(127);
        expect(note.velocity).toBeGreaterThan(0);
        expect(note.velocity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("encodes the tempo", () => {
    const tempo = reparsed.header.tempos[0];
    expect(tempo?.bpm).toBeCloseTo(track.bpm, 0);
  });

  it("is deterministic for the same track and loop count", () => {
    const a = Buffer.from(buildMidiData(track, LOOPS));
    const b = Buffer.from(buildMidiData(track, LOOPS));
    expect(a.equals(b)).toBe(true);
  });
});
