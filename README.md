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
| `npm run typecheck`       | Typecheck `.ts`/`.astro` sources (`astro check`)  |

## 🎵 Lofi MIDI Generator

`/lofi` hosts a seeded, client-side lofi hip-hop generator: the same seed always
produces the same track (share it via the `?seed=` URL), audio is synthesized
live with the Web Audio API, and the composition can be downloaded as a
General MIDI `.mid` (loops 4×) for any DAW.

- `src/lib/lofi/generator.ts` — pure deterministic composition (seed → PRNG → chords/bass/drums/melody with swing, strum and laid-back snares baked into fractional beats)
- `src/lib/lofi/audio-engine.ts` — browser-only Web Audio engine (lookahead scheduler, FM electric piano, synthesized drums, tape wobble, vinyl crackle, saturation)
- `src/lib/lofi/midi-export.ts` — lazy `.mid` export via `@tonejs/midi`
- `src/components/LofiPlayer.astro` — the island UI

Nothing audio-related loads until the first click (dynamic imports), and the
`AudioContext` is created synchronously inside the click handler for iOS Safari.
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
