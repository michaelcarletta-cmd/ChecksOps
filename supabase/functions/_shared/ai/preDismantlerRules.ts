/**
 * Pre-AI Document Issue Detection Engine.
 *
 * Runs BEFORE the AI dismantler to detect common engineer report, denial, and
 * adjuster issues using deterministic rules + heuristics. Goal: reduce AI usage
 * by 60%+ for simple/obvious documents while preserving rebuttal quality.
 *
 * If weaknessScore < threshold AND document is small AND no contradictions
 * suspected → return lightweight rule-based output, skip AI entirely.
 * Otherwise → escalate to the existing universal dismantler.
 *
 * NON-BREAKING: Additive only. Does not modify or remove the AI dismantler.
 */

export type RuleFlag =
  | "speculativeLanguage"
  | "noTesting"
  | "visualOnly"
  | "denialLanguage"
  | "causationWithoutSupport"
  | "scopeMinimization";

export interface RuleIssue {
  flag: RuleFlag;
  label: string;
  matches: string[]; // verbatim phrases found (deduped, capped)
  weight: number;
}

export interface PreDismantlerRuleResult {
  issues: RuleIssue[];
  weaknessScore: number;
  flags: Record<RuleFlag, boolean>;
  shouldEscalateToAI: boolean;
  escalationReason: string | null;
  meta: {
    textLength: number;
    matchCount: number;
    contradictionsSuspected: boolean;
  };
}

// ── Detection patterns ──────────────────────────────────────────────

const SPECULATIVE_PATTERNS = [
  /\bmay have\b/gi,
  /\bcould be\b/gi,
  /\bappears? to\b/gi,
  /\blikely\b/gi,
  /\bpossibly\b/gi,
  /\bpresumed\b/gi,
  /\bsuggests?\b/gi,
];

// Absence detection — these terms SHOULD appear in a credible forensic report.
const TESTING_KEYWORDS = [
  /\bmoisture\b/i,
  /\btesting\b/i,
  /\bprobe\b/i,
  /\bsample\b/i,
  /\blab\b/i,
  /\bcore\b/i,
  /\btest square\b/i,
  /\bhand seal\b/i,
];

const VISUAL_ONLY_PATTERNS = [
  /\bvisual inspection\b/gi,
  /\bvisually inspected\b/gi,
  /\bno invasive inspection\b/gi,
  /\blimited inspection\b/gi,
  /\bnon-?invasive\b/gi,
  /\bexterior only\b/gi,
];

const DENIAL_PATTERNS = [
  /\bnot covered\b/gi,
  /\bwe deny\b/gi,
  /\bdenied\b/gi,
  /\bexcluded\b/gi,
  /\bexclusion\b/gi,
  /\bwear and tear\b/gi,
  /\bdeterioration\b/gi,
  /\bnormal aging\b/gi,
  /\bdeferred maintenance\b/gi,
];

// Strong-conclusion words used to check "causation without support"
const STRONG_CONCLUSION_PATTERNS = [
  /\battribut(ed|able) to\b/gi,
  /\bcaused by\b/gi,
  /\bresult of\b/gi,
  /\bdue to\b/gi,
  /\bconclusion\b/gi,
  /\bconcluded?\b/gi,
];

const SCOPE_MINIMIZATION_PATTERNS = [
  /\bspot repair\b/gi,
  /\blocalized repair\b/gi,
  /\blimited to\b/gi,
  /\bpatch\b/gi,
  /\bcosmetic only\b/gi,
  /\bisolated\b/gi,
  /\brepair in kind\b/gi,
];

// Heuristic contradiction signals (cheap, conservative).
const CONTRADICTION_PATTERNS = [
  /\bhowever\b/gi,
  /\bbut\b/gi,
  /\bdespite\b/gi,
  /\balthough\b/gi,
  /\binconsistent\b/gi,
  /\bcontrary\b/gi,
];

// ── Helpers ─────────────────────────────────────────────────────────

const WEIGHTS: Record<RuleFlag, number> = {
  speculativeLanguage: 2,
  noTesting: 3,
  visualOnly: 3,
  denialLanguage: 2,
  causationWithoutSupport: 4,
  scopeMinimization: 2,
};

const ESCALATE_SCORE_THRESHOLD = 6;
const ESCALATE_LENGTH_THRESHOLD = 10000;
const MAX_MATCHES_PER_FLAG = 8;

