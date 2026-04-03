// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Replace with your GitHub Pages URL, e.g. https://your-username.github.io
// (user site repo: your-username.github.io — no `base` needed)
export default defineConfig({
	site: 'https://example.com',
	integrations: [mdx(), sitemap()],
});
