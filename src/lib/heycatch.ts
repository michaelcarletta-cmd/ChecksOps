import DOMPurify from "dompurify";

/**
 * HeyCatch blog client (https://heycatch.ai/blog-agents.md).
 *
 * HeyCatch writes the articles; /blog and /blog/:slug read them live from its API and render
 * them in the marketing site's design. Nothing is copied into the database or the repo.
 *
 * The key is HeyCatch's *publishable* key: read-only, limited to this site's published
 * articles, and meant to ship in browser code. The site is a static SPA on S3/CloudFront with no
 * server for these pages, so the browser calls the API directly. VITE_HEYCATCH_API_KEY overrides
 * the inlined value (the guarded production build sets its VITE_ values in the workflow, not in
 * an env file, so the literal is what production uses).
 */
export const HEYCATCH_API_BASE = "https://api.heycatch.ai/v1";
export const HEYCATCH_API_KEY: string =
  (import.meta.env.VITE_HEYCATCH_API_KEY as string | undefined) || "hck_lv_87e023a423cb3e68038c1816";

export const BLOG_PATH = "/blog";

/** Head values for /blog (set in the browser; the articles are live, so there is no build-time head). */
export const BLOG_INDEX_PAGE = {
  path: BLOG_PATH,
  title: "Blog - ChecksOps",
  description:
    "Articles on claim check workflow, endorsements, deposits and loss drafts for public adjusting firms and their restoration partners.",
};

const PAGE_SIZE = 50;
/** Safety stop for the pagination loop: 100 pages = 5,000 articles. */
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 10_000;

export interface BlogArticleSummary {
  id: string;
  slug: string;
  title: string;
  meta_description: string;
  /** ISO date, e.g. "2026-10-14". */
  published: string;
  updated: string;
  /** Minutes. */
  read_time: number;
  keywords: string[];
  featured_image: string;
  language: string;
  published_at: string;
  updated_at: string;
  hero_image_url: string;
}

export interface BlogArticle extends BlogArticleSummary {
  content_html: string;
  jsonLd: Record<string, unknown> | null;
}

interface ListResponse {
  articles: BlogArticleSummary[];
  total: number;
  limit: number;
  offset: number;
}

export class HeyCatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HeyCatchError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One GET with the key as the `key` query parameter and no custom headers (a simple, CDN-cached
 * request). A 429 waits Retry-After and tries exactly once more; anything else non-2xx throws.
 */
async function getJson<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${HEYCATCH_API_BASE}${path}`);
  url.searchParams.set("key", HEYCATCH_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get("Retry-After"));
      await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 2000);
      continue;
    }
    throw new HeyCatchError(res.status, `HeyCatch ${path} answered ${res.status}`);
  }
  throw new HeyCatchError(429, `HeyCatch ${path} is rate limited`);
}

/** Every published article, newest first: keeps paging by 50 until `total` is reached. */
export async function fetchAllArticles(): Promise<BlogArticleSummary[]> {
  const all: BlogArticleSummary[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<ListResponse>("/articles", { limit: PAGE_SIZE, offset });
    const batch = data.articles ?? [];
    all.push(...batch);
    offset += PAGE_SIZE;
    if (batch.length === 0 || offset >= (data.total ?? 0)) break;
  }
  return all;
}

/** Whether any article is published (drives the "Blog" nav link). */
export async function fetchArticleCount(): Promise<number> {
  const data = await getJson<ListResponse>("/articles", { limit: 1, offset: 0 });
  return data.total ?? 0;
}

/** One article by slug, or null when HeyCatch says it does not exist (404). */
export async function fetchArticle(slug: string): Promise<BlogArticle | null> {
  try {
    const data = await getJson<{ article: BlogArticle }>(`/articles/${encodeURIComponent(slug)}`);
    return data.article ?? null;
  } catch (err) {
    if (err instanceof HeyCatchError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Sanitises content_html: keeps headings (with the h2 ids the table of contents links to),
 * paragraphs, lists, tables, links, blockquotes, strong/em/code; drops scripts, styles, iframes,
 * on* handlers and javascript: URLs.
 */
export function sanitizeArticleHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "ul", "ol", "li", "a", "blockquote",
      "strong", "b", "em", "i", "u", "s", "code", "pre", "table", "thead", "tbody", "tfoot",
      "tr", "th", "td", "caption", "sup", "sub", "span", "div", "img", "figure", "figcaption",
    ],
    ALLOWED_ATTR: ["href", "title", "id", "colspan", "rowspan", "scope", "src", "alt", "rel", "target"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "h1"],
    ALLOW_DATA_ATTR: false,
  });
}

export interface TocEntry {
  id: string;
  text: string;
}

export interface PreparedArticleHtml {
  /** "Key takeaways" heading and its list, or "" when the article has none. */
  takeawaysHtml: string;
  /** Everything after the takeaways, in order (body, then FAQ). */
  bodyHtml: string;
  toc: TocEntry[];
}

/**
 * Sanitises the article, then splits it after the Key takeaways list so the table of contents
 * can sit between them. TOC entries are read from the sanitised HTML: every h2 with an id except
 * "faq", ids never renamed.
 */
export function prepareArticleHtml(contentHtml: string): PreparedArticleHtml {
  const clean = sanitizeArticleHtml(contentHtml);
  const root = document.createElement("div");
  root.innerHTML = clean;

  const toc: TocEntry[] = Array.from(root.querySelectorAll("h2[id]"))
    .filter((h) => h.id && h.id !== "faq")
    .map((h) => ({ id: h.id, text: (h.textContent ?? "").trim() }))
    .filter((e) => e.text.length > 0);

  let takeawaysHtml = "";
  const first = root.firstElementChild;
  if (first && first.tagName === "H2" && !first.id && /key takeaways/i.test(first.textContent ?? "")) {
    const list = first.nextElementSibling;
    const head = document.createElement("div");
    head.appendChild(first);
    if (list && (list.tagName === "UL" || list.tagName === "OL")) head.appendChild(list);
    takeawaysHtml = head.innerHTML;
  }
  return { takeawaysHtml, bodyHtml: root.innerHTML, toc };
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);
export const isRtlLanguage = (lang: string) => RTL_LANGUAGES.has(lang.toLowerCase().split("-")[0]);

/** "2026-10-14" -> "October 14, 2026" (read as a calendar date, not shifted by time zone). */
export function formatArticleDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** JSON-LD for the article page: url and mainEntityOfPage default to the canonical URL. */
export function articleJsonLd(
  jsonLd: Record<string, unknown> | null | undefined,
  canonicalUrl: string,
): Record<string, unknown> | undefined {
  if (!jsonLd || typeof jsonLd !== "object" || Object.keys(jsonLd).length === 0) return undefined;
  if (jsonLd.url) return jsonLd;
  return { ...jsonLd, url: canonicalUrl, mainEntityOfPage: canonicalUrl };
}
