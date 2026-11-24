/**
 * Browser-only Web Audio engine for the lofi generator (S6).
 *
 * Consumes the pure `LofiTrack` composition and synthesizes it live: a warm
 * FM electric piano, bass, synthesized boom-bap drums, and the lofi DSP chain
 * (master low-pass, tape wobble, procedural vinyl crackle, soft saturation,
 * kick ducking). The engine NEVER constructs an AudioContext — the UI owns it
 * so the iOS Safari user-gesture unlock stays synchronous. Dynamically
 * imported by the island on first Play, so nothing here loads on page load.
 */

import type { FxSettings, LofiTrack, NoteEvent, TrackName } from "./types";

export interface LofiEngine {
  play(): void;
  pause(): void;
  stop(): void;
  setTrack(track: LofiTrack): void;
  setFx(fx: FxSettings): void;
  dispose(): void;
  onStateChange: ((playing: boolean) => void) | null;
}

/** Scheduler cadence (S6): 25 ms tick, 200 ms lookahead. */
const TICK_MS = 25;
const LOOKAHEAD_S = 0.2;
/** Gain ramp time constants (S6: 10-25 ms ramps, zero clicks). */
const RAMP_S = 0.012;
/** How far behind schedule a note may be before the transport resyncs. */
const RESYNC_GRACE_S = 0.05;
/** Master volume ceiling (fx.volume 0-1 maps below this). Kept conservative
 *  so the summed buses never drive the saturator into hard clamping. */
const MASTER_CEILING = 0.7;

