/**
 * Tavily search wrapper — replaces Perplexity for web research.
 */

import type { SearchMode } from "./modelRouter.ts";

const TAVILY_API_KEY = () => {
  const key = Deno.env.get("TAVILY_API_KEY");
  if (!key) throw new Error("TAVILY_API_KEY is not configured");
  return key;
};

export interface TavilyResult {
  answer: string;
  sources: Array<{ title: string; url: string; content: string }>;
  query: string;
}

export async function searchTavily(
  query: string,
  mode: SearchMode,
): Promise<TavilyResult | null> {
  if (mode === "off") return null;

  const searchDepth = mode === "advanced" ? "advanced" : "basic";

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY(),
      query,
      search_depth: searchDepth,
      include_answer: true,
      max_results: mode === "advanced" ? 10 : 5,
      include_raw_content: false,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Tavily error:", JSON.stringify(data).slice(0, 500));
    throw new Error(`Tavily ${res.status}: ${data?.detail || "Unknown error"}`);
  }

  return {
    answer: data.answer || "",
    sources: (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: r.content || "",
    })),
    query,
  };
}
