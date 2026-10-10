import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// scripts/inline-dist.mjs then folds the single JS and CSS bundle into dist/index.html.
export default defineConfig({
  plugins: [svelte()],
  build: { assetsInlineLimit: 100000000, cssCodeSplit: false }
});
