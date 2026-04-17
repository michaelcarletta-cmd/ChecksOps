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

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { getActiveLearnedRules } from "./ruleLearningEngine.ts";

export type RuleFlag =
  | "speculativeLanguage"
  | "noTesting"
  | "visualOnly"
  | "denialLanguage"
  | "causationWithoutSupport"
  | "scopeMinimization";

// Peril / loss-type taxonomy (rules-first, no AI).
// Order matters for tie-breaks: more specific perils win over generic ones.
export type LossType =
  | "pipe_leak"
  | "water_damage"
  | "sewer_backup"
  | "appliance_leak"
  | "fire"
  | "smoke"
  | "wind"
  | "hail"
  | "tree_impact"
  | "lightning"
  | "freeze"
  | "mold"
  | "theft_vandalism"
  | "vehicle_impact"
  | "unknown";

export interface LossTypeDetection {
  primary: LossType;
  secondary: LossType[];
  scores: Partial<Record<LossType, number>>;
  evidence: Partial<Record<LossType, string[]>>; // verbatim phrases that triggered each peril
  confidence: "high" | "medium" | "low";
}

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
  lossType: LossTypeDetection;
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

// ── Loss-type / peril detection (rules-first) ───────────────────────
//
// Each peril has positive evidence patterns and (where useful) anti-patterns
// that subtract score. We score every peril, then choose the dominant one.
// Confidence is "high" when the leader beats the runner-up by a clear margin
// AND has at least 3 distinct evidence hits; otherwise "medium" or "low".

interface PerilDef {
  type: LossType;
  patterns: RegExp[];
  // Penalty patterns: phrases like "no wind damage observed" subtract score.
  antiPatterns?: RegExp[];
  weight: number;
}

const LOSS_TYPE_DEFS: PerilDef[] = [
  {
    type: "pipe_leak",
    weight: 3,
    patterns: [
      /\bpipe\s+leak\b/gi,
      /\bpipe\s+burst\b/gi,
      /\bburst\s+pipe\b/gi,
      /\bplumbing\s+leak\b/gi,
      /\bsupply\s+line\s+(failure|leak|rupture)\b/gi,
      /\bfailed\s+(pex|copper|cpvc|polybutylene)\b/gi,
      /\bcrawlspace\s+(pipe|leak|plumbing)\b/gi,
      /\bremoved\s+and\s+replaced\s+pipe\b/gi,
      /\b(toilet|sink|tub|shower)\s+(leak|overflow|supply)\b/gi,
      /\bplumber\b/gi,
    ],
    antiPatterns: [/\bno\s+plumbing\s+(leak|failure)\b/gi, /\bno\s+evidence\s+of\s+a?\s*pipe\s+leak\b/gi],
  },
  {
    type: "appliance_leak",
    weight: 3,
    patterns: [
      /\b(washer|washing\s+machine|dishwasher|refrigerator|ice\s+maker|water\s+heater)\s+(leak|failure|hose|line)\b/gi,
      /\bappliance\s+(leak|failure|supply)\b/gi,
    ],
  },
  {
    type: "sewer_backup",
    weight: 3,
    patterns: [
      /\bsewer\s+backup\b/gi,
      /\bsewage\s+(backup|intrusion)\b/gi,
      /\bdrain\s+backup\b/gi,
      /\bback\s+up\s+through\s+(drain|toilet)\b/gi,
    ],
  },
  {
    type: "water_damage",
    weight: 2,
    patterns: [
      /\bwater\s+damage\b/gi,
      /\bwater\s+intrusion\b/gi,
      /\bwater\s+infiltration\b/gi,
      /\bsaturated\s+(drywall|insulation|sheathing|carpet|flooring)\b/gi,
      /\bstained\s+(drywall|ceiling|sheathing)\b/gi,
      /\bmoisture\s+content\b/gi,
      /\bdrying\s+(equipment|fans|process)\b/gi,
      /\bfans\s+(installed|removed)\b/gi,
    ],
  },
  {
    type: "freeze",
    weight: 3,
    patterns: [
      /\bfrozen\s+pipe(s)?\b/gi,
      /\bfreeze\s+(loss|damage|event)\b/gi,
      /\bsub-?freezing\s+temperatures?\b/gi,
      /\bpipe\s+froze\b/gi,
    ],
  },
  {
    type: "wind",
    weight: 3,
    patterns: [
      /\bwind\s+damage\b/gi,
      /\bwind\s+event\b/gi,
      /\bwind\s+uplift\b/gi,
      /\bhigh\s+winds?\b/gi,
      /\bwind\s+speeds?\b/gi,
      /\bwind-?driven\b/gi,
      /\bblown\s+off\b/gi,
      /\bcreased\s+shingles?\b/gi,
      /\btab\s+(lift|seal\s+failure)\b/gi,
    ],
    antiPatterns: [
      /\bno\s+wind\s+damage\b/gi,
      /\bno\s+evidence\s+of\s+wind\b/gi,
      /\bwind\s+is\s+not\s+the\s+cause\b/gi,
    ],
  },
  {
    type: "hail",
    weight: 3,
    patterns: [
      /\bhail\s+damage\b/gi,
      /\bhail\s+impact(s)?\b/gi,
      /\bhail\s+strike(s)?\b/gi,
      /\bhail\s+stones?\b/gi,
      /\bspatter\s+marks?\b/gi,
      /\bbruising\b/gi,
    ],
    antiPatterns: [/\bno\s+hail\s+damage\b/gi, /\bno\s+evidence\s+of\s+hail\b/gi],
  },
  {
    type: "fire",
    weight: 3,
    patterns: [
      /\bfire\s+(damage|loss|origin)\b/gi,
      /\bcombustion\b/gi,
      /\bcharring\b/gi,
      /\bsoot\s+(deposit|residue)\b/gi,
      /\bburn\s+pattern\b/gi,
    ],
  },
  {
    type: "smoke",
    weight: 2,
    patterns: [/\bsmoke\s+(damage|residue|odor|deposit)\b/gi, /\bsoot\s+(damage|cleaning)\b/gi],
  },
  {
    type: "lightning",
    weight: 3,
    patterns: [/\blightning\s+(strike|damage|event)\b/gi, /\bsurge\s+from\s+lightning\b/gi],
  },
  {
    type: "tree_impact",
    weight: 3,
    patterns: [/\btree\s+(fell|fall|impact|strike)\b/gi, /\bfallen\s+tree\b/gi, /\blimb\s+(fell|impact|strike)\b/gi],
  },
  {
    type: "vehicle_impact",
    weight: 3,
    patterns: [/\bvehicle\s+(impact|struck|collision)\b/gi, /\bcar\s+(struck|hit)\s+(the\s+)?(house|garage|wall)\b/gi],
  },
  {
    type: "theft_vandalism",
    weight: 3,
    patterns: [/\btheft\b/gi, /\bvandalism\b/gi, /\bforced\s+entry\b/gi, /\bbroken\s+window\b/gi],
  },
  {
    type: "mold",
    weight: 2,
    patterns: [/\bmold\s+(growth|damage|remediation)\b/gi, /\bmould\b/gi, /\bbiological\s+growth\b/gi],
  },
];

