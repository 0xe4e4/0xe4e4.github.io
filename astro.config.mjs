// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import rehypeSlug from 'rehype-slug';

const site = 'https://0xe4e4.github.io';
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isUserSiteRepo = repoName === '0xe4e4.github.io';

// GitHub Actions:
// - user site repo (0xe4e4.github.io): base "/"
// - project repo (other name): base "/<repo>"
export default defineConfig({
	site,
	base: isUserSiteRepo ? '/' : repoName ? `/${repoName}` : '/',
	markdown: {
		rehypePlugins: [rehypeSlug],
	},
	integrations: [mdx(), sitemap()],
});
