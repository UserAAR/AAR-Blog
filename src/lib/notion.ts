import { Client } from "@notionhq/client";
import type {
	BlockObjectResponse,
	PageObjectResponse,
	RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import fs from "node:fs/promises";
import path from "node:path";

// ──────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────

const notion = new Client({ auth: import.meta.env.NOTION_API_KEY });
const databaseId = import.meta.env.NOTION_DATABASE_ID;

// ──────────────────────────────────────────────
// In-memory caches (build-time)
// ──────────────────────────────────────────────

const blocksCache = new Map<string, Promise<BlockObjectResponse[]>>();
const readingStatsCache = new Map<string, Promise<{ words: number; minutes: number }>>();

// Dev-only disk cache for reading stats to keep `astro dev` snappy across restarts.
// This is a cache, NOT a source of truth (Notion remains the only content source).
const diskCachePath = path.join(process.cwd(), ".notion-cache", "reading-stats.json");
let diskCacheLoaded = false;
let diskStats: Record<string, { words: number; minutes: number }> = {};
let diskCacheWritePromise: Promise<void> | null = null;

async function loadDiskCacheOnce(): Promise<void> {
	if (diskCacheLoaded || import.meta.env.PROD) return;
	diskCacheLoaded = true;
	try {
		const raw = await fs.readFile(diskCachePath, "utf8");
		diskStats = JSON.parse(raw) as typeof diskStats;
	} catch {
		// No cache yet or invalid JSON; ignore
		diskStats = {};
	}
}

async function persistDiskCache(): Promise<void> {
	if (import.meta.env.PROD) return;
	if (diskCacheWritePromise) return diskCacheWritePromise;
	diskCacheWritePromise = (async () => {
		await fs.mkdir(path.dirname(diskCachePath), { recursive: true });
		await fs.writeFile(diskCachePath, JSON.stringify(diskStats, null, 2), "utf8");
	})().finally(() => {
		diskCacheWritePromise = null;
	});
	return diskCacheWritePromise;
}

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface NotionPost {
	id: string;
	title: string;
	slug: string;
	status: string;
	category: string;
	tags: string[];
	summary: string;
	author: string;
	thumbnail: string;
	date: Date;
	updatedAt: Date;
	// Computed from blocks at build-time
	words: number;
	minutes: number;
	// Navigation (set after sorting)
	prevSlug: string;
	prevTitle: string;
	nextSlug: string;
	nextTitle: string;
}

export interface HeadingInfo {
	depth: number;
	slug: string;
	text: string;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function richTextToPlain(richText: RichTextItemResponse[]): string {
	return richText.map((t) => t.plain_text).join("");
}

function extractPageProperties(page: PageObjectResponse): Omit<NotionPost, "words" | "minutes" | "prevSlug" | "prevTitle" | "nextSlug" | "nextTitle"> {
	const props = page.properties;

	// title
	const titleProp = props.title;
	let title = "";
	if (titleProp?.type === "title") {
		title = richTextToPlain(titleProp.title);
	}

	// slug
	const slugProp = props.slug;
	let slug = "";
	if (slugProp?.type === "rich_text") {
		slug = richTextToPlain(slugProp.rich_text);
	}

	// status
	const statusProp = props.status;
	let status = "";
	if (statusProp?.type === "select" && statusProp.select) {
		status = statusProp.select.name;
	}

	// category
	const categoryProp = props.category;
	let category = "";
	if (categoryProp?.type === "select" && categoryProp.select) {
		category = categoryProp.select.name;
	}

	// tags
	const tagsProp = props.tags;
	let tags: string[] = [];
	if (tagsProp?.type === "multi_select") {
		tags = tagsProp.multi_select.map((t) => t.name);
	}

	// summary
	const summaryProp = props.summary;
	let summary = "";
	if (summaryProp?.type === "rich_text") {
		summary = richTextToPlain(summaryProp.rich_text);
	}

	// author
	const authorProp = props.author;
	let author = "";
	if (authorProp?.type === "rich_text") {
		author = richTextToPlain(authorProp.rich_text);
	} else if (authorProp?.type === "people" && authorProp.people.length > 0) {
		const person = authorProp.people[0];
		if ("name" in person && person.name) {
			author = person.name;
		}
	}

	// thumbnail
	const thumbnailProp = props.thumbnail;
	let thumbnail = "";
	if (thumbnailProp?.type === "files" && thumbnailProp.files.length > 0) {
		const file = thumbnailProp.files[0];
		if (file.type === "file") {
			thumbnail = file.file.url;
		} else if (file.type === "external") {
			thumbnail = file.external.url;
		}
	}

	// date
	const dateProp = props.date;
	let date = new Date();
	if (dateProp?.type === "date" && dateProp.date) {
		date = new Date(dateProp.date.start);
	}

	// updatedAt
	const updatedAtProp = props.updatedAt;
	let updatedAt = new Date();
	if (updatedAtProp?.type === "last_edited_time") {
		updatedAt = new Date(updatedAtProp.last_edited_time);
	}

	return {
		id: page.id,
		title,
		slug,
		status,
		category,
		tags,
		summary,
		author,
		thumbnail,
		date,
		updatedAt,
	};
}

async function asyncPool<T, R>(
	poolLimit: number,
	items: T[],
	iteratorFn: (item: T) => Promise<R>,
): Promise<R[]> {
	const ret: Promise<R>[] = [];
	const executing: Promise<void>[] = [];

	for (const item of items) {
		const p = Promise.resolve().then(() => iteratorFn(item));
		ret.push(p);

		if (poolLimit <= items.length) {
			const e: Promise<void> = p.then(() => undefined);
			executing.push(e);
			if (executing.length >= poolLimit) {
				await Promise.race(executing);
				// remove settled promises
				for (let i = executing.length - 1; i >= 0; i--) {
					// eslint-disable-next-line @typescript-eslint/no-floating-promises
					executing[i].then(
						() => executing.splice(i, 1),
						() => executing.splice(i, 1),
					);
				}
			}
		}
	}

	return Promise.all(ret);
}

// ──────────────────────────────────────────────
// Data Fetching
// ──────────────────────────────────────────────

/**
 * Fetch all Published posts from the Notion Blogs database.
 * Fast: only fetches page properties.
 *
 * Reading stats (words/minutes) are computed lazily per page/post via `fetchPageReadingStats`.
 * This keeps `astro dev` fast and avoids fetching blocks for every post on first load.
 */
export async function fetchPublishedPosts(): Promise<NotionPost[]> {
	const pages: PageObjectResponse[] = [];
	let cursor: string | undefined = undefined;

	// Paginate through all results
	do {
		const response = await notion.databases.query({
			database_id: databaseId,
			filter: {
				property: "status",
				select: {
					equals: "Published",
				},
			},
			sorts: [
				{
					property: "date",
					direction: "descending",
				},
			],
			start_cursor: cursor,
		});

		for (const page of response.results) {
			if ("properties" in page) {
				pages.push(page as PageObjectResponse);
			}
		}

		cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
	} while (cursor);

	const basePosts = pages.map((page) => extractPageProperties(page));

	const posts: NotionPost[] = basePosts.map((props) => ({
		...props,
		words: 0,
		minutes: 0,
		prevSlug: "",
		prevTitle: "",
		nextSlug: "",
		nextTitle: "",
	}));

	return posts;
}

/**
 * Fetch all blocks for a given Notion page, including nested children.
 */
export async function fetchPageBlocks(pageId: string): Promise<BlockObjectResponse[]> {
	const cached = blocksCache.get(pageId);
	if (cached) return cached;

	const p = (async () => {
		const blocks: BlockObjectResponse[] = [];
		let cursor: string | undefined = undefined;

		do {
			const response = await notion.blocks.children.list({
				block_id: pageId,
				start_cursor: cursor,
				page_size: 100,
			});

			for (const block of response.results) {
				if ("type" in block) {
					const b = block as BlockObjectResponse;
					blocks.push(b);

					// Recursively fetch children if block has them
					if (b.has_children) {
						const children = await fetchPageBlocks(b.id);
						(b as any)._children = children;
					}
				}
			}

			cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
		} while (cursor);

		return blocks;
	})();

	blocksCache.set(pageId, p);
	return p;
}

/**
 * Extract plain text from all blocks (for word count / reading time).
 */
export function extractPlainTextFromBlocks(blocks: BlockObjectResponse[]): string {
	const parts: string[] = [];

	for (const block of blocks) {
		const b = block as any;
		const type = block.type;

		// Most block types have a rich_text array
		const richTextContainers = [
			"paragraph",
			"heading_1",
			"heading_2",
			"heading_3",
			"bulleted_list_item",
			"numbered_list_item",
			"to_do",
			"toggle",
			"callout",
			"quote",
		];

		if (richTextContainers.includes(type) && b[type]?.rich_text) {
			parts.push(richTextToPlain(b[type].rich_text));
		}

		if (type === "code" && b.code?.rich_text) {
			parts.push(richTextToPlain(b.code.rich_text));
		}

		// Recurse into children
		if (b._children) {
			parts.push(extractPlainTextFromBlocks(b._children));
		}
	}

	return parts.join(" ");
}

export async function fetchPageReadingStats(
	pageId: string,
): Promise<{ words: number; minutes: number }> {
	const cached = readingStatsCache.get(pageId);
	if (cached) return cached;

	const p = (async () => {
		await loadDiskCacheOnce();
		if (!import.meta.env.PROD) {
			const fromDisk = diskStats[pageId];
			if (fromDisk) return fromDisk;
		}

		const blocks = await fetchPageBlocks(pageId);
		const plainText = extractPlainTextFromBlocks(blocks);
		const words = plainText.split(/\s+/).filter(Boolean).length;
		const minutes = Math.max(1, Math.round(words / 200));

		const stats = { words, minutes };
		if (!import.meta.env.PROD) {
			diskStats[pageId] = stats;
			// Fire-and-forget persistence (kept serialized by persistDiskCache)
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			persistDiskCache();
		}
		return stats;
	})();

	readingStatsCache.set(pageId, p);
	return p;
}

export async function fetchReadingStatsForPosts(
	posts: Array<{ id: string }>,
	poolLimit = 4,
): Promise<Map<string, { words: number; minutes: number }>> {
	const stats = await asyncPool(poolLimit, posts, async (p) => {
		const s = await fetchPageReadingStats(p.id);
		return { id: p.id, ...s };
	});
	return new Map(stats.map((s) => [s.id, { words: s.words, minutes: s.minutes }]));
}