function countMatches(text: string, patterns: RegExp[]): number {
  let total = 0;
  for (const p of patterns) {
    const m = text.match(p);
    if (m) total += m.length;
  }
  return total;
}

export function detectLossType(text: string): LossTypeDetection {
  const safe = (text || "").toString();
  const scores: Partial<Record<LossType, number>> = {};
  const evidence: Partial<Record<LossType, string[]>> = {};

  for (const def of LOSS_TYPE_DEFS) {
    const positive = countMatches(safe, def.patterns);
    if (positive === 0) continue;

    const phrases = collectMatches(safe, def.patterns);
    const antiPhrases = def.antiPatterns ? collectMatches(safe, def.antiPatterns) : [];
    const antiCount = def.antiPatterns ? countMatches(safe, def.antiPatterns) : 0;

    // Anti-patterns can fully neutralize OR penalize.
    // Heavy penalty: each anti-hit subtracts ~2x the per-hit weight, capped at +0.
    let raw = positive * def.weight - antiCount * def.weight * 2;
    if (raw < 0) raw = 0;

    if (raw > 0) {
      scores[def.type] = raw;
      // Evidence excludes anti-phrases so the user sees the supporting language only
      evidence[def.type] = phrases.filter((p) => !antiPhrases.includes(p)).slice(0, 6);
    }
  }

  const ranked = Object.entries(scores)
    .map(([type, score]) => ({ type: type as LossType, score: score as number }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return { primary: "unknown", secondary: [], scores, evidence, confidence: "low" };
  }

  const leader = ranked[0];
  const runnerUp = ranked[1];
  const margin = runnerUp ? leader.score - runnerUp.score : leader.score;
  const evidenceCount = (evidence[leader.type] || []).length;

  let confidence: "high" | "medium" | "low";
  if (leader.score >= 6 && evidenceCount >= 3 && margin >= 3) confidence = "high";
  else if (leader.score >= 3 && evidenceCount >= 2) confidence = "medium";
  else confidence = "low";

  // Secondary perils only if they are at least 50% of the leader (multi-peril claims)
  const secondary = ranked
    .slice(1)
    .filter((r) => r.score >= leader.score * 0.5)
    .map((r) => r.type);

  return { primary: leader.type, secondary, scores, evidence, confidence };
}

const LOSS_TYPE_LABELS: Record<LossType, string> = {
  pipe_leak: "pipe leak / plumbing failure",
  water_damage: "water damage",
  sewer_backup: "sewer / drain backup",
  appliance_leak: "appliance-supply leak",
  fire: "fire",
  smoke: "smoke",
  wind: "wind",
  hail: "hail",
  tree_impact: "tree / limb impact",
  lightning: "lightning",
  freeze: "freeze / frozen pipe",
  mold: "mold / biological growth",
  theft_vandalism: "theft / vandalism",
  vehicle_impact: "vehicle impact",
  unknown: "unspecified",
};

export function describeLossType(d: LossTypeDetection): string {
  if (d.primary === "unknown") return "unspecified loss type";
  const sec = d.secondary.length > 0 ? ` (with secondary: ${d.secondary.map((s) => LOSS_TYPE_LABELS[s]).join(", ")})` : "";
  return `${LOSS_TYPE_LABELS[d.primary]}${sec} [confidence: ${d.confidence}]`;
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

  // Loss-type detection (rules-first, no AI).
  const lossType = detectLossType(safe);

  // Escalation logic
  let escalationReason: string | null = null;
  if (weaknessScore >= ESCALATE_SCORE_THRESHOLD) {
    escalationReason = `weaknessScore=${weaknessScore} >= ${ESCALATE_SCORE_THRESHOLD}`;
  } else if (contradictionsSuspected) {
    escalationReason = "contradictions suspected";
  } else if (length > ESCALATE_LENGTH_THRESHOLD) {
    escalationReason = `documentLength=${length} > ${ESCALATE_LENGTH_THRESHOLD}`;
  } else if (length > 1500 && lossType.primary === "unknown") {
    // Substantial document we couldn't classify — let AI decide rather than mislabel.
    escalationReason = "loss type unknown on substantial document";
  }

  return {
    issues,
    weaknessScore,
    flags,
    shouldEscalateToAI: escalationReason !== null,
    escalationReason,
    lossType,
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
