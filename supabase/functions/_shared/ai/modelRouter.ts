/**
 * Central model router: routes tasks with smart model selection.
 * Uses direct OpenAI model identifiers.
 * Default to gpt-4o-mini for cost efficiency; upgrade to gpt-4o
 * only for final-output strategic tasks or very large prompts.
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

// ── Model constants (direct OpenAI names) ────────────────────────────
export const MODEL_CHEAP = "gpt-4o-mini";
export const MODEL_STRONG = "gpt-4o";
export const MODEL_FAST = "gpt-4o-mini";
export const MODEL_VISION = "gpt-4o-mini";
export const MODEL_VISION_STRONG = "gpt-4o";

/** Tasks that benefit from search context */
const SEARCH_ELIGIBLE_TASKS: Set<DarwinTaskType> = new Set([
  "copilot_reasoning",
  "war_room",
  "rebuttal",
  "demand_package",
  "strategy_research_summary",
  "policy_qa",
]);

/** Tasks whose final output justifies the strong model cost */
const STRONG_MODEL_TASKS: Set<DarwinTaskType> = new Set([
  "rebuttal",
  "demand_package",
  "war_room",
]);

/** Keywords that indicate a search-worthy query */
const SEARCH_TRIGGER_KEYWORDS = [
  "building code", "manufacturer", "state law", "statute",
  "regulation", "ordinance", "irc", "ibc", "nfpa",
];

/**
 * Determines if Tavily search should fire for a given task + query.
 */
export function shouldTriggerSearch(task: DarwinTaskType, query: string): boolean {
  if (!SEARCH_ELIGIBLE_TASKS.has(task)) return false;
  if (task === "strategy_research_summary" || task === "policy_qa") return true;
  const lower = query.toLowerCase();
  return SEARCH_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Route a task to model config. Everything defaults to the cheap model.
 */
export function routeTask(task: DarwinTaskType): ModelConfig {
  if (SEARCH_ELIGIBLE_TASKS.has(task)) {
    return {
      model: MODEL_CHEAP,
      maxTokens: 2500,
      temperature: 0.2,
      searchMode: "auto",
    };
  }
  return {
    model: MODEL_CHEAP,
    maxTokens: 2000,
    temperature: 0.3,
    searchMode: "off",
  };
}

/**
 * Upgrade model to strong ONLY for final-output tasks or very large prompts.
 */
export function smartRouteModel(
  config: ModelConfig,
  task: DarwinTaskType,
  userPromptLength: number,
  forceStrong?: boolean,
): ModelConfig {
  if (forceStrong || STRONG_MODEL_TASKS.has(task) || userPromptLength > 1500) {
    return { ...config, model: MODEL_STRONG, maxTokens: 4000 };
  }
  return config;
}

export function overrideSearchMode(config: ModelConfig, override: SearchMode): ModelConfig {
  return { ...config, searchMode: override };
}
