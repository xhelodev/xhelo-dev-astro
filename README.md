# Astro Starter Kit: Minimal

```sh
npm create astro@latest -- --template minimal
```

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/withastro/astro/tree/latest/examples/minimal)
[![Open with CodeSandbox](https://assets.codesandbox.io/github/button-edit-lime.svg)](https://codesandbox.io/p/sandbox/github/withastro/astro/tree/latest/examples/minimal)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/withastro/astro?devcontainer_path=.devcontainer/minimal/devcontainer.json)

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally                       |
| `npm test`                | Run the vitest suite (lofi engine + exporter)    |
| `npm run test:ai`         | Live AI e2e: ES/EN prompts vs `pnpm dev` — asserts the music changes and tracks stay valid |
| `npm run typecheck`       | Typecheck `.ts`/`.astro` sources (`astro check`)  |

## 🎵 16-BIT RADIO — AI lofi generator

The home page embeds a compact bar player: type a style prompt (ES or EN) and
an AI model composes a track, which the Web Audio API synthesizes live — no
audio files are ever stored or served. The composition can be exported as a
General MIDI `.mid` (loops 4×) for any DAW.

### Sharing tracks

Click the track name to copy a share link (`/?t=<id>`). The composition
(a few KB of notes, not audio) is cached server-side in Upstash Redis with a
**7-day sliding TTL**: every listen refreshes the expiry, and a track nobody
opens for 7 days is evicted automatically. Opening a link loads the track
ready to play — no autoplay, since browsers require a user gesture.

- `src/lib/lofi/ai-track.ts` — prompts and compiles the AI composition
- `src/lib/lofi/presets.ts` — synth presets (snes-rpg, genesis-fm, …)
- `src/lib/lofi/generator.ts` — pure deterministic composition (seed → PRNG → notes)
- `src/lib/lofi/audio-engine.ts` — browser-only Web Audio engine
- `src/lib/lofi/midi-export.ts` — lazy `.mid` export via `@tonejs/midi`
- `src/lib/lofi/track-store.ts` — share-cache validation + Upstash REST client
- `src/components/LofiPlayer.astro` — the island UI
- `src/pages/api/lofi.ts`, `src/pages/api/tracks.ts` (+ `tracks/[id].ts`) — SSR endpoints

Nothing audio-related loads until the first click (dynamic imports), and the
`AudioContext` is created synchronously inside the click handler for iOS Safari.

### Environment variables (SSR endpoints)

| Variable | Endpoint | Purpose |
| :-- | :-- | :-- |
| `OPENROUTER_API_KEY` | `/api/lofi` | OpenRouter key for the AI composition (503 when unset) |
| `OPENROUTER_MODEL` | `/api/lofi` | Optional model override (default `deepseek/deepseek-v4.1-flash-1017`) |
| `UPSTASH_REDIS_REST_URL` | `/api/tracks` | Upstash Redis REST endpoint for the share cache (503 when unset) |
| `UPSTASH_REDIS_REST_TOKEN` | `/api/tracks` | Upstash Redis REST token |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