function collectMatches(text: string, patterns: RegExp[]): string[] {
  const found = new Set<string>();
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) {
      for (const m of matches) {
        const key = m.toLowerCase().trim();
        if (key) found.add(key);
        if (found.size >= MAX_MATCHES_PER_FLAG) break;
      }
    }
    if (found.size >= MAX_MATCHES_PER_FLAG) break;
  }
  return Array.from(found);
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── Main entry point ────────────────────────────────────────────────

export function analyzeDocumentWithRules(text: string): PreDismantlerRuleResult {
  const safe = (text || "").toString();
  const length = safe.length;

  // 1. Speculative language
  const speculativeMatches = collectMatches(safe, SPECULATIVE_PATTERNS);

  // 2. No testing — flag when NONE of the testing keywords appear
  const hasTestingKeyword = hasAny(safe, TESTING_KEYWORDS);
  const noTesting = !hasTestingKeyword && length > 200;

  // 3. Visual only
  const visualMatches = collectMatches(safe, VISUAL_ONLY_PATTERNS);

  // 4. Denial language
  const denialMatches = collectMatches(safe, DENIAL_PATTERNS);

  // 5. Causation without support — strong conclusions present BUT no testing
  const conclusionMatches = collectMatches(safe, STRONG_CONCLUSION_PATTERNS);
  const causationWithoutSupport = conclusionMatches.length > 0 && !hasTestingKeyword;

  // 6. Scope minimization
  const scopeMatches = collectMatches(safe, SCOPE_MINIMIZATION_PATTERNS);

  const flags: Record<RuleFlag, boolean> = {
    speculativeLanguage: speculativeMatches.length > 0,
    noTesting,
    visualOnly: visualMatches.length > 0,
    denialLanguage: denialMatches.length > 0,
    causationWithoutSupport,
    scopeMinimization: scopeMatches.length > 0,
  };

  const issues: RuleIssue[] = [];
  if (flags.speculativeLanguage) {
    issues.push({
      flag: "speculativeLanguage",
      label: "Speculative language without forensic basis",
      matches: speculativeMatches,
      weight: WEIGHTS.speculativeLanguage,
    });
  }
  if (flags.noTesting) {
    issues.push({
      flag: "noTesting",
      label: "No physical testing referenced (moisture/probe/sample/lab/core)",
      matches: [],
      weight: WEIGHTS.noTesting,
    });
  }
  if (flags.visualOnly) {
    issues.push({
      flag: "visualOnly",
      label: "Visual-only / non-invasive inspection acknowledged",
      matches: visualMatches,
      weight: WEIGHTS.visualOnly,
    });
  }
  if (flags.denialLanguage) {
    issues.push({
      flag: "denialLanguage",
      label: "Denial / exclusion language detected",
      matches: denialMatches,
      weight: WEIGHTS.denialLanguage,
    });
  }
  if (flags.causationWithoutSupport) {
    issues.push({
      flag: "causationWithoutSupport",
      label: "Strong causation conclusions without testing support",
      matches: conclusionMatches,
      weight: WEIGHTS.causationWithoutSupport,
    });
  }
  if (flags.scopeMinimization) {
    issues.push({
      flag: "scopeMinimization",
      label: "Scope minimization language (spot/patch/localized)",
      matches: scopeMatches,
      weight: WEIGHTS.scopeMinimization,
    });
  }

  const weaknessScore = issues.reduce((sum, i) => sum + i.weight, 0);
  const matchCount = issues.reduce((sum, i) => sum + i.matches.length, 0);
  const contradictionsSuspected = hasAny(safe, CONTRADICTION_PATTERNS);

  // Escalation logic
  let escalationReason: string | null = null;
  if (weaknessScore >= ESCALATE_SCORE_THRESHOLD) {
    escalationReason = `weaknessScore=${weaknessScore} >= ${ESCALATE_SCORE_THRESHOLD}`;
  } else if (contradictionsSuspected) {
    escalationReason = "contradictions suspected";
  } else if (length > ESCALATE_LENGTH_THRESHOLD) {
    escalationReason = `documentLength=${length} > ${ESCALATE_LENGTH_THRESHOLD}`;
  }

  return {
    issues,
    weaknessScore,
    flags,
    shouldEscalateToAI: escalationReason !== null,
    escalationReason,
    meta: {
      textLength: length,
      matchCount,
      contradictionsSuspected,
    },
  };
}

// ── Learned-rule augmentation (additive) ─────────────────────────────
//
// Async helper that fetches active learned rules and folds matching ones
// into an existing PreDismantlerRuleResult. Non-breaking: original sync
// `analyzeDocumentWithRules` is unchanged. Callers may opt in.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { getActiveLearnedRules, type ActiveLearnedRule } from "./ruleLearningEngine.ts";

