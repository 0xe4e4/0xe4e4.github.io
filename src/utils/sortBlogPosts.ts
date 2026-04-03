import type { CollectionEntry } from 'astro:content';

/**
 * Newest first. Same calendar day ties break by:
 * 1) `updatedDate` (newer first; missing counts as `date`)
 * 2) slug/id (stable, deterministic)
 *
 * Tip: use ISO datetime in frontmatter for intraday order, e.g.
 * `date: 2026-04-03T21:30:00`
 */
export function sortBlogPostsNewestFirst(
	posts: CollectionEntry<'blog'>[],
): CollectionEntry<'blog'>[] {
	return [...posts].sort((a, b) => {
		const byDate = b.data.date.valueOf() - a.data.date.valueOf();
		if (byDate !== 0) return byDate;

		const ua = a.data.updatedDate?.valueOf() ?? a.data.date.valueOf();
		const ub = b.data.updatedDate?.valueOf() ?? b.data.date.valueOf();
		const byUpdated = ub - ua;
		if (byUpdated !== 0) return byUpdated;

		return b.id.localeCompare(a.id);
	});
}
