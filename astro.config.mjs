// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from "@tailwindcss/vite";
import vercel from "@astrojs/vercel";

import icon from "astro-icon";

// https://astro.build/config
export default defineConfig({
  adapter: vercel(),

  // Astro's default HTML compression strips whitespace-only text nodes that
  // contain newlines — even between INLINE elements (<strong>…), which jams
  // words in the rendered copy ("rendimiento,escalabilidad"). Disable it;
  // the size cost is a few KB.
  compressHTML: false,

  vite: {
      plugins: [tailwindcss()],
  },

  integrations: [icon()],
});