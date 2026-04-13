/**
 * Central model router: routes tasks with smart model selection.
 * Default to gpt-4o-mini for cost efficiency; upgrade to gpt-4o only
 * for final-output strategic tasks or very large prompts.
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
  | "policy_qa";

export type SearchMode = "off" | "auto" | "basic" | "advanced";

export interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  searchMode: SearchMode;
}

/** Tasks that benefit from search context */
const SEARCH_ELIGIBLE_TASKS: Set<DarwinTaskType> = new Set([
  "copilot_reasoning",
  "war_room",
  "rebuttal",
  "demand_package",
  "strategy_research_summary",
  "policy_qa",
]);

/** Tasks whose final output justifies gpt-4o cost */
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
 * Route a task to model config. Everything defaults to gpt-4o-mini.
 */
export function routeTask(task: DarwinTaskType): ModelConfig {
  if (SEARCH_ELIGIBLE_TASKS.has(task)) {
    return {
      model: "gpt-4o-mini",
      maxTokens: 2500,
      temperature: 0.2,
      searchMode: "auto",
    };
  }
  return {
    model: "gpt-4o-mini",
    maxTokens: 2000,
    temperature: 0.3,
    searchMode: "off",
  };
}

/**
 * Upgrade model to gpt-4o ONLY for final-output tasks or very large prompts.
 */
export function smartRouteModel(
  config: ModelConfig,
  task: DarwinTaskType,
  userPromptLength: number,
  forceStrong?: boolean,
): ModelConfig {
  if (forceStrong || STRONG_MODEL_TASKS.has(task) || userPromptLength > 1500) {
    return { ...config, model: "gpt-4o", maxTokens: 4000 };
  }
  return config;
}

export function overrideSearchMode(config: ModelConfig, override: SearchMode): ModelConfig {
  return { ...config, searchMode: override };
}
