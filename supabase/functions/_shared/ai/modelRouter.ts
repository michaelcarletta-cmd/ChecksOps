/**
 * Central model router: routes tasks to gpt-4o-mini (operational) or gpt-4o (strategic).
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

const STRATEGIC_TASKS: Set<DarwinTaskType> = new Set([
  "copilot_reasoning",
  "war_room",
  "rebuttal",
  "demand_package",
  "strategy_research_summary",
  "policy_qa",
]);

export function routeTask(task: DarwinTaskType): ModelConfig {
  if (STRATEGIC_TASKS.has(task)) {
    return {
      model: "gpt-4o",
      maxTokens: 4000,
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

export function overrideSearchMode(config: ModelConfig, override: SearchMode): ModelConfig {
  return { ...config, searchMode: override };
}
