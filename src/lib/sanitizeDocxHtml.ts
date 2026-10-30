/**
 * Sanitize the HTML mammoth produces from an uploaded DOCX before it is put into the page.
 *
 * mammoth does no sanitization of untrusted input: a link in the document can carry a
 * javascript: URL, and the HTML is inserted with dangerouslySetInnerHTML. DOMPurify keeps the
 * document's text, headings, lists, tables, emphasis, links and embedded images, and drops
 * scripts, frames, forms, styles and event handlers. Links may only be http(s), mailto, tel or
 * in-page anchors, and open with rel="noopener noreferrer". Images keep the data:image URIs
 * mammoth's imgElement converter writes.
 */
import DOMPurify, { type WindowLike } from "dompurify";

const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|#|data:image\/(?:png|jpe?g|gif|bmp|webp|tiff|x-emf|x-wmf);base64,)/i;

export const DOCX_SANITIZE_CONFIG = Object.freeze({
  USE_PROFILES: { html: true },
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: ["style", "iframe", "frame", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base"],
  ALLOW_DATA_ATTR: false,
});

/** A sanitizer bound to one window (the browser's, or a test DOM). */
export function createDocxSanitizer(win: WindowLike) {
  const purifier = DOMPurify(win);
  // DOMPurify accepts any data: URI on <img>; keep only data:image ones.
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "src" && /^\s*data:/i.test(data.attrValue) && !/^\s*data:image\//i.test(data.attrValue)) {
      data.keepAttr = false;
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }
  });
  return (html: string): string => String(purifier.sanitize(html, { ...DOCX_SANITIZE_CONFIG, RETURN_TRUSTED_TYPE: false }));
}

let browserSanitizer: ((html: string) => string) | null = null;

export function sanitizeDocxHtml(html: string): string {
  browserSanitizer ??= createDocxSanitizer(window);
  return browserSanitizer(html);
}
