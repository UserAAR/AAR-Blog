import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { fetchPublishedPosts, type NotionPost } from "@/lib/notion";
import { getCategoryUrl } from "@utils/url-utils.ts";

// Cache to avoid multiple API calls during a single build
let _cachedAllPublishedPosts: NotionPost[] | null = null;
let _cachedBlogPosts: NotionPost[] | null = null;

function isPortfolioAboutPost(post: NotionPost): boolean {
	return (
		post.category?.trim().toLowerCase() === "portfolio" &&
		post.slug?.trim().toLowerCase() === "about"
	);
}

async function getAllPublishedPosts(): Promise<NotionPost[]> {
	if (_cachedAllPublishedPosts) return _cachedAllPublishedPosts;
	_cachedAllPublishedPosts = await fetchPublishedPosts();
	return _cachedAllPublishedPosts;
}

async function getAllBlogPosts(): Promise<NotionPost[]> {
	if (_cachedBlogPosts) return _cachedBlogPosts;
	const all = await getAllPublishedPosts();
	_cachedBlogPosts = all.filter((p) => !isPortfolioAboutPost(p));
	return _cachedBlogPosts;
}

export async function getAboutPost(): Promise<NotionPost> {
	const all = await getAllPublishedPosts();
	const about = all.find((p) => isPortfolioAboutPost(p));
	if (!about) {
		throw new Error(
			"About post not found in Notion. Expected a Published post with category='Portfolio' and slug='about'.",
		);
	}
	return about;
}

/**
 * Get sorted posts with prev/next navigation links.
 */
export async function getSortedPosts(): Promise<NotionPost[]> {
	const sorted = await getAllBlogPosts();

	// Set prev/next navigation
	for (let i = 1; i < sorted.length; i++) {
		sorted[i].nextSlug = sorted[i - 1].slug;
		sorted[i].nextTitle = sorted[i - 1].title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].prevSlug = sorted[i + 1].slug;
		sorted[i].prevTitle = sorted[i + 1].title;
	}

	return sorted;
}

export type PostForList = {
	slug: string;
	data: {
		title: string;
		tags: string[];
		category: string;
		published: Date;
	};
};

export async function getSortedPostsList(): Promise<PostForList[]> {
	const sorted = await getAllBlogPosts();

	return sorted.map((post) => ({
		slug: post.slug,
		data: {
			title: post.title,
			tags: post.tags,
			category: post.category,
			published: post.date,
		},
	}));
}

export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(): Promise<Tag[]> {
	const posts = await getAllBlogPosts();

	const countMap: { [key: string]: number } = {};
	for (const post of posts) {
		for (const tag of post.tags) {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		}
	}

	const keys = Object.keys(countMap).sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(): Promise<Category[]> {
	const posts = await getAllBlogPosts();

	const count: { [key: string]: number } = {};
	for (const post of posts) {
		if (!post.category) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
		} else {
			const categoryName = post.category.trim();
			count[categoryName] = count[categoryName]
				? count[categoryName] + 1
				: 1;
		}
	}

	const lst = Object.keys(count).sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c),
		});
	}
	return ret;
}
