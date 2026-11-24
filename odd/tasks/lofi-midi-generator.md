# Lofi MIDI Generator — ODD feature document

Objective: random lofi MIDI music generator for the personal Astro site — client-side seeded generation, Web Audio playback, `.mid` export.
Branch: `feat/lofi-midi-generator` (from `master`). Delivery strategy: `ask-on-risk`. Forecast: ~1,100 authored changed lines (3–4 work-unit commits).
Test runner: `npm test` (vitest, node environment, `src/**/*.test.ts`). Package manager: yarn 1 lockfile, install via `npx -y yarn@1.22.22` (no global yarn binary).

## Specs

- S1 — User request (verbatim): «consulta con agy neon como podriamos imlementarle un genrador aleatroio de musica midi lofi, solo como plan q recomendaria» → deliverable: a random lofi MIDI music generator, planned with agy (Gemini 4 Neon).
- S2 — User authorization (verbatim): «hazlo» — implement the agy-recommended plan (relayed 2026-11-23, consult exit 0) as the binding design, summarized in S3–S8.
- S3 — Architecture: 100% client-side. `generateLofiTrack(seed)` is pure, SSR-safe TypeScript producing a deterministic `LofiTrack`; the shared contract lives in `src/lib/lofi/types.ts` (frozen by parent; workers request changes, never edit it). The Web Audio engine and the `.mid` exporter both consume the same `LofiTrack`. No React/Preact — vanilla Astro island only. Zero audio code loaded until first user interaction (dynamic `import()` on Play/Export click).
- S4 — Determinism: string seed → hash (xmur3 or FNV-1a) → mulberry32 PRNG (~10 lines); every musical decision derives from that PRNG. Same seed ⇒ identical `LofiTrack`. Tracks are URL-shareable via `?seed=`.
- S5 — Musical model (lofi):
  - BPM 70–84 (sweet spot 74–80); warm keys (F, Eb, Db, Bb, C, Ab) in major, dorian or aeolian.
  - 6–10 curated 4-bar progression templates with 7th/9th/11th voicings, e.g. `ii9→V13→Imaj9→VI7#9`, `IVmaj7→iii7→vi9→ii9`, `Imaj9→vi9→ii9→V7alt`, `IVmaj9→iv9→Imaj9→Imaj9`.
  - Voice leading: chord tones clustered MIDI 48–72 (drop-2 or rootless voicings); bass root MIDI 36–47.
  - Swing 55–62% on off-beat 8ths/16ths; strum spread 10–25 ms between chord notes (encoded in `startBeat`); snares pushed 8–15 ms late; velocity jitter ±12%.
  - Boom-bap drums: 16-step grid, 3–4 curated templates + bar-4 variation; kick on beat 1 + syncopated 2-and/3-and + occasional ghost kicks; snare/rimshot on 2 & 4 + rare soft ghost; hats on 8ths with alternating accent/ghost velocities, sparse open hat on 4-and. GM drum map: 36 kick, 38 snare, 42 closed hat, 46 open hat.
  - Sparse melody from current chord tones + pentatonic, 60–70% rest probability.