interface ScheduledEvent {
  note: NoteEvent;
  track: TrackName;
  /** Absolute beat (looped): `track` events offset by whole loop repetitions. */
  beat: number;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Soft tanh saturation curve for the WaveShaper. */
function tanhCurve(amount = 1.5): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export function createLofiEngine(ctx: AudioContext, initialTrack: LofiTrack, initialFx: FxSettings): LofiEngine {
  let track = initialTrack;
  let fx = initialFx;
  let spb = 60 / track.bpm;
  let loopBeats = track.bars * 4;

  // ---- Audio graph ---------------------------------------------------------
  const master = ctx.createGain();
  master.gain.value = 0.0001;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.2;

  const saturator = ctx.createWaveShaper();
  saturator.curve = tanhCurve();
  saturator.oversample = "2x";

  const masterLowpass = ctx.createBiquadFilter();
  masterLowpass.type = "lowpass";
  masterLowpass.frequency.value = 4600; // warm but not dark (L16/L19)
  masterLowpass.Q.value = 0.5;

  const mixBus = ctx.createGain();
  const drumsBus = ctx.createGain();
  const bassBus = ctx.createGain();
  const melodicBus = ctx.createGain(); // chords + melody -> wobble
  // Kill sub-rumble below the kick's bottom so the low end stays clean (L17).
  const mixHighpass = ctx.createBiquadFilter();
  mixHighpass.type = "highpass";
  mixHighpass.frequency.value = 38;
  mixHighpass.Q.value = 0.7;

  // Chord ducking: chord voices pass through a gain the kick dips.
  const duckGain = ctx.createGain();

  // Tape wobble: slow LFO modulating a short delay on the melodic bus.
  const wobbleDelay = ctx.createDelay(0.05);
  wobbleDelay.delayTime.value = 0.008; // ~8 ms base
  const wobbleLfo = ctx.createOscillator();
  wobbleLfo.frequency.value = 0.6; // 0.4-1.0 Hz (S6)
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 0; // +/- ~3 ms when on
  wobbleLfo.connect(wobbleDepth).connect(wobbleDelay.delayTime);
  wobbleLfo.start();

  duckGain.connect(melodicBus);
  melodicBus.connect(wobbleDelay);
  wobbleDelay.connect(mixBus);
  // Dreamy reverb send on the melodic bus (L12/L13): generated impulse.
  const reverb = ctx.createConvolver();
  reverb.buffer = createReverbImpulse(ctx);
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.18;
  melodicBus.connect(reverbSend);
  reverbSend.connect(reverb);
  reverb.connect(mixBus);
  bassBus.connect(mixBus);
  drumsBus.connect(mixBus);
  mixBus.connect(mixHighpass);
  mixHighpass.connect(masterLowpass);
  masterLowpass.connect(saturator);
  saturator.connect(compressor);
  compressor.connect(master);
  master.connect(ctx.destination);

  // ---- Procedural vinyl crackle (S6) ----------------------------------------
  const crackleSource = ctx.createBufferSource();
  crackleSource.buffer = createCrackleBuffer(ctx);
  crackleSource.loop = true;
  const crackleBandpass = ctx.createBiquadFilter();
  crackleBandpass.type = "bandpass";
  crackleBandpass.frequency.value = 2200; // inside the 1.5-4 kHz band (S6)
  crackleBandpass.Q.value = 0.7;
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0; // ~-26 dB when on
  crackleSource.connect(crackleBandpass).connect(crackleGain).connect(compressor);
  crackleSource.start();

  // ---- Shared noise buffer for drums ----------------------------------------
  const noiseBuffer = createNoiseBuffer(ctx);

  // ---- Active-voice registry (L18) -------------------------------------------
  /** Scheduled sources that may still be sounding, for hard stops. */
  interface ActiveVoice {
    src: AudioScheduledSourceNode;
    /** ctx time after which the source has certainly ended. */
    until: number;
  }
  const activeVoices: ActiveVoice[] = [];

  function registerVoice(src: AudioScheduledSourceNode, until: number): void {
    activeVoices.push({ src, until });
  }

  /** Hard-stop every ringing voice so an old track never bleeds under a
   *  regenerated one (L18). Sources stop just after the master gate closes. */
  function killVoices(): void {
    const at = ctx.currentTime + 0.03;
    for (const voice of activeVoices) {
      try {
        voice.src.stop(at);
      } catch {
        // Already stopped/ended: nothing to do.
      }
    }
    activeVoices.length = 0;
  }

  // ---- Transport / scheduler -------------------------------------------------
  /** Events of ONE loop repetition, sorted by beat, in [0, loopBeats). */
  let loopEvents: ScheduledEvent[] = [];
  /** Loop base (absolute beats) of the currently scheduled repetition. */
  let loopBase = 0;
  /** Index into the current repetition. */
  let pointer = 0;
  /** ctx time at absolute beat 0 of the session. */
  let transportStartTime = 0;
  /** Pause position in absolute beats. */
  let beatOffset = 0;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function flatten(t: LofiTrack): ScheduledEvent[] {
    const list: ScheduledEvent[] = [];
    for (const name of Object.keys(t.tracks) as TrackName[]) {
      for (const note of t.tracks[name]) {
        list.push({ note, track: name, beat: note.startBeat });
      }
    }
    return list.sort((a, b) => a.beat - b.beat);
  }

  function beatAt(time: number): number {
    return (time - transportStartTime) / spb;
  }

  function eventTime(event: ScheduledEvent): number {
    return transportStartTime + event.beat * spb;
  }

  /** Arm the repetition that contains/follows `beatOffset` so the engine can
   *  resume mid-loop without skipping to the next loop start. */
  function armFromOffset(): void {
    loopEvents = flatten(track);
    loopBase = Math.floor(beatOffset / loopBeats) * loopBeats;
    pointer = 0;
    while (pointer < loopEvents.length && loopBase + loopEvents[pointer].beat < beatOffset) {
      pointer++;
    }
    if (pointer >= loopEvents.length) {
      // Offset sits exactly at a loop boundary: arm the next repetition.
      loopBase += loopBeats;
      pointer = 0;
    }
  }

  function advanceLoop(): void {
    loopBase += loopBeats;
    pointer = 0;
  }

  function tick(): void {
    if (!playing) return;
    // Prune the voice registry so it stays bounded over long sessions.
    if (activeVoices.length > 64) {
      const now = ctx.currentTime;
      for (let i = activeVoices.length - 1; i >= 0; i--) {
        if (activeVoices[i].until < now) activeVoices.splice(i, 1);
      }
    }
    // Background-tab / throttling guard (S6): if the next event is far behind
    // schedule, resync the transport instead of scheduling a catch-up burst.
    if (pointer < loopEvents.length) {
      const nextTime = eventTime(currentEvent());
      if (nextTime < ctx.currentTime - RESYNC_GRACE_S) {
        transportStartTime = ctx.currentTime + 0.1 * spb - currentEvent().beat * spb;
      }
    }
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    while (pointer < loopEvents.length && eventTime(currentEvent()) < horizon) {
      const event = currentEvent();
      scheduleVoice(event, eventTime(event));
      pointer++;
    }
    if (pointer >= loopEvents.length) {
      advanceLoop();
    }
  }

  function currentEvent(): ScheduledEvent {
    return { ...loopEvents[pointer], beat: loopBase + loopEvents[pointer].beat };
  }

  // ---- Voices ------------------------------------------------------------------
  function scheduleVoice(event: ScheduledEvent, time: number): void {
    switch (event.track) {
      case "chords":
        playElectricPiano(event.note, time, duckGain, 0.16);
        break;
      case "melody":
        playPluck(event.note, time);
        break;
      case "bass":
        playBass(event.note, time);
        break;
      case "drums":
        playDrum(event.note, time);
        break;
    }
  }

  function playElectricPiano(note: NoteEvent, time: number, bus: AudioNode, level: number): void {
    const f = midiToFreq(note.midi);
    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = f;
    carrier.detune.value = (Math.random() - 0.5) * 6;

    // 2-op FM: warm Rhodes-style attack, mod index decays into the sustain.
    const modulator = ctx.createOscillator();
    modulator.type = "sine";
    modulator.frequency.value = f * 2;
    const modIndex = ctx.createGain();
    modIndex.gain.setValueAtTime(f * 1.4, time);
    modIndex.gain.setTargetAtTime(0, time, 0.25);
    modulator.connect(modIndex).connect(carrier.frequency);

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.frequency.value = 2800;

    const env = ctx.createGain();
    const peak = Math.max(0.02, note.velocity * level);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.02);
    env.gain.setTargetAtTime(peak * 0.6, time + 0.02, 0.4);

    const endTime = time + note.durationBeats * spb;
    env.gain.setTargetAtTime(0, Math.max(time + 0.05, endTime - 0.03), RAMP_S);

    carrier.connect(voiceFilter).connect(env).connect(bus);
    carrier.start(time);
    modulator.start(time);
    carrier.stop(endTime + 0.15);
    modulator.stop(endTime + 0.15);
    registerVoice(carrier, endTime + 0.15);
    registerVoice(modulator, endTime + 0.15);
  }

