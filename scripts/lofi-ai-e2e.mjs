#!/usr/bin/env node
/**
 * Live e2e for the AI lofi generator (L29): posts Spanish and English style
 * prompts to the running dev server and verifies that the generated music
 * CHANGES with the prompt and that every track is structurally valid.
 *
 * Usage:
 *   pnpm dev            # in another terminal
 *   pnpm test:ai        # or: node scripts/lofi-ai-e2e.mjs [baseUrl]
 *
 * Hits POST /api/lofi once per prompt (needs OPENROUTER_API_KEY in .env).
 */

const BASE_URL = process.argv[2] ?? process.env.LOFI_BASE_URL ?? "http://localhost:4321";
const TIMEOUT_MS = 60_000;

const PROMPTS = [
  { lang: "es", prompt: "lluvia melancólica en buenos aires" },
  { lang: "es", prompt: "noche de cumbia en la playa" },
  { lang: "en", prompt: "sunny beach morning" },
  { lang: "en", prompt: "dark cyberpunk alley" },
];

const DRUM_GM = new Set([36, 38, 42, 46]);

function fingerprint(track) {
  return JSON.stringify([track.bpm, track.key, track.swing, track.tracks]);
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function validateTrack(track, label, errors) {
  const check = (cond, msg) => {
    if (!cond) errors.push(`${label}: ${msg}`);
  };
  check(track.bars === 4, "bars must be 4");
  check(Number.isFinite(track.bpm) && track.bpm >= 55 && track.bpm <= 120, "bpm out of 55-120");
  check(Number.isFinite(track.swing) && track.swing >= 0.5 && track.swing <= 0.65, "swing out of 0.50-0.65");
  check(typeof track.seed === "string" && track.seed.length > 0, "empty seed");
  check(typeof track.key === "string" && track.key.length > 0, "empty key");
  for (const [name, range] of [["chords", [48, 76]], ["bass", [36, 47]], ["melody", [55, 86]]]) {
    const events = track.tracks?.[name] ?? [];
    check(events.length > 0, `${name} has no events`);
    for (const e of events) {
      check(e.midi >= range[0] && e.midi <= range[1], `${name} midi ${e.midi} out of ${range[0]}-${range[1]}`);
    }
  }
  check((track.tracks?.drums ?? []).length > 0, "drums has no events");
  for (const e of track.tracks.drums) check(DRUM_GM.has(e.midi), `drums midi ${e.midi} not in GM map`);
  for (const [name, events] of Object.entries(track.tracks)) {
    let prev = -1;
    for (const e of events) {
      check(e.startBeat >= 0 && e.startBeat < 16, `${name} startBeat ${e.startBeat} out of 0-16`);
      check(e.durationBeats > 0, `${name} non-positive duration`);
      check(e.velocity > 0 && e.velocity <= 1, `${name} velocity ${e.velocity} out of (0,1]`);
      check(e.startBeat >= prev, `${name} events not sorted by startBeat`);
      prev = e.startBeat;
    }
  }
}

async function main() {
  console.log(`Live AI lofi e2e against ${BASE_URL} (${PROMPTS.length} prompts, ES + EN)\n`);
  const results = [];
  const errors = [];

  for (const { lang, prompt } of PROMPTS) {
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/api/lofi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
      errors.push(`"${prompt}": request failed: ${err.message}`);
      return null;
    });
    if (!res) continue;

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.track) {
      errors.push(`"${prompt}": HTTP ${res.status} — ${payload.error ?? "no track"}`);
      continue;
    }
    const track = payload.track;
    validateTrack(track, `"${prompt}"`, errors);
    results.push({ lang, prompt, track, ms: Date.now() - started, fp: hash(fingerprint(track)) });
    console.log(
      `  [${lang}] "${prompt}" -> ${track.bpm} BPM · ${track.key} · swing ${track.swing} · seed "${track.seed}" · notes ${fingerprint(track).length}B · ${Date.now() - started}ms`,
    );
  }

  console.log("");
  if (results.length < 2) {
    errors.push(`only ${results.length} successful generations — need at least 2 to compare`);
  } else {
    const fps = results.map((r) => r.fp);
    const unique = new Set(fps);
    console.log(`Distinct tracks: ${unique.size}/${results.length}`);
    if (unique.size !== results.length) {
      const dupes = results.filter((r, i) => fps.indexOf(r.fp) !== i).map((r) => `"${r.prompt}"`);
      errors.push(`identical music for different prompts: ${dupes.join(", ")}`);
    }
    const bpms = new Set(results.map((r) => r.track.bpm));
    const keys = new Set(results.map((r) => r.track.key));
    console.log(`Distinct BPM values: ${[...bpms].join(", ")} | distinct keys: ${[...keys].join(", ")}`);
    if (bpms.size < Math.max(2, Math.ceil(results.length / 2))) {
      console.log("note: narrow BPM spread — style is uniform even when the notes differ");
    }
  }

  if (errors.length > 0) {
    console.error(`\nFAILED (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("PASS: the music changes with the prompt and every track is valid.\n");
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
