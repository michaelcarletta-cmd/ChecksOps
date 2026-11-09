import { useEffect } from "react";
import { MARKETING_SITE_ORIGIN, PAGE_JSON_LD_ID } from "@/pages/marketing/marketingStaticHead";

/**
 * Per-page title, description, canonical URL and optional JSON-LD for the public
 * marketing pages (home, /vs/..., /claim-check-tracking). The build writes the same values into
 * each page's served HTML (marketingStaticHead.ts) for crawlers and link previews that
 * do not run JavaScript; this hook keeps them right as the SPA navigates between pages.
 */
export { MARKETING_SITE_ORIGIN };

export interface PageMeta {
  title: string;
  description: string;
  /** Path on MARKETING_SITE_ORIGIN, e.g. "/claim-check-tracking". */
  path: string;
  /** Structured data for this page only; removed again when the page unmounts. */
  jsonLd?: Record<string, unknown>;
}

const JSON_LD_ID = PAGE_JSON_LD_ID;

function setMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function usePageMeta({ title, description, path, jsonLd }: PageMeta) {
  const jsonLdText = jsonLd ? JSON.stringify(jsonLd) : "";
  useEffect(() => {
    if (typeof document === "undefined") return;
    const url = `${MARKETING_SITE_ORIGIN}${path}`;
    document.title = title;
    setMeta('meta[name="description"]', "name", "description", description);
    setMeta('meta[property="og:title"]', "property", "og:title", title);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
    setMeta('meta[property="og:description"]', "property", "og:description", description);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    setMeta('meta[property="og:url"]', "property", "og:url", url);

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = url;

    let script: HTMLScriptElement | null = null;
    if (jsonLdText) {
      document.getElementById(JSON_LD_ID)?.remove();
      script = document.createElement("script");
      script.id = JSON_LD_ID;
      script.type = "application/ld+json";
      script.text = jsonLdText;
      document.head.appendChild(script);
    }
    return () => {
      // Canonical, og:url and JSON-LD belong to this page only; other routes
      // (sign-in, tenant apps) must not inherit them.
      script?.remove();
      canonical?.remove();
      document.head.querySelector('meta[property="og:url"]')?.remove();
    };
  }, [title, description, path, jsonLdText]);
}
