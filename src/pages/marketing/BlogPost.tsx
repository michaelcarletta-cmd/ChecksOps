import { lazy, Suspense, useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { MarketingPageShell } from "@/components/marketing/MarketingPageShell";
import { usePageMeta, MARKETING_SITE_ORIGIN } from "@/hooks/usePageMeta";
import { useBlogArticle } from "@/hooks/useBlogArticles";
import {
  BLOG_INDEX_PAGE,
  BLOG_PATH,
  articleJsonLd,
  formatArticleDate,
  isRtlLanguage,
  prepareArticleHtml,
} from "@/lib/heycatch";

const NotFound = lazy(() => import("@/pages/NotFound"));
const SITE_LANGUAGE = "en";

/** og:type is "article" on this page only; the previous value comes back on unmount. */
function useOgTypeArticle(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    let el = document.head.querySelector<HTMLMetaElement>('meta[property="og:type"]');
    const created = !el;
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("property", "og:type");
      document.head.appendChild(el);
    }
    const previous = el.getAttribute("content");
    el.setAttribute("content", "article");
    return () => {
      if (created) el?.remove();
      else if (previous !== null) el?.setAttribute("content", previous);
    };
  }, [active]);
}

/**
 * /blog/:slug: one HeyCatch article. The title is the only <h1>, with the date and read time
 * under it. content_html renders as-is (sanitised): Key takeaways, then the table of contents,
 * then the body and FAQ. meta_description goes into the head tags only, never onto the page.
 */
export default function BlogPost() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: article, isLoading, isError } = useBlogArticle(slug);

  const path = `${BLOG_PATH}/${encodeURIComponent(slug)}`;
  const canonicalUrl = `${MARKETING_SITE_ORIGIN}${path}`;
  usePageMeta(
    article
      ? {
          title: article.title,
          description: article.meta_description || BLOG_INDEX_PAGE.description,
          path,
          jsonLd: articleJsonLd(article.jsonLd, canonicalUrl),
        }
      : { ...BLOG_INDEX_PAGE, path },
  );
  useOgTypeArticle(Boolean(article));

  const prepared = useMemo(
    () => (article?.content_html ? prepareArticleHtml(article.content_html) : null),
    [article?.content_html],
  );

  // HeyCatch says no such article: the site's normal 404 page.
  if (!isLoading && !isError && article === null) {
    return (
      <Suspense fallback={null}>
        <NotFound />
      </Suspense>
    );
  }

  const lang = article?.language && article.language !== SITE_LANGUAGE ? article.language : undefined;
  const dir = article?.language && isRtlLanguage(article.language) ? "rtl" : undefined;
  const heroImage = article?.hero_image_url || article?.featured_image || "";

  return (
    <MarketingPageShell currentPath={path}>
      <main className="mx-auto max-w-3xl px-4 md:px-6 py-10 md:py-16">
        <Link
          to={BLOG_PATH}
          className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Blog
        </Link>

        {isLoading ? (
          <div className="mt-16 flex justify-center" aria-label="Loading article">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : !article || !prepared ? (
          <p className="mt-10 text-muted-foreground">
            This article can't be loaded right now. Please try again in a few minutes.
          </p>
        ) : (
          <article lang={lang} dir={dir} className="mt-4">
            <header>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">{article.title}</h1>
              <p className="mt-4 text-sm text-muted-foreground">
                <time dateTime={article.published}>{formatArticleDate(article.published)}</time>
                {article.read_time ? <> · {article.read_time} min read</> : null}
              </p>
            </header>

            {heroImage ? (
              <img src={heroImage} alt="" className="mt-8 w-full rounded-xl border border-border/50" />
            ) : null}

            <div className="blog-content mt-10">
              {prepared.takeawaysHtml ? (
                <div dangerouslySetInnerHTML={{ __html: prepared.takeawaysHtml }} />
              ) : null}

              {prepared.toc.length > 0 ? (
                <nav aria-labelledby="blog-toc-heading" className="blog-toc">
                  <h2 id="blog-toc-heading">Table of contents</h2>
                  <ol>
                    {prepared.toc.map((entry) => (
                      <li key={entry.id}>
                        <a href={`#${entry.id}`}>{entry.text}</a>
                      </li>
                    ))}
                  </ol>
                </nav>
              ) : null}

              <div dangerouslySetInnerHTML={{ __html: prepared.bodyHtml }} />
            </div>
          </article>
        )}
      </main>
    </MarketingPageShell>
  );
}
