/**
 * Central model router.
 *
 * Cost strategy:
 *  - Default everything to Gemini Flash via Lovable AI Gateway (~10–20× cheaper than gpt-4o).
 *  - Use Gemini Flash Lite for pure classification / extraction / summary tasks.
 *  - Use GPT-5 (via gateway) only for high-stakes outputs the client actually sees:
 *    rebuttals, demand packages, war room.
 *  - Use GPT-5-mini (via gateway) for copilot reasoning / autonomous agent.
 *  - Forensic vision (deep photo analysis) and check OCR keep the strong model tier.
 *
 * Backward-compatible exports: MODEL_CHEAP / MODEL_STRONG / MODEL_FAST /
 * MODEL_VISION / MODEL_VISION_STRONG remain to avoid breaking callers.
 */

export type DarwinTaskType =
  | "copilot_reasoning"
  | "copilot_drafting"
  | "autonomous_agent"
  | "client_update"
  | "war_room"
  | "rebuttal"
  | "demand_package"
  | "strategy_research_summary"
  | "extraction"
  | "classification"
  | "photo_description"
  | "estimate_analysis"
  | "note_generation"
  | "summary"
  | "policy_qa"
  | "vision_analysis"
  | "tool_extraction";

export type SearchMode = "off" | "auto" | "basic" | "advanced";

export interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  searchMode: SearchMode;
}

// ── Model tiers ──────────────────────────────────────────────────────
// Lovable AI Gateway models
export const MODEL_FLASH = "google/gemini-3-flash-preview";       // default workhorse
export const MODEL_FLASH_LITE = "google/gemini-2.5-flash-lite";   // classification/extraction/summary
export const MODEL_PRO = "google/gemini-2.5-pro";                  // strong vision / large context
export const MODEL_GPT5 = "openai/gpt-5";                          // strategic outputs (via gateway)
export const MODEL_GPT5_MINI = "openai/gpt-5-mini";                // reasoning / agent

// ── Backward-compatible aliases (still imported by many edge functions) ──
export const MODEL_CHEAP = MODEL_FLASH;
export const MODEL_FAST = MODEL_FLASH_LITE;
export const MODEL_STRONG = MODEL_GPT5;
export const MODEL_VISION = MODEL_FLASH;
export const MODEL_VISION_STRONG = MODEL_PRO;

/** Tasks that benefit from search context */
const SEARCH_ELIGIBLE_TASKS: Set<DarwinTaskType> = new Set([
  "copilot_reasoning",
  "war_room",
  "rebuttal",
  "demand_package",
  "strategy_research_summary",
  "policy_qa",
]);

/** Tasks whose final output justifies the GPT-5 tier */
const STRONG_MODEL_TASKS: Set<DarwinTaskType> = new Set([
  "rebuttal",
  "demand_package",
  "war_room",
]);

/** Tasks that should use GPT-5-mini (reasoning, but cost-aware) */
const REASONING_MODEL_TASKS: Set<DarwinTaskType> = new Set([
  "copilot_reasoning",
  "autonomous_agent",
]);

/** Pure extraction/classification — cheapest tier is fine */
const FLASH_LITE_TASKS: Set<DarwinTaskType> = new Set([
  "extraction",
  "classification",
  "summary",
  "note_generation",
  "photo_description",
]);

/** Keywords that indicate a search-worthy query */
const SEARCH_TRIGGER_KEYWORDS = [
  "building code", "manufacturer", "state law", "statute",
  "regulation", "ordinance", "irc", "ibc", "nfpa",
];

export function shouldTriggerSearch(task: DarwinTaskType, query: string): boolean {
  if (!SEARCH_ELIGIBLE_TASKS.has(task)) return false;
  if (task === "strategy_research_summary" || task === "policy_qa") return true;
  const lower = query.toLowerCase();
  return SEARCH_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Route a task to model config.
 * Default to Gemini Flash; downgrade to Flash Lite for pure extraction;
 * upgrade to GPT-5 / GPT-5-mini in smartRouteModel for strategic tasks.
 */
export function routeTask(task: DarwinTaskType): ModelConfig {
  if (FLASH_LITE_TASKS.has(task)) {
    return {
      model: MODEL_FLASH_LITE,
      maxTokens: 1500,
      temperature: 0.2,
      searchMode: "off",
    };
  }
  if (SEARCH_ELIGIBLE_TASKS.has(task)) {
    return {
      model: MODEL_FLASH,
      maxTokens: 2500,
      temperature: 0.2,
      searchMode: "auto",
    };
  }
  return {
    model: MODEL_FLASH,
    maxTokens: 2000,
    temperature: 0.3,
    searchMode: "off",
  };
}

/**
 * Upgrade tier for final-output tasks or very large prompts.
 * - Strategic outputs (war_room/rebuttal/demand_package) -> GPT-5
 * - Reasoning/agent -> GPT-5-mini
 * - Anything > 1500 chars of user prompt -> bump from Flash Lite to Flash, or Flash to GPT-5-mini
 */
export function smartRouteModel(
  config: ModelConfig,
  task: DarwinTaskType,
  userPromptLength: number,
  forceStrong?: boolean,
): ModelConfig {
  if (forceStrong || STRONG_MODEL_TASKS.has(task)) {
    return { ...config, model: MODEL_GPT5, maxTokens: 8000 };
  }
  if (REASONING_MODEL_TASKS.has(task)) {
    return { ...config, model: MODEL_GPT5_MINI, maxTokens: 6000 };
  }
  if (userPromptLength > 4000) {
    // Large prompt — bump up one tier from default Flash to GPT-5-mini for quality
    return { ...config, model: MODEL_GPT5_MINI, maxTokens: 6000 };
  }
  return config;
}

export function overrideSearchMode(config: ModelConfig, override: SearchMode): ModelConfig {
  return { ...config, searchMode: override };
}