export interface LearnedRuleHit {
  ruleId: string;
  rule_type: string;
  trigger_pattern: string;
  weakness_category: string | null;
  rebuttal_strategy: string | null;
  evidence_request: string | null;
  confidence_score: number;
}

export interface AugmentedRuleResult extends PreDismantlerRuleResult {
  learnedRuleHits: LearnedRuleHit[];
  learnedScoreBump: number;
}

export async function augmentWithLearnedRules(
  text: string,
  baseResult: PreDismantlerRuleResult,
  supabase: SupabaseClient,
  ctx: { carrier?: string | null; state?: string | null; trade?: string | null; material?: string | null; disputeType?: string | null } = {},
): Promise<AugmentedRuleResult> {
  const safe = (text || "").toLowerCase();
  let hits: LearnedRuleHit[] = [];
  let bump = 0;

  try {
    const rules = await getActiveLearnedRules(supabase, {
      carrier: ctx.carrier,
      state: ctx.state,
      trade: ctx.trade,
      material: ctx.material,
      disputeType: ctx.disputeType,
      limit: 30,
    });

    for (const r of rules) {
      const needle = (r.normalized_pattern || r.trigger_pattern || "").toLowerCase().trim();
      if (!needle || needle.length < 4) continue;
      if (!safe.includes(needle)) continue;

      hits.push({
        ruleId: r.id,
        rule_type: r.rule_type,
        trigger_pattern: r.trigger_pattern,
        weakness_category: r.weakness_category,
        rebuttal_strategy: r.rebuttal_strategy,
        evidence_request: r.evidence_request,
        confidence_score: r.confidence_score,
      });

      // Modest score bump per hit, capped to avoid runaway escalation
      bump += Math.min(2, Math.max(1, Math.round(r.confidence_score / 6)));
    }
    bump = Math.min(bump, 8);

    if (hits.length > 0) {
      console.log(`[PreDismantlerRules] Learned rules matched: ${hits.length} hits, bump=+${bump}`);
    }
  } catch (e) {
    console.error("[PreDismantlerRules] learned rules fetch failed (non-fatal):", (e as Error).message);
  }

  const newScore = baseResult.weaknessScore + bump;
  const newEscalate =
    baseResult.shouldEscalateToAI ||
    newScore >= ESCALATE_SCORE_THRESHOLD ||
    hits.some((h) => h.rule_type === "escalation_rule");

  return {
    ...baseResult,
    weaknessScore: newScore,
    shouldEscalateToAI: newEscalate,
    escalationReason: baseResult.escalationReason ?? (hits.length > 0 && newEscalate ? `learned-rule hits=${hits.length}` : null),
    learnedRuleHits: hits,
    learnedScoreBump: bump,
  };
}

// ── Lightweight rebuttal output (used when AI is skipped) ───────────

export interface LightweightDismantlerOutput {
  documentType: string;
  reportSummary: string;
  mainPosition: string;
  nonCoveredTheories: string[];
  limitations: string[];
  unsupportedAssumptions: string[];
  contradictions: string[];
  omissions: string[];
  repairabilityOverreach: string[];
  coverageWeaknesses: string[];
  strongestRebuttalPoints: string[];
  evidenceToGatherNext: string[];
  draftRebuttalLanguage: string;
  source: "rules";
  ruleResult: PreDismantlerRuleResult;
}

const REBUTTAL_LIBRARY: Record<RuleFlag, { rebuttal: string; evidence: string }> = {
  speculativeLanguage: {
    rebuttal:
      "The report relies on speculative language ('may', 'could', 'appears', 'likely') rather than forensic conclusions supported by testing. Speculation is not a basis for denial under the policy.",
    evidence: "Request the author's testing data, methodology notes, and direct observations supporting any conclusions.",
  },
  noTesting: {
    rebuttal:
      "The document contains no reference to physical testing (moisture readings, probe testing, sampling, lab analysis, or core sampling). Conclusions reached without industry-standard testing carry minimal forensic weight.",
    evidence: "Demand a re-inspection that includes moisture mapping, hand seal testing, and where applicable, test squares per industry standards.",
  },
  visualOnly: {
    rebuttal:
      "The author acknowledges a visual / non-invasive inspection. Visual-only inspections cannot rule out concealed damage, substrate failure, or sealed-component compromise.",
    evidence: "Schedule an invasive inspection with the author present; document any concealed conditions photographically.",
  },
  denialLanguage: {
    rebuttal:
      "Denial / exclusion terms are invoked without specific policy citation tied to the loss facts. Carrier must cite the exact policy provision, page, and how it applies.",
    evidence: "Request the denial letter that quotes the specific policy exclusion and the underwriting file for the cited provision.",
  },
  causationWithoutSupport: {
    rebuttal:
      "The report reaches strong causation conclusions ('caused by', 'attributable to', 'result of') without any testing data to support them. Causation opinions require methodology, not assertion.",
    evidence: "Request the author's CV, prior reports on similar losses, and the data set used to reach the causation conclusion.",
  },
  scopeMinimization: {
    rebuttal:
      "The recommendation of spot/localized/patch repair ignores matching, continuity of coverage, and code-required tie-ins. Partial repair is not a like-kind-and-quality remedy.",
    evidence: "Document slope/elevation continuity, manufacturer matching limitations, and any state matching statute that applies.",
  },
};

