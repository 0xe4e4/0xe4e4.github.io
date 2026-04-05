import type { CollectionEntry } from 'astro:content';

/** Years (descending) that have posts, capped for sidebar */
export function getRecentYearsWithPosts(
	posts: CollectionEntry<'blog'>[],
	maxYears = 3,
): number[] {
	const years = new Set<number>();
	for (const p of posts) {
		years.add(p.data.date.getFullYear());
	}
	return [...years].sort((a, b) => b - a).slice(0, maxYears);
}

export function getMonthsForYear(
	posts: CollectionEntry<'blog'>[],
	year: number,
): number[] {
	const months = new Set<number>();
	for (const p of posts) {
		const d = p.data.date;
		if (d.getFullYear() === year) {
			months.add(d.getMonth() + 1);
		}
	}
	return [...months].sort((a, b) => b - a);
}

/** All (year, month) pairs that have at least one post */
export function getYearMonthKeys(posts: CollectionEntry<'blog'>[]): Array<{
	year: number;
	month: string;
}> {
	const keys = new Map<string, { year: number; month: string }>();
	for (const p of posts) {
		const d = p.data.date;
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		keys.set(`${y}-${m}`, { year: y, month: m });
	}
	return [...keys.values()].sort((a, b) => {
		if (a.year !== b.year) return b.year - a.year;
		return parseInt(b.month, 10) - parseInt(a.month, 10);
	});
}
