import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export interface ListViewState {
  search: string;
  tab: string;
  sort: string;
  dir: "asc" | "desc";
  selected: string | null;
}

export interface UseListViewStateOptions {
  /** Prefix so multiple lists can live on one route (e.g. "checks"). */
  key?: string;
  defaultTab?: string;
  defaultSort?: string;
  defaultDir?: "asc" | "desc";
}

/**
 * URL-synced list state: search, tab, sort, direction and the selected row.
 * Survives refresh, browser back/forward and deep links.
 * Presentation/navigation only — no query or data logic here.
 */
export function useListViewState({
  key,
  defaultTab = "",
  defaultSort = "",
  defaultDir = "desc",
}: UseListViewStateOptions = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const p = useCallback((name: string) => (key ? `${key}_${name}` : name), [key]);

  const state: ListViewState = useMemo(
    () => ({
      search: searchParams.get(p("q")) ?? "",
      tab: searchParams.get(p("tab")) ?? defaultTab,
      sort: searchParams.get(p("sort")) ?? defaultSort,
      dir: (searchParams.get(p("dir")) as "asc" | "desc") ?? defaultDir,
      selected: searchParams.get(p("id")),
    }),
    [searchParams, p, defaultTab, defaultSort, defaultDir],
  );

  const patch = useCallback(
    (next: Partial<ListViewState>, opts?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          const apply = (name: string, value: string | null | undefined, fallback = "") => {
            if (!value || value === fallback) params.delete(p(name));
            else params.set(p(name), value);
          };
          if ("search" in next) apply("q", next.search);
          if ("tab" in next) apply("tab", next.tab, defaultTab);
          if ("sort" in next) apply("sort", next.sort, defaultSort);
          if ("dir" in next) apply("dir", next.dir, defaultDir);
          if ("selected" in next) apply("id", next.selected);
          return params;
        },
        { replace: opts?.replace ?? true },
      );
    },
    [setSearchParams, p, defaultTab, defaultSort, defaultDir],
  );

  const setSearch = useCallback((v: string) => patch({ search: v }), [patch]);
  const setTab = useCallback((v: string) => patch({ tab: v, selected: null }), [patch]);
  const setSelected = useCallback(
    (v: string | null) => patch({ selected: v }, { replace: false }),
    [patch],
  );
  const toggleSort = useCallback(
    (column: string) =>
      patch({
        sort: column,
        dir: state.sort === column && state.dir === "asc" ? "desc" : "asc",
      }),
    [patch, state.sort, state.dir],
  );

  return { ...state, patch, setSearch, setTab, setSelected, toggleSort };
}
