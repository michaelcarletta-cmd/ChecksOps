import { useQuery } from "@tanstack/react-query";
import { BLOG_PATH, fetchAllArticles, fetchArticle, fetchArticleCount } from "@/lib/heycatch";

/**
 * Blog data from HeyCatch. Fresh for 2 minutes, so new articles show up on their own without a
 * redeploy; a failed refetch keeps the last good data. Retries are handled in the client
 * (one wait on 429), not by React Query.
 */
const BLOG_STALE_MS = 2 * 60 * 1000;

export function useBlogArticleList() {
  return useQuery({
    queryKey: ["heycatch", "articles"],
    queryFn: fetchAllArticles,
    staleTime: BLOG_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useBlogArticle(slug: string | undefined) {
  return useQuery({
    queryKey: ["heycatch", "article", slug],
    queryFn: () => fetchArticle(slug as string),
    enabled: Boolean(slug),
    staleTime: BLOG_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** True only once HeyCatch reports at least one published article; hides the nav link otherwise. */
export function useBlogHasArticles(): boolean {
  const { data } = useQuery({
    queryKey: ["heycatch", "count"],
    queryFn: fetchArticleCount,
    staleTime: BLOG_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (data ?? 0) > 0;
}

/** Appends the "Blog" link to a marketing nav list when there is something to read. */
export function useNavItemsWithBlog<T extends { label: string; href: string }>(items: readonly T[]): { label: string; href: string }[] {
  const hasArticles = useBlogHasArticles();
  return hasArticles ? [...items, { label: "Blog", href: BLOG_PATH }] : [...items];
}
