import { defineConfig } from 'vite';

// Relative asset paths, so the same build works at a domain root and under /<repo>/ on GitHub Pages.
export default defineConfig({ base: './' });
