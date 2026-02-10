import type {
	BlockObjectResponse,
	RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import type { HeadingInfo } from "./notion";

// ──────────────────────────────────────────────
// Rich Text → HTML
// ──────────────────────────────────────────────

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function richTextToHtml(richText: RichTextItemResponse[]): string {
	return richText
		.map((item) => {
			let text = escapeHtml(item.plain_text);

			// Preserve newlines
			text = text.replace(/\n/g, "<br/>");

			if (item.type === "text" && item.text.link) {
				text = `<a href="${escapeHtml(item.text.link.url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
			}

			if (item.annotations.bold) text = `<strong>${text}</strong>`;
			if (item.annotations.italic) text = `<em>${text}</em>`;
			if (item.annotations.strikethrough) text = `<s>${text}</s>`;
			if (item.annotations.underline) text = `<u>${text}</u>`;
			if (item.annotations.code)
				text = `<code class="inline-code">${text}</code>`;

			if (item.annotations.color && item.annotations.color !== "default") {
				const color = item.annotations.color;
				if (color.endsWith("_background")) {
					text = `<span class="notion-color-bg-${color.replace("_background", "")}">${text}</span>`;
				} else {
					text = `<span class="notion-color-${color}">${text}</span>`;
				}
			}

			return text;
		})
		.join("");
}

// ──────────────────────────────────────────────
// Slug generation for headings
// ──────────────────────────────────────────────

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// ──────────────────────────────────────────────
// Block → HTML (main renderer)
// ──────────────────────────────────────────────

interface RenderContext {
	headings: HeadingInfo[];
	slugCounts: Map<string, number>;
}

function getUniqueSlug(text: string, ctx: RenderContext): string {
	let slug = slugify(text);
	if (!slug) slug = "heading";
	const count = ctx.slugCounts.get(slug) || 0;
	ctx.slugCounts.set(slug, count + 1);
	return count === 0 ? slug : `${slug}-${count}`;
}

function renderRichTextBlock(
	tag: string,
	richText: RichTextItemResponse[],
): string {
	const content = richTextToHtml(richText);
	return `<${tag}>${content}</${tag}>`;
}

function renderHeading(
	block: any,
	level: 1 | 2 | 3,
	ctx: RenderContext,
): string {
	const key = `heading_${level}`;
	const richText = block[key]?.rich_text ?? [];
	const text = richText.map((t: any) => t.plain_text).join("");
	const slug = getUniqueSlug(text, ctx);
	const html = richTextToHtml(richText);

	ctx.headings.push({ depth: level, slug, text });

	return `<section><h${level} id="${slug}">${html}<a class="anchor" href="#${slug}"><span class="anchor-icon" data-pagefind-ignore>#</span></a></h${level}>`;
}

function renderChildren(blocks: BlockObjectResponse[], ctx: RenderContext): string {
	return renderBlocksToHtml(blocks, ctx);
}

function renderBlock(block: BlockObjectResponse, ctx: RenderContext): string {
	const b = block as any;
	const type = block.type;

	switch (type) {
		case "paragraph":
			return renderRichTextBlock("p", b.paragraph.rich_text);

		case "heading_1":
			return renderHeading(b, 1, ctx);

		case "heading_2":
			return renderHeading(b, 2, ctx);

		case "heading_3":
			return renderHeading(b, 3, ctx);

		case "bulleted_list_item": {
			const content = richTextToHtml(b.bulleted_list_item.rich_text);
			let childrenHtml = "";
			if (b._children?.length) {
				childrenHtml = `<ul>${renderChildren(b._children, ctx)}</ul>`;
			}
			return `<li>${content}${childrenHtml}</li>`;
		}

		case "numbered_list_item": {
			const content = richTextToHtml(b.numbered_list_item.rich_text);
			let childrenHtml = "";
			if (b._children?.length) {
				childrenHtml = `<ol>${renderChildren(b._children, ctx)}</ol>`;
			}
			return `<li>${content}${childrenHtml}</li>`;
		}

		case "to_do": {
			const checked = b.to_do.checked;
			const content = richTextToHtml(b.to_do.rich_text);
			return `<div class="notion-to-do"><input type="checkbox" disabled ${checked ? "checked" : ""}/><span${checked ? ' class="line-through opacity-50"' : ""}>${content}</span></div>`;
		}

		case "toggle": {
			const summary = richTextToHtml(b.toggle.rich_text);
			let childrenHtml = "";
			if (b._children?.length) {
				childrenHtml = renderChildren(b._children, ctx);
			}
			return `<details class="notion-toggle"><summary>${summary}</summary><div class="toggle-content">${childrenHtml}</div></details>`;
		}

		case "code": {
			const code = b.code.rich_text
				.map((t: any) => t.plain_text)
				.join("");
			const lang = b.code.language || "";
			const caption = b.code.caption?.length
				? richTextToHtml(b.code.caption)
				: "";
			return `<div class="notion-code-block"><pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>${caption ? `<div class="code-caption">${caption}</div>` : ""}</div>`;
		}

		case "image": {
			let url = "";
			if (b.image.type === "file") {
				url = b.image.file.url;
			} else if (b.image.type === "external") {
				url = b.image.external.url;
			}
			const caption = b.image.caption?.length
				? richTextToHtml(b.image.caption)
				: "";
			return `<figure class="notion-image"><img src="${escapeHtml(url)}" alt="${caption ? escapeHtml(b.image.caption.map((c: any) => c.plain_text).join("")) : ""}" loading="lazy"/>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
		}

		case "divider":
			return "<hr/>";

		case "quote": {
			const content = richTextToHtml(b.quote.rich_text);
			let childrenHtml = "";
			if (b._children?.length) {
				childrenHtml = renderChildren(b._children, ctx);
			}
			return `<blockquote>${content}${childrenHtml}</blockquote>`;
		}

		case "callout": {
			const icon = b.callout.icon;
			let iconHtml = "";
			if (icon?.type === "emoji") {
				iconHtml = `<span class="callout-icon">${icon.emoji}</span>`;
			} else if (icon?.type === "external") {
				iconHtml = `<span class="callout-icon"><img src="${escapeHtml(icon.external.url)}" alt="" class="inline w-5 h-5"/></span>`;
			}
			const content = richTextToHtml(b.callout.rich_text);
			let childrenHtml = "";
			if (b._children?.length) {
				childrenHtml = renderChildren(b._children, ctx);
			}
			const color = b.callout.color || "default";
			return `<div class="notion-callout notion-callout-${color}">${iconHtml}<div class="callout-content">${content}${childrenHtml}</div></div>`;
		}

		case "bookmark": {
			const url = b.bookmark.url;
			const caption = b.bookmark.caption?.length
				? richTextToHtml(b.bookmark.caption)
				: url;
			return `<div class="notion-bookmark"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${caption}</a></div>`;
		}

		case "embed": {
			const url = b.embed.url;
			return `<div class="notion-embed"><iframe src="${escapeHtml(url)}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
		}

		case "video": {
			let url = "";
			if (b.video.type === "file") {
				url = b.video.file.url;
			} else if (b.video.type === "external") {
				url = b.video.external.url;
			}
			// YouTube embed
			if (url.includes("youtube.com") || url.includes("youtu.be")) {
				const videoId = extractYouTubeId(url);
				if (videoId) {
					return `<div class="notion-video"><iframe src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
				}
			}
			return `<div class="notion-video"><video src="${escapeHtml(url)}" controls></video></div>`;
		}

		case "table": {
			if (!b._children?.length) return "";
			const hasColumnHeader = b.table.has_column_header;
			const hasRowHeader = b.table.has_row_header;
			let html = '<table class="notion-table">';

			for (let i = 0; i < b._children.length; i++) {
				const row = b._children[i] as any;
				if (row.type !== "table_row") continue;
				const cells = row.table_row.cells;
				const isHeaderRow = hasColumnHeader && i === 0;
				html += "<tr>";
				for (let j = 0; j < cells.length; j++) {
					const isHeaderCell = isHeaderRow || (hasRowHeader && j === 0);
					const tag = isHeaderCell ? "th" : "td";
					html += `<${tag}>${richTextToHtml(cells[j])}</${tag}>`;
				}
				html += "</tr>";
			}

			html += "</table>";
			return html;
		}

		case "table_of_contents":
			// We handle TOC via the sidebar, so skip
			return "";

		case "column_list": {
			if (!b._children?.length) return "";
			const cols = b._children
				.map((col: any) => {
					const colChildren = col._children || [];
					return `<div class="notion-column">${renderChildren(colChildren, ctx)}</div>`;
				})
				.join("");
			return `<div class="notion-column-list">${cols}</div>`;
		}

		case "column":
			// Handled by column_list
			return "";

		case "synced_block": {
			if (b._children?.length) {
				return renderChildren(b._children, ctx);
			}
			return "";
		}

		case "link_preview": {
			const url = b.link_preview?.url || "";
			return `<div class="notion-link-preview"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>`;
		}

		case "equation": {
			const expression = b.equation?.expression || "";
			return `<div class="notion-equation">$$${escapeHtml(expression)}$$</div>`;
		}

		default:
			// Unknown block type - render as empty
			return `<!-- unsupported block type: ${type} -->`;
	}
}

function extractYouTubeId(url: string): string | null {
	const patterns = [
		/(?:youtube\.com\/watch\?v=)([^&\s]+)/,
		/(?:youtu\.be\/)([^?\s]+)/,
		/(?:youtube\.com\/embed\/)([^?\s]+)/,
	];
	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) return match[1];
	}
	return null;
}

// ──────────────────────────────────────────────
// List grouping helper
// ──────────────────────────────────────────────

function groupListItems(blocks: BlockObjectResponse[]): (BlockObjectResponse | { type: "list_group"; listType: "ul" | "ol"; items: BlockObjectResponse[] })[] {
	const result: any[] = [];
	let currentList: { type: "list_group"; listType: "ul" | "ol"; items: BlockObjectResponse[] } | null = null;

	for (const block of blocks) {
		if (block.type === "bulleted_list_item") {
			if (currentList && currentList.listType === "ul") {
				currentList.items.push(block);
			} else {
				if (currentList) result.push(currentList);
				currentList = { type: "list_group", listType: "ul", items: [block] };
			}
		} else if (block.type === "numbered_list_item") {
			if (currentList && currentList.listType === "ol") {
				currentList.items.push(block);
			} else {
				if (currentList) result.push(currentList);
				currentList = { type: "list_group", listType: "ol", items: [block] };
			}
		} else {
			if (currentList) {
				result.push(currentList);
				currentList = null;
			}
			result.push(block);
		}
	}

	if (currentList) result.push(currentList);

	return result;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

function renderBlocksToHtml(blocks: BlockObjectResponse[], ctx: RenderContext): string {
	const grouped = groupListItems(blocks);
	const parts: string[] = [];

	for (const item of grouped) {
		if ("type" in item && item.type === "list_group") {
			const tag = item.listType;
			const inner = item.items
				.map((b: BlockObjectResponse) => renderBlock(b, ctx))
				.join("");
			parts.push(`<${tag}>${inner}</${tag}>`);
		} else {
			parts.push(renderBlock(item as BlockObjectResponse, ctx));
		}
	}

	return parts.join("\n");
}

export function renderNotionBlocks(blocks: BlockObjectResponse[]): {
	html: string;
	headings: HeadingInfo[];
} {
	const ctx: RenderContext = {
		headings: [],
		slugCounts: new Map(),
	};

	const html = renderBlocksToHtml(blocks, ctx);

	return { html, headings: ctx.headings };
}
