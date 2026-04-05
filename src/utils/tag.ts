/** Path segment for tag listing (UTF-8 path; Astro encodes in URLs). */
export function tagListPath(tag: string): string {
	return `/tags/${encodeURIComponent(tag)}/`;
}