- S6 — Audio engine (browser-only `audio-engine.ts`): lookahead scheduler (25 ms tick, 150–250 ms lookahead on `audioContext.currentTime`); warm electric-piano voice (2-op FM or detuned triangle+sine through a low-pass envelope); bass synth; synthesized kick (pitch-enveloped sine), snare (bandpassed noise + short triangle body), hats (high-passed noise bursts); master low-pass 2.8–4.2 kHz; tape wobble (LFO 0.4–1.0 Hz modulating a ~8 ms ±2 ms `DelayNode`); procedural vinyl crackle (pre-generated 4 s looped buffer of brown noise + sparse impulses, bandpass 1.5–4 kHz, ≈ −26 dB); soft `tanh` `WaveShaperNode` saturation + `DynamicsCompressorNode` with light chord-bus ducking on kick. Pause/stop use 10–25 ms gain ramps (`setTargetAtTime`); one `AudioContext` reused across regenerations; guard background-tab catch-up bursts on `visibilitychange` (cap/resync `nextNoteTime`); sync UI from `onstatechange` for iOS interruptions. Never start audio without an explicit user gesture.
- S7 — `.mid` export (browser-only `midi-export.ts`): SMF Type-1 with GM mapping — ch 0 Electric Piano (program 4), ch 1 Electric Bass (33), ch 2 Vibraphone melody (11), ch 9 percussion; loop the composition 4–8× (16–32 usable bars); lazy `import('@tonejs/midi')` on export click; `Blob` with type `audio/midi`, synthetic `<a download="lofi-<seed>.mid">`, then `URL.revokeObjectURL`. UI copy clarifies it exports the composition (notes/swing/velocities), not the synthesized vinyl audio.
- S8 — UI (Astro): `LofiPlayer.astro` vanilla island (Tailwind 4, site CSS vars, dark theme, ES/ES lang via existing Alpine `language` state may be reused but the island itself stays framework-free) on a dedicated `/lofi` page (`src/pages/lofi.astro`). Controls: Play/Pause, Regenerate, seed display + copy/share link, BPM/key readout, Crackle/Wobble toggles, volume. iOS Safari rule: create and `resume()` the `AudioContext` synchronously inside the click handler BEFORE any `await import(...)`. Seed initialized from `?seed=` (else generated client-side), updated via `history.replaceState` on Regenerate. `ClientRouter` (View Transitions) is active site-wide: stop the scheduler cleanly on `astro:before-swap` (dedicated page; no `transition:persist` in v1). Accessibility: keyboard-operable controls, `aria-pressed` on toggles, respect `prefers-reduced-motion`.
- S9 — Checks: vitest unit tests for the pure engine — determinism (same seed ⇒ identical output; different seeds differ), MIDI range validity (all notes 0–127; drums restricted to the GM map above), spec ranges (BPM 70–84, swing 0.55–0.62, chords within 48–72, bass within 36–47), event ordering (`startBeat` non-negative, durations > 0). `npm run build` green; `npm run dev` manual smoke on `/lofi`; README updated with the feature and commands.

## Tasks

- T1 — S3: Contract + tooling: this document, `src/lib/lofi/types.ts`, `vitest.config.ts`, `test` script, deps (`@tonejs/midi`, `vitest`). Route: parent (inline). Commit: pending.
- T2 — S4+S5: Pure engine — `src/lib/lofi/prng.ts`, `theory.ts`, `generator.ts` + vitest tests (RED→GREEN). Route: gentle-ai-worker A. Commit: pending.
- T3 — S6: `src/lib/lofi/audio-engine.ts` — scheduler, voices, DSP chain. Route: gentle-ai-worker B. Commit: pending.
- T4 — S7: `src/lib/lofi/midi-export.ts` — `.mid` download. Route: parent (inline). Commit: pending.
- T5 — S8: `src/components/LofiPlayer.astro` + `src/pages/lofi.astro` + wiring. Route: parent (inline). Commit: pending.
- T6 — S9: QA + close — full suite, `npm run build`, dev smoke on `/lofi`, README. Route: parent (inline). Commit: pending.

## Log

- L1 (2026-11-23, verbatim): «consulta con agy neon como podriamos imlementarle un genrador aleatroio de musica midi lofi, solo como plan q recomendaria»
- L2 (2026-11-23): agy consult (`gemini-4-neon-high`, `--mode plan`, exit 0 after one permission-denied retry with a no-tools prompt) produced the full architecture plan: client-side deterministic generation + live Web Audio synthesis, library trade-offs (skip Tone.js/Smplr; raw Web Audio + lazy `@tonejs/midi`), lofi musical model, `.mid` export, Astro integration, 5 phases (~14–22 h), risks (autoplay, iOS gesture token, background-tab throttling, context limits, sample licensing). Relayed to user with parent endorsement.
- L3 (2026-11-23, verbatim): «hazlo» — user authorizes implementation of the agy plan. Branch `feat/lofi-midi-generator` created; `@tonejs/midi@2.0.28` + `vitest@5.1.1` installed via `npx -y yarn@1.22.22` (repo uses yarn 1 lockfile; no global yarn binary).
