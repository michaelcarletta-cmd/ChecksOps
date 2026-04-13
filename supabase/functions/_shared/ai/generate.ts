/**
 * Unified generation function.
 * All edge functions should call this instead of raw OpenAI/Perplexity.
 */

import { routeTask, overrideSearchMode, smartRouteModel, shouldTriggerSearch, type DarwinTaskType, type SearchMode } from "./modelRouter.ts";
import { callOpenAI, type OpenAIResult } from "./openaiClient.ts";
import { searchTavily, type TavilyResult } from "./tavily.ts";
import { buildCacheKey, hashPrompt, getCache, setCache, getClaimMemory, setClaimMemory, clearClaimMemory, isSearchOnCooldown, markSearchUsed } from "./cache.ts";

export { clearClaimMemory } from "./cache.ts";

export interface GenerateOptions {
  task: DarwinTaskType;
  system: string;
  user: string;
  claimId?: string;
  searchMode?: SearchMode;
  searchQuery?: string;
  claimContext?: string;
  skipCache?: boolean;
  model?: string;
  forceStrong?: boolean;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Data-type tag for claim-level memoization (e.g. "extracted_facts") */
  claimDataType?: string;
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
  // ── 1. Claim memory fast-return ─────────────────────────────────
  if (opts.claimId && opts.claimDataType && !opts.skipCache) {
    const memo = getClaimMemory(opts.claimId, opts.claimDataType);
    if (memo) {
      return {
        text: memo.text,
        model: memo.model,
        cached: true,
        usedSearch: false,
        sources: [],
        promptHash: memo.promptHash,
      };
    }
  }

  // ── 2. Route model ─────────────────────────────────────────────
  let config = routeTask(opts.task);
  config = smartRouteModel(config, opts.task, opts.user.length, opts.forceStrong);

  if (opts.searchMode !== undefined) {
    config = overrideSearchMode(config, opts.searchMode);
  }

  const model = opts.model || config.model;
  const temperature = opts.temperature ?? config.temperature;
  const maxTokens = opts.maxTokens ?? config.maxTokens;

  const pHash = await hashPrompt(opts.system + opts.user);

  // ── 3. Response cache ──────────────────────────────────────────
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

  // ── 4. Tavily search (gated + cooldown) ────────────────────────
  let tavilyResult: TavilyResult | null = null;
  const claimKey = opts.claimId || "_global";

  if (
    config.searchMode !== "off" &&
    shouldTriggerSearch(opts.task, opts.searchQuery || opts.user) &&
    !isSearchOnCooldown(claimKey)
  ) {
    try {
      tavilyResult = await searchTavily(opts.searchQuery || opts.user, config.searchMode);
      if (!tavilyResult?.sources?.length) {
        tavilyResult = null;
      } else {
        markSearchUsed(claimKey);
      }
    } catch (e) {
      console.error("Tavily search failed (non-fatal):", e);
      tavilyResult = null;
    }
  }

  // ── 5. Build enriched system prompt ────────────────────────────
  let enrichedSystem = opts.system;

  if (opts.claimContext) {
    enrichedSystem += `\n\n=== CLAIM FACTS & DECLARED POSITION ===\n${opts.claimContext}\n=== END CLAIM FACTS ===`;
  }

  if (tavilyResult) {
    const topSources = tavilyResult.sources.slice(0, 3);
    const sourcesText = topSources
      .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.content.slice(0, 120)}`)
      .join("\n\n");
    enrichedSystem += `\n\n=== EXTERNAL RESEARCH ===\nUse the following research only as supporting context. Do not restate it unless necessary.\nKey Findings: ${tavilyResult.answer}\n\nSources:\n${sourcesText}\n=== END RESEARCH ===`;
  }

  // ── 6. Call OpenAI ─────────────────────────────────────────────
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
    sources: tavilyResult?.sources?.slice(0, 3).map((s) => ({ title: s.title, url: s.url })) || [],
    promptHash: pHash,
  };

  // ── 7. Persist to caches ───────────────────────────────────────
  setCache(cacheKey, result);

  if (opts.claimId && opts.claimDataType) {
    setClaimMemory(opts.claimId, opts.claimDataType, aiResult.text, aiResult.model, pHash);
  }

  return result;
}

// ── Backward-compatible wrappers ─────────────────────────────────

export async function runDarwinTask(
  task: DarwinTaskType,
  system: string,
  user: string,
): Promise<{ text: string; model?: string; meta?: GenerateResult }> {
  const result = await generate({ task, system, user });
  return { text: result.text, model: result.model, meta: result };
}

export async function callOpenAIText(opts: {
  system: string;
  user: string;
  model?: string;
  reasoningEffort?: string;
  temperature?: number;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<{ text: string; model?: string; raw?: unknown; id?: string; meta?: GenerateResult }> {
  const forceStrong = opts.model?.includes("gpt-5.4") || opts.reasoningEffort === "high";
  const result = await generate({
    task: forceStrong ? "copilot_reasoning" : "copilot_drafting",
    system: opts.system,
    user: opts.user,
    forceStrong,
    temperature: opts.temperature,
    maxTokens: opts.maxOutputTokens,
    jsonMode: !!opts.jsonSchema,
    searchMode: "off",
  });
  return { text: result.text, model: result.model, meta: result };
}

export async function callPerplexityResearch(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ text: string; citations: string[]; raw?: unknown }> {
  let tavily: TavilyResult | null = null;
  try {
    tavily = await searchTavily(opts.user, "basic");
    if (!tavily?.sources?.length) tavily = null;
  } catch (e) {
    console.error("Tavily search failed in callPerplexityResearch:", e);
    tavily = null;
  }
  if (!tavily) return { text: "", citations: [] };

  const topSources = tavily.sources.slice(0, 3);
  const sourcesContext = topSources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.content.slice(0, 120)}`)
    .join("\n\n");

  const aiResult = await callOpenAI({
    model: "gpt-4o-mini",
    system: opts.system,
    user: `Use the following research as supporting context. Do not restate it unless necessary.\n\nKey Findings: ${tavily.answer}\n\nSources:\n${sourcesContext}\n\nOriginal request: ${opts.user}`,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 1800,
  });

  return { text: aiResult.text, citations: topSources.map((s) => s.url) };
}

export function getModelForTask(task: DarwinTaskType) {
  const config = routeTask(task);
  return {
    provider: "openai" as const,
    model: config.model,
    reasoningEffort: "medium" as const,
    temperature: config.temperature,
    maxOutputTokens: config.maxTokens,
  };
}
