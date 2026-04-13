/**
 * Central model router: routes tasks with smart model selection.
 * Default to gpt-4o-mini for cost efficiency; upgrade to gpt-4o only
 * when prompt is large (>1500 chars) or explicitly forced.
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

/** Keywords that indicate a search-worthy query */
const SEARCH_TRIGGER_KEYWORDS = [
  "building code", "manufacturer", "state law", "statute",
  "regulation", "ordinance", "irc", "ibc", "nfpa",
];

/**
 * Determines if Tavily search should fire for a given task + query.
 * Skips search for low-value queries to save tokens.
 */
export function shouldTriggerSearch(task: DarwinTaskType, query: string): boolean {
  // Only search-eligible tasks can trigger search
  if (!SEARCH_ELIGIBLE_TASKS.has(task)) return false;

  // Strategy and policy_qa always search
  if (task === "strategy_research_summary" || task === "policy_qa") return true;

  // Other eligible tasks: only search if query contains relevant keywords
  const lower = query.toLowerCase();
  return SEARCH_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Route a task to model config.
 * All tasks default to gpt-4o-mini. Use smartRouteModel() to conditionally upgrade.
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
  // Operational tasks
  return {
    model: "gpt-4o-mini",
    maxTokens: 2000,
    temperature: 0.3,
    searchMode: "off",
  };
}

/**
 * Upgrade model to gpt-4o when prompt is large or explicitly forced.
 */
export function smartRouteModel(
  config: ModelConfig,
  userPromptLength: number,
  forceStrong?: boolean,
): ModelConfig {
  if (forceStrong || userPromptLength > 1500) {
    return { ...config, model: "gpt-4o", maxTokens: 4000 };
  }
  return config;
}

export function overrideSearchMode(config: ModelConfig, override: SearchMode): ModelConfig {
  return { ...config, searchMode: override };
}
