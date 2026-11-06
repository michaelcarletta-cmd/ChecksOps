/**
 * Writes a marketing page's own title, description, share preview (Open Graph, Twitter),
 * canonical URL and JSON-LD into the served HTML. The site is a single-page app: without
 * this, every URL is served index.html with the home page's head, so a /pricing link shared
 * on LinkedIn or Slack previews the home page, and crawlers that do not run JavaScript never
 * see a page's FAQ schema.
 *
 * vite.config.ts calls renderStaticHead() after a build and writes each page to the
 * extensionless S3 key staticPageKey() returns (e.g. "pricing"), which CloudFront serves for
 * https://checksops.com/pricing. The SPA upload scripts give extensionless keys a text/html
 * content type.
 */
import type { MarketingPage } from "./marketingPages.ts";

export const MARKETING_SITE_ORIGIN = "https://checksops.com";
export const PAGE_JSON_LD_ID = "page-json-ld";

const escapeAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// JSON inside <script>: "</" must never close the element early.
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** "/" -> "index.html"; "/pricing" -> "pricing"; "/vs/a-vs-b" -> "vs/a-vs-b". */
export function staticPageKey(path: string): string {
  if (path === "/") return "index.html";
  if (!/^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(path)) {
    throw new Error(`marketing page path must be lowercase words and hyphens: ${path}`);
  }
  return path.slice(1);
}

function replaceOne(html: string, pattern: RegExp, replacement: string, what: string): string {
  const matches = html.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
  if (!matches || matches.length !== 1) {
    throw new Error(`index.html must contain exactly one ${what} (found ${matches ? matches.length : 0})`);
  }
  return html.replace(pattern, replacement);
}

export function renderStaticHead(indexHtml: string, page: MarketingPage): string {
  const url = `${MARKETING_SITE_ORIGIN}${page.path}`;
  const title = escapeAttr(page.title);
  const description = escapeAttr(page.description);
  let html = indexHtml;
  html = replaceOne(html, /<title>[^<]*<\/title>/, `<title>${escapeText(page.title)}</title>`, "<title>");
  html = replaceOne(html, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${description}">`, "meta description");
  html = replaceOne(html, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${title}">`, "og:title");
  html = replaceOne(html, /<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${title}">`, "twitter:title");
  html = replaceOne(html, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${description}">`, "og:description");
  html = replaceOne(html, /<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${description}">`, "twitter:description");

  const extra = [
    `<meta property="og:url" content="${escapeAttr(url)}">`,
    `<link rel="canonical" href="${escapeAttr(url)}">`,
  ];
  if (page.jsonLd) {
    extra.push(`<script type="application/ld+json" id="${PAGE_JSON_LD_ID}">${jsonForScript(page.jsonLd)}</script>`);
  }
  return replaceOne(html, /<\/head>/, `  ${extra.join("\n  ")}\n</head>`, "</head>");
}
