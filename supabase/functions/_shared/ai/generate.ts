/**
 * Unified generation function.
 * All edge functions should call this instead of raw OpenAI/Perplexity.
 */

import { routeTask, overrideSearchMode, type DarwinTaskType, type SearchMode } from "./modelRouter.ts";
import { callOpenAI, type OpenAIResult } from "./openaiClient.ts";
import { searchTavily, type TavilyResult } from "./tavily.ts";
import { buildCacheKey, hashPrompt, getCache, setCache } from "./cache.ts";

export interface GenerateOptions {
  task: DarwinTaskType;
  system: string;
  user: string;
  claimId?: string;
  /** Override the default search mode for this task */
  searchMode?: SearchMode;
  /** Search query — if omitted, user prompt is used as search query */
  searchQuery?: string;
  /** Claim facts / declared position context to prepend before search results */
  claimContext?: string;
  /** Skip cache for this request */
  skipCache?: boolean;
  /** Override model */
  model?: string;
  /** Override temperature */
  temperature?: number;
  /** Override max tokens */
  maxTokens?: number;
  /** Request JSON mode */
  jsonMode?: boolean;
}

export interface GenerateResult {
  text: string;
  model: string;
  usedSearch: boolean;
  cached: boolean;
  sources: Array<{ title: string; url: string }>;
  promptHash: string;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  let config = routeTask(opts.task);

  if (opts.searchMode !== undefined) {
    config = overrideSearchMode(config, opts.searchMode);
  }

  const model = opts.model || config.model;
  const temperature = opts.temperature ?? config.temperature;
  const maxTokens = opts.maxTokens ?? config.maxTokens;

  const pHash = await hashPrompt(opts.system + opts.user);

  // Check cache
  const cacheKey = buildCacheKey(
    opts.task,
    opts.claimId || "_global",
    model,
    config.searchMode,
    pHash,
  );

  if (!opts.skipCache) {
    const cached = getCache<GenerateResult>(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // Run Tavily search if enabled
  let tavilyResult: TavilyResult | null = null;
  if (config.searchMode !== "off") {
    try {
      tavilyResult = await searchTavily(
        opts.searchQuery || opts.user,
        config.searchMode,
      );
    } catch (e) {
      console.error("Tavily search failed (non-fatal):", e);
    }
  }

  // Build final system prompt: claim context first, then search results
  let enrichedSystem = opts.system;

  if (opts.claimContext) {
    enrichedSystem += `\n\n=== CLAIM FACTS & DECLARED POSITION ===\n${opts.claimContext}\n=== END CLAIM FACTS ===`;
  }

  if (tavilyResult) {
    const sourcesText = tavilyResult.sources
      .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.content.slice(0, 300)}`)
      .join("\n\n");
    enrichedSystem += `\n\n=== EXTERNAL RESEARCH RESULTS ===\nSearch: "${tavilyResult.query}"\n\nAnswer: ${tavilyResult.answer}\n\nSources:\n${sourcesText}\n=== END RESEARCH ===`;
  }

  // Call OpenAI
  const aiResult: OpenAIResult = await callOpenAI({
    model,
    system: enrichedSystem,
    user: opts.user,
    temperature,
    maxTokens,
    jsonMode: opts.jsonMode,
  });

  const result: GenerateResult = {
    text: aiResult.text,
    model: aiResult.model,
    usedSearch: !!tavilyResult,
    cached: false,
    sources: tavilyResult?.sources?.map((s) => ({ title: s.title, url: s.url })) || [],
    promptHash: pHash,
  };

  setCache(cacheKey, result);

  return result;
}

/**
 * Backward-compatible wrapper matching the old runDarwinTask signature.
 */
export async function runDarwinTask(
  task: DarwinTaskType,
  system: string,
  user: string,
): Promise<{ text: string; model?: string; meta?: GenerateResult }> {
  const result = await generate({ task, system, user });
  return { text: result.text, model: result.model, meta: result };
}

/**
 * Backward-compatible wrapper matching the old callOpenAIText signature.
 */
export async function callOpenAIText(opts: {
  system: string;
  user: string;
  model?: string;
  reasoningEffort?: string;
  temperature?: number;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<{ text: string; model?: string; raw?: unknown; id?: string; meta?: GenerateResult }> {
  // Map model to new routing — strategic models get gpt-4o, else gpt-4o-mini
  const isStrategic = opts.model?.includes("gpt-5.4") || opts.reasoningEffort === "high";
  const model = isStrategic ? "gpt-4o" : "gpt-4o-mini";

  const result = await generate({
    task: isStrategic ? "copilot_reasoning" : "copilot_drafting",
    system: opts.system,
    user: opts.user,
    model,
    temperature: opts.temperature,
    maxTokens: opts.maxOutputTokens,
    jsonMode: !!opts.jsonSchema,
    searchMode: "off",
  });

  return { text: result.text, model: result.model, meta: result };
}

/**
 * Backward-compatible wrapper for Perplexity research → now uses Tavily.
 */
export async function callPerplexityResearch(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ text: string; citations: string[]; raw?: unknown }> {
  const tavily = await searchTavily(opts.user, "basic");

  if (!tavily) {
    return { text: "", citations: [] };
  }

  // Combine Tavily answer with source context and pass through OpenAI for formatting
  const sourcesContext = tavily.sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.content.slice(0, 400)}`)
    .join("\n\n");

  const aiResult = await callOpenAI({
    model: "gpt-4o-mini",
    system: opts.system,
    user: `Based on the following research results, provide a comprehensive answer:\n\nSearch Query: ${tavily.query}\n\nDirect Answer: ${tavily.answer}\n\nSources:\n${sourcesContext}\n\nOriginal request: ${opts.user}`,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 1800,
  });

  return {
    text: aiResult.text,
    citations: tavily.sources.map((s) => s.url),
  };
}

/**
 * Backward-compatible getModelForTask.
 */
export function getModelForTask(task: DarwinTaskType) {
  const config = routeTask(task);
  return {
    provider: "openai" as const,
    model: config.model,
    reasoningEffort: config.model === "gpt-4o" ? "high" as const : "medium" as const,
    temperature: config.temperature,
    maxOutputTokens: config.maxTokens,
  };
}
