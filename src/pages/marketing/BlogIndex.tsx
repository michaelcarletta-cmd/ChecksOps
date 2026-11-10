import { Link } from "react-router-dom";
import { MarketingPageShell } from "@/components/marketing/MarketingPageShell";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useBlogArticleList } from "@/hooks/useBlogArticles";
import { BLOG_INDEX_PAGE, BLOG_PATH, formatArticleDate } from "@/lib/heycatch";

/**
 * /blog: every published HeyCatch article, newest first (all pages of the API list, not the
 * first 50). One entry per article: title, published date and read time, nothing else.
 */

export default function BlogIndex() {
  usePageMeta(BLOG_INDEX_PAGE);
  const { data: articles, isLoading } = useBlogArticleList();

  return (
    <MarketingPageShell currentPath={BLOG_PATH}>
      <main className="mx-auto max-w-3xl px-4 md:px-6 py-14 md:py-20">
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">Blog</h1>

        {isLoading ? (
          <div className="mt-12 flex justify-center" aria-label="Loading articles">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : !articles || articles.length === 0 ? (
          <p className="mt-10 text-muted-foreground">No articles yet.</p>
        ) : (
          <ul className="mt-10 divide-y divide-border/50 border-y border-border/50">
            {articles.map((a) => (
              <li key={a.id || a.slug} className="py-6">
                <Link
                  to={`${BLOG_PATH}/${encodeURIComponent(a.slug)}`}
                  className="text-xl md:text-2xl font-semibold tracking-tight hover:text-primary transition-colors"
                >
                  {a.title}
                </Link>
                <p className="mt-2 text-sm text-muted-foreground">
                  <time dateTime={a.published}>{formatArticleDate(a.published)}</time>
                  {a.read_time ? <> · {a.read_time} min read</> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </MarketingPageShell>
  );
}
