/**
 * Browser-only Web Audio engine for the lofi generator (S6).
 *
 * Consumes the pure `LofiTrack` composition and synthesizes it live: a warm
 * FM electric piano, bass, synthesized boom-bap drums, and the lofi DSP chain
 * (master low-pass, soft saturation, kick ducking). The engine NEVER
 * constructs an AudioContext — the UI owns it so the iOS Safari user-gesture
 * unlock stays synchronous. Dynamically imported by the island on first Play,
 * so nothing here loads on page load.
 */

import type { FxSettings, LofiTrack, NoteEvent, TrackName } from "./types";
import { getPresetConfig, type SynthPresetConfig } from "./presets";

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
  let preset: SynthPresetConfig = getPresetConfig(track.preset);
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
  masterLowpass.frequency.value = preset.masterLowpassHz;
  masterLowpass.Q.value = 0.5;

  const mixBus = ctx.createGain();
  const drumsBus = ctx.createGain();
  const bassBus = ctx.createGain();
  const melodicBus = ctx.createGain(); // chords + melody
  // Kill sub-rumble below the kick's bottom so the low end stays clean (L17).
  const mixHighpass = ctx.createBiquadFilter();
  mixHighpass.type = "highpass";
  mixHighpass.frequency.value = 38;
  mixHighpass.Q.value = 0.7;

  // Chord ducking: chord voices pass through a gain the kick dips.
  const duckGain = ctx.createGain();

  duckGain.connect(melodicBus);
  melodicBus.connect(mixBus);
  // Dreamy reverb send on the melodic bus (L12/L13): generated impulse.
  const reverb = ctx.createConvolver();
  reverb.buffer = createReverbImpulse(ctx);
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = preset.reverbSend;
  melodicBus.connect(reverbSend);
  reverbSend.connect(reverb);
  reverb.connect(mixBus);

  // SNES-style tempo-synced warm echo send on the melodic bus.
  const echoSend = ctx.createGain();
  echoSend.gain.value = preset.echoSend;
  const echoDelay = ctx.createDelay(1.0);
  echoDelay.delayTime.value = Math.min(0.65, spb * preset.echoBeats);
  const echoFilter = ctx.createBiquadFilter();
  echoFilter.type = "lowpass";
  echoFilter.frequency.value = 2800;
  const echoFeedback = ctx.createGain();
  echoFeedback.gain.value = preset.echoFeedback;
  melodicBus.connect(echoSend);
  echoSend.connect(echoDelay);
  echoDelay.connect(echoFilter);
  echoFilter.connect(echoFeedback);
  echoFeedback.connect(echoDelay);
  echoFilter.connect(mixBus);
  bassBus.connect(mixBus);
  drumsBus.connect(mixBus);
  mixBus.connect(mixHighpass);
  mixHighpass.connect(masterLowpass);
  masterLowpass.connect(saturator);
  saturator.connect(compressor);
  compressor.connect(master);
  master.connect(ctx.destination);

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
        playChordVoice(event.note, time, duckGain);
        break;
      case "melody":
        playMelodyVoice(event.note, time);
        break;
      case "bass":
        playBass(event.note, time);
        break;
      case "drums":
        playDrum(event.note, time);
        break;
    }
  }

  function playChordVoice(note: NoteEvent, time: number, bus: AudioNode): void {
    const cfg = preset.chord;
    const f = midiToFreq(note.midi);
    const detuneJitter = cfg.detuneSpread > 0 ? (Math.random() - 0.5) * cfg.detuneSpread : 0;

    const carrier = ctx.createOscillator();
    carrier.type = cfg.wave;
    carrier.frequency.value = f;
    carrier.detune.value = detuneJitter - cfg.unisonDetune;

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.Q.value = cfg.filterQ;
    voiceFilter.frequency.setValueAtTime(cfg.filterHz, time);
    if (cfg.filterEndHz !== cfg.filterHz) {
      voiceFilter.frequency.setTargetAtTime(cfg.filterEndHz, time, cfg.filterDecay);
    }

    const env = ctx.createGain();
    const peak = Math.max(0.015, note.velocity * cfg.level);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + cfg.attack);
    env.gain.setTargetAtTime(peak * cfg.sustainRatio, time + cfg.attack, cfg.decay);

    const endTime = time + note.durationBeats * spb;
    const stopAt = endTime + cfg.release + 0.12;
    env.gain.setTargetAtTime(0, Math.max(time + cfg.attack + 0.02, endTime - 0.03), Math.max(RAMP_S, cfg.release * 0.4));

    carrier.connect(voiceFilter);

    if (cfg.unisonDetune > 0) {
      const unison = ctx.createOscillator();
      unison.type = cfg.wave;
      unison.frequency.value = f;
      unison.detune.value = detuneJitter + cfg.unisonDetune;
      unison.connect(voiceFilter);
      unison.start(time);
      unison.stop(stopAt);
      registerVoice(unison, stopAt);
    }

    if (cfg.fmRatio > 0 && cfg.fmIndex > 0) {
      const modulator = ctx.createOscillator();
      modulator.type = "sine";
      modulator.frequency.value = f * cfg.fmRatio;
      const modIndex = ctx.createGain();
      modIndex.gain.setValueAtTime(f * cfg.fmIndex, time);
      modIndex.gain.setTargetAtTime(0, time, cfg.fmDecay);
      modulator.connect(modIndex).connect(carrier.frequency);
      modulator.start(time);
      modulator.stop(stopAt);
      registerVoice(modulator, stopAt);
    }

    voiceFilter.connect(env).connect(bus);
    carrier.start(time);
    carrier.stop(stopAt);
    registerVoice(carrier, stopAt);
  }

  function playMelodyVoice(note: NoteEvent, time: number): void {
    const cfg = preset.melody;
    const f = midiToFreq(note.midi);
    const carrier = ctx.createOscillator();
    carrier.type = cfg.wave;
    carrier.frequency.value = f;

    const endTime = time + note.durationBeats * spb;
    const stopAt = endTime + cfg.release + 0.25;

    if (cfg.fmRatio > 0 && cfg.fmIndex > 0) {
      const modulator = ctx.createOscillator();
      modulator.type = "sine";
      modulator.frequency.value = f * cfg.fmRatio;
      const modIndex = ctx.createGain();
      modIndex.gain.setValueAtTime(f * cfg.fmIndex, time);
      modIndex.gain.setTargetAtTime(0, time, cfg.fmDecay);
      modulator.connect(modIndex).connect(carrier.frequency);
      modulator.start(time);
      modulator.stop(stopAt);
      registerVoice(modulator, stopAt);
    }

    if (cfg.vibratoHz > 0 && cfg.vibratoDepthCents > 0) {
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = cfg.vibratoHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = cfg.vibratoDepthCents;
      lfo.connect(lfoGain).connect(carrier.detune);
      lfo.start(time);
      lfo.stop(stopAt);
      registerVoice(lfo, stopAt);
    }

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.frequency.value = cfg.filterHz;

    const env = ctx.createGain();
    const peak = Math.max(0.02, note.velocity * cfg.level);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + cfg.attack);
    if (cfg.sustainRatio > 0) {
      env.gain.setTargetAtTime(peak * cfg.sustainRatio, time + cfg.attack, cfg.decay);
      env.gain.setTargetAtTime(0, Math.max(time + cfg.attack + 0.02, endTime - 0.02), Math.max(RAMP_S, cfg.release * 0.4));
    } else {
      env.gain.setTargetAtTime(0, time + cfg.attack, cfg.decay);
    }

    carrier.connect(voiceFilter).connect(env).connect(melodicBus);
    carrier.start(time);
    carrier.stop(stopAt);
    registerVoice(carrier, stopAt);
  }

  function playBass(note: NoteEvent, time: number): void {
    const cfg = preset.bass;
    const f = midiToFreq(note.midi);
    const osc = ctx.createOscillator();
    osc.type = cfg.wave;
    if (cfg.pitchPunch > 1) {
      osc.frequency.setValueAtTime(f * cfg.pitchPunch, time);
      osc.frequency.exponentialRampToValueAtTime(f, time + 0.045);
    } else {
      osc.frequency.value = f;
    }

    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = "lowpass";
    voiceFilter.Q.value = cfg.filterQ;
    voiceFilter.frequency.setValueAtTime(cfg.filterHz, time);
    if (cfg.filterEndHz !== cfg.filterHz) {
      voiceFilter.frequency.setTargetAtTime(cfg.filterEndHz, time, cfg.filterDecay);
    }

    const env = ctx.createGain();
    const peak = note.velocity * cfg.level;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + cfg.attack);
    env.gain.setTargetAtTime(peak * cfg.sustainRatio, time + cfg.attack, cfg.decay);

    const endTime = time + note.durationBeats * spb;
    env.gain.setTargetAtTime(0, Math.max(time + 0.06, endTime - 0.04), Math.max(0.02, cfg.release * 0.5));

    const stopAt = endTime + cfg.release + 0.15;

    if (cfg.fmRatio > 0 && cfg.fmIndex > 0) {
      const modulator = ctx.createOscillator();
      modulator.type = "sine";
      modulator.frequency.value = f * cfg.fmRatio;
      const modIndex = ctx.createGain();
      modIndex.gain.setValueAtTime(f * cfg.fmIndex, time);
      modIndex.gain.setTargetAtTime(0, time, cfg.fmDecay);
      modulator.connect(modIndex).connect(osc.frequency);
      modulator.start(time);
      modulator.stop(stopAt);
      registerVoice(modulator, stopAt);
    }

    osc.connect(voiceFilter).connect(env).connect(bassBus);
    osc.start(time);
    osc.stop(stopAt);
    registerVoice(osc, stopAt);
  }

  function playDrum(note: NoteEvent, time: number): void {
    const scale = preset.drums.hatDecayScale;
    switch (note.midi) {
      case 36: playKick(note, time); break;
      case 38: playSnare(note, time); break;
      case 42: playHat(note, time, 0.025 * scale, 0.12 * scale); break;
      case 46: playHat(note, time, 0.09 * scale, 0.45 * scale); break;
    }
  }

  function playKick(note: NoteEvent, time: number): void {
    const cfg = preset.drums;
    const osc = ctx.createOscillator();
    osc.type = cfg.kickWave;
    osc.frequency.setValueAtTime(cfg.kickStartHz, time);
    osc.frequency.exponentialRampToValueAtTime(cfg.kickEndHz, time + cfg.kickSweepS);
    const env = ctx.createGain();
    env.gain.setValueAtTime(note.velocity * cfg.kickLevel, time);
    env.gain.setTargetAtTime(0, time, cfg.kickDecay);
    osc.connect(env).connect(drumsBus);
    osc.start(time);
    osc.stop(time + cfg.kickLength);
    registerVoice(osc, time + cfg.kickLength);
    // Chord-bus ducking on kick — ramped, never an abrupt jump.
    if (preset.duckAmount < 0.99) {
      const g = duckGain.gain;
      g.setTargetAtTime(preset.duckAmount, time, 0.01);
      g.setTargetAtTime(1, time + 0.06, 0.12);
    }
  }

  function playSnare(note: NoteEvent, time: number): void {
    const cfg = preset.drums;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = cfg.snareNoiseHz;
    bandpass.Q.value = cfg.snareNoiseQ;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(note.velocity * cfg.snareNoiseLevel, time);
    noiseEnv.gain.setTargetAtTime(0, time, cfg.snareNoiseDecay);
    noise.connect(bandpass).connect(noiseEnv).connect(drumsBus);
    noise.start(time);
    noise.stop(time + cfg.snareLength);
    registerVoice(noise, time + cfg.snareLength);

    const body = ctx.createOscillator();
    body.type = cfg.snareBodyWave;
    body.frequency.value = cfg.snareBodyHz;
    const bodyEnv = ctx.createGain();
    bodyEnv.gain.setValueAtTime(note.velocity * cfg.snareBodyLevel, time);
    bodyEnv.gain.setTargetAtTime(0, time, cfg.snareBodyDecay);
    body.connect(bodyEnv).connect(drumsBus);
    body.start(time);
    body.stop(time + Math.min(cfg.snareLength, cfg.snareBodyDecay * 4));
    registerVoice(body, time + Math.min(cfg.snareLength, cfg.snareBodyDecay * 4));
  }

  function playHat(note: NoteEvent, time: number, decay: number, length: number): void {
    const cfg = preset.drums;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = cfg.hatFilterType;
    filter.frequency.value = cfg.hatHz;
    filter.Q.value = cfg.hatQ;
    const env = ctx.createGain();
    env.gain.setValueAtTime(note.velocity * cfg.hatLevel, time);
    env.gain.setTargetAtTime(0, time, decay);
    noise.connect(filter).connect(env).connect(drumsBus);
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
      preset = getPresetConfig(next.preset);
      spb = 60 / next.bpm;
      loopBeats = next.bars * 4;
      beatOffset = 0;
      masterLowpass.frequency.setTargetAtTime(preset.masterLowpassHz, ctx.currentTime, 0.03);
      reverbSend.gain.setTargetAtTime(preset.reverbSend, ctx.currentTime, 0.03);
      echoSend.gain.setTargetAtTime(preset.echoSend, ctx.currentTime, 0.03);
      echoFeedback.gain.setTargetAtTime(preset.echoFeedback, ctx.currentTime, 0.03);
      echoDelay.delayTime.setTargetAtTime(Math.min(0.65, spb * preset.echoBeats), ctx.currentTime, 0.03);
      if (wasPlaying) this.play();
    },

    setFx(next: FxSettings) {
      fx = next;
      master.gain.setTargetAtTime(playing ? fx.volume * MASTER_CEILING : 0.0001, ctx.currentTime, 0.03);
    },

    dispose() {
      this.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ctx.removeEventListener("statechange", onContextStateChange);
      master.disconnect();
      compressor.disconnect();
    },
  };

  // Initialize FX state on the graph (master stays silent until play()).
  engine.setFx(fx);

  return engine;
}
