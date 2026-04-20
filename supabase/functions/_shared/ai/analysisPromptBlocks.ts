/**
 * Shared static rule blocks for darwin-ai-analysis system prompts.
 *
 * Phase 6 cost optimization (continued): consolidates the small set of
 * formatting rules that repeat across the lower-risk narrative tasks in
 * `darwin-ai-analysis` (claim_analysis, operating_manual, case_study,
 * marketing_assets). Higher-stakes prompts (denial_rebuttal,
 * engineer_report_rebuttal, demand_package, supplement) are intentionally
 * left untouched to avoid behavior regressions in carrier-facing output.
 */

/** Plain-prose formatting rule shared by narrative analysis tasks. */
export const PLAIN_PROSE_RULE = `Write in plain prose: no markdown symbols, no bullet asterisks, no hash headers. Use normal paragraphs and clear section breaks.`;

/** Shorter variant for tasks that don't need the section-break clause. */
export const PLAIN_PROSE_RULE_COMPACT = `Write in plain prose: no markdown symbols. Use normal paragraphs.`;