export function buildLightweightDismantler(
  text: string,
  ruleResult: PreDismantlerRuleResult,
  docTypeHint?: string,
  learnedHits: LearnedRuleHit[] = [],
): LightweightDismantlerOutput {
  const rebuttalPoints: string[] = [];
  const evidence: string[] = [];
  const limitations: string[] = [];
  const assumptions: string[] = [];

  for (const issue of ruleResult.issues) {
    const lib = REBUTTAL_LIBRARY[issue.flag];
    if (!lib) continue;
    rebuttalPoints.push(lib.rebuttal);
    evidence.push(lib.evidence);
    if (issue.flag === "visualOnly" || issue.flag === "noTesting") limitations.push(issue.label);
    if (issue.flag === "speculativeLanguage" || issue.flag === "causationWithoutSupport") assumptions.push(issue.label);
  }

  // Fold learned-rule hits into rebuttal/evidence stacks (deduped, additive)
  for (const h of learnedHits) {
    if (h.rebuttal_strategy && !rebuttalPoints.includes(h.rebuttal_strategy)) {
      rebuttalPoints.push(`[learned] ${h.rebuttal_strategy}`);
    }
    if (h.evidence_request && !evidence.includes(h.evidence_request)) {
      evidence.push(`[learned] ${h.evidence_request}`);
    }
  }

  const totalIssues = ruleResult.issues.length + learnedHits.length;
  const summary = totalIssues === 0
    ? "Rule-based scan found no significant weaknesses; document appears procedurally compliant on its face."
    : `Rule-based scan flagged ${ruleResult.issues.length} handcrafted weakness${ruleResult.issues.length === 1 ? "" : "es"}${learnedHits.length ? ` plus ${learnedHits.length} learned-rule hit${learnedHits.length === 1 ? "" : "s"}` : ""} (score ${ruleResult.weaknessScore}): ${[...ruleResult.issues.map((i) => i.flag), ...learnedHits.map((h) => h.rule_type)].join(", ")}.`;

  const mainPosition = ruleResult.flags.denialLanguage
    ? "Document advances a denial / exclusion position."
    : ruleResult.flags.scopeMinimization
    ? "Document advances a reduced-scope position."
    : "Document advances a coverage / scope position requiring closer review.";

  const draft = rebuttalPoints.length > 0
    ? `We respectfully challenge the conclusions of this report on the following grounds:\n\n${rebuttalPoints.map((r, i) => `${i + 1}. ${r}`).join("\n\n")}\n\nWe request a corrected position supported by the evidence outlined above.`
    : "No automated rebuttal generated — document did not trigger rule-based weaknesses.";

  return {
    documentType: docTypeHint || (ruleResult.flags.denialLanguage ? "carrier_denial" : "engineer_report"),
    reportSummary: summary,
    mainPosition,
    nonCoveredTheories: ruleResult.flags.denialLanguage ? ["Coverage denied per cited exclusion (citation required)"] : [],
    limitations,
    unsupportedAssumptions: assumptions,
    contradictions: ruleResult.meta.contradictionsSuspected ? ["Hedging/contradiction signals detected — requires AI review"] : [],
    omissions: ruleResult.flags.noTesting ? ["No physical testing referenced"] : [],
    repairabilityOverreach: ruleResult.flags.scopeMinimization ? ["Repair-in-place recommended without matching analysis"] : [],
    coverageWeaknesses: ruleResult.flags.denialLanguage ? ["Exclusion invoked without specific policy citation tied to loss facts"] : [],
    strongestRebuttalPoints: rebuttalPoints,
    evidenceToGatherNext: evidence,
    draftRebuttalLanguage: draft,
    source: "rules",
    ruleResult,
  };
}