  /** Marimba/pluck-like FM voice for the melody (S5/L13). */
  function playPluck(note: NoteEvent, time: number): void {
    const f = midiToFreq(note.midi);
    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = f;

    const modulator = ctx.createOscillator();
    modulator.type = "sine";
    modulator.frequency.value = f * 3.5;
    const modIndex = ctx.createGain();
    modIndex.gain.setValueAtTime(f * 1.2, time);
    modIndex.gain.setTargetAtTime(0, time, 0.12);
    modulator.connect(modIndex).connect(carrier.frequency);

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.frequency.value = 3500;

    const env = ctx.createGain();
    const peak = Math.max(0.02, note.velocity * 0.22);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.012);
    env.gain.setTargetAtTime(0, time + 0.012, 0.35);

    const endTime = time + note.durationBeats * spb;
    carrier.connect(voiceFilter).connect(env).connect(melodicBus);
    carrier.start(time);
    modulator.start(time);
    carrier.stop(endTime + 0.4);
    modulator.stop(endTime + 0.4);
    registerVoice(carrier, endTime + 0.4);
    registerVoice(modulator, endTime + 0.4);
  }

  function playBass(note: NoteEvent, time: number): void {
    const f = midiToFreq(note.midi);
    // Deep sub bass (S5/L13): pure sine, long sustain, dark filter.
    const sine = ctx.createOscillator();
    sine.type = "sine";
    sine.frequency.value = f;

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.frequency.value = 200;

    const env = ctx.createGain();
    const peak = note.velocity * 0.15;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.02);
    env.gain.setTargetAtTime(peak * 0.85, time + 0.02, 0.4);

    const endTime = time + note.durationBeats * spb;
    env.gain.setTargetAtTime(0, Math.max(time + 0.1, endTime - 0.05), 0.03);

    sine.connect(voiceFilter).connect(env).connect(bassBus);
    sine.start(time);
    sine.stop(endTime + 0.2);
    registerVoice(sine, endTime + 0.2);
  }

  function playDrum(note: NoteEvent, time: number): void {
    switch (note.midi) {
      case 36: playKick(note, time); break;
      case 38: playSnare(note, time); break;
      case 42: playHat(note, time, 0.025, 0.12); break;
      case 46: playHat(note, time, 0.09, 0.45); break;
    }
  }

  function playKick(note: NoteEvent, time: number): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(60, time + 0.1);
    const env = ctx.createGain();
    env.gain.setValueAtTime(note.velocity * 0.5, time);
    env.gain.setTargetAtTime(0, time, 0.09);
    osc.connect(env).connect(drumsBus);
    osc.start(time);
    osc.stop(time + 0.18);
    registerVoice(osc, time + 0.18);
    // Light chord-bus ducking on kick (S6) — ramped, never an abrupt jump.
    const g = duckGain.gain;
    g.setTargetAtTime(0.6, time, 0.01);
    g.setTargetAtTime(1, time + 0.06, 0.12);
  }

  function playSnare(note: NoteEvent, time: number): void {
    // Woody rimshot (S5/L13): short bandpassed knock + tiny body.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 1200;
    bandpass.Q.value = 1.2;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(note.velocity * 0.22, time);
    noiseEnv.gain.setTargetAtTime(0, time, 0.045);
    noise.connect(bandpass).connect(noiseEnv).connect(drumsBus);
    noise.start(time);
    noise.stop(time + 0.15);
    registerVoice(noise, time + 0.15);

    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.value = 330;
    const bodyEnv = ctx.createGain();
    bodyEnv.gain.setValueAtTime(note.velocity * 0.08, time);
    bodyEnv.gain.setTargetAtTime(0, time, 0.03);
    body.connect(bodyEnv).connect(drumsBus);
    body.start(time);
    body.stop(time + 0.08);
    registerVoice(body, time + 0.08);
  }

  function playHat(note: NoteEvent, time: number, decay: number, length: number): void {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 7000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(note.velocity * 0.25, time);
    env.gain.setTargetAtTime(0, time, decay);
    noise.connect(highpass).connect(env).connect(drumsBus);
    noise.start(time);
    noise.stop(time + length);
    registerVoice(noise, time + length);
  }

  // ---- Buffers -------------------------------------------------------------------
  function createNoiseBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** ~1.4 s exponentially-decaying stereo noise impulse for the reverb
   *  send (L12/L13/L19 — dreamy but not cavernous). */
  function createReverbImpulse(context: AudioContext, seconds = 1.4, decay = 3): AudioBuffer {
    const length = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(2, length, context.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  /** 4 s looped vinyl crackle: brown noise bed + sparse dust impulses (S6). */
  function createCrackleBuffer(context: AudioContext): AudioBuffer {
    const seconds = 4;
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      brown = (brown + (Math.random() * 2 - 1) * 0.02) * 0.998;
      data[i] = brown;
    }
    const pops = 60;
    for (let p = 0; p < pops; p++) {
      const pos = Math.floor(Math.random() * data.length);
      const amp = 0.2 + Math.random() * 0.4;
      data[pos] += amp;
      if (pos + 1 < data.length) data[pos + 1] += amp * 0.5;
    }
    return buffer;
  }

  // ---- iOS interruption sync (S6) ------------------------------------------------
  const onContextStateChange = () => {
    if (ctx.state !== "running" && playing) {
      stopScheduler();
      beatOffset = Math.max(0, beatAt(ctx.currentTime));
      playing = false;
      master.gain.setTargetAtTime(0.0001, ctx.currentTime, RAMP_S);
      notify();
    }
  };
  ctx.addEventListener("statechange", onContextStateChange);

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible" && playing) tick();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  function notify(): void {
    engine.onStateChange?.(playing);
  }

  function stopScheduler(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---- Public API ------------------------------------------------------------------
  const engine: LofiEngine = {
    onStateChange: null,

    play() {
      if (playing) return;
      if (ctx.state === "suspended") void ctx.resume();
      playing = true;
      transportStartTime = ctx.currentTime + 0.06 - beatOffset * spb;
      armFromOffset();
      // Reopen the master slightly AFTER killVoices() has silenced the old
      // sources, so a regenerated track never plays over ringing old ones.
      master.gain.setTargetAtTime(fx.volume * MASTER_CEILING, ctx.currentTime + 0.05, 0.02);
      tick();
      timer = setInterval(tick, TICK_MS);
      notify();
    },

    pause() {
      if (!playing) return;
      beatOffset = Math.max(0, beatAt(ctx.currentTime));
      stopScheduler();
      killVoices();
      master.gain.setTargetAtTime(0.0001, ctx.currentTime, RAMP_S);
      playing = false;
      notify();
    },

    stop() {
      stopScheduler();
      killVoices();
      master.gain.setTargetAtTime(0.0001, ctx.currentTime, RAMP_S);
      beatOffset = 0;
      if (playing) {
        playing = false;
        notify();
      }
    },

    setTrack(next: LofiTrack) {
      const wasPlaying = playing;
      this.stop();
      track = next;
      spb = 60 / next.bpm;
      loopBeats = next.bars * 4;
      beatOffset = 0;
      if (wasPlaying) this.play();
    },

    setFx(next: FxSettings) {
      fx = next;
      crackleGain.gain.setTargetAtTime(next.crackle ? 0.06 : 0.0001, ctx.currentTime, 0.05);
      wobbleDepth.gain.setTargetAtTime(next.wobble ? 0.003 : 0.0001, ctx.currentTime, 0.05);
      master.gain.setTargetAtTime(playing ? fx.volume * MASTER_CEILING : 0.0001, ctx.currentTime, 0.03);
    },

    dispose() {
      this.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ctx.removeEventListener("statechange", onContextStateChange);
      try { crackleSource.stop(); } catch { /* already stopped */ }
      try { wobbleLfo.stop(); } catch { /* already stopped */ }
      master.disconnect();
      compressor.disconnect();
    },
  };

  // Initialize FX state on the graph (master stays silent until play()).
  engine.setFx(fx);

  return engine;
}
