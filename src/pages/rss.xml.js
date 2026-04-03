import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { sortBlogPostsNewestFirst } from '../utils/sortBlogPosts';

export async function GET(context) {
	const posts = sortBlogPostsNewestFirst(await getCollection('blog'));
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description ?? '',
			pubDate: post.data.date,
			link: `/blog/${post.id}/`,
		})),
	});
}
