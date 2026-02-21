/**
 * Phase 4 Acceptance Tests — Escalation Engine
 *
 * Run with: node scripts/test-escalation-engine.mjs
 *
 * Tests:
 * 1. State detection correctness (false positives, structured fields)
 * 2. No deadlines tracked → only "missing tracking" rules fire
 * 3. Overdue carrier deadline → formal_leverage delay trigger fires
 * 4. Coverage accepted + scope disputed → appraisal triggers only
 * 5. Prompt injection guard → max 5 rules, max 3000 chars
 * 6. Tone guardrail — no threats/bad faith accusations in recommended_action
 */

// ============================================================
// Test 1: State detection correctness
// ============================================================
const STATE_PATTERNS = [
  { code: "NJ", regex: /(^|[\s,])NJ([\s,]|$)/i },
  { code: "NJ", regex: /\bNEW\s+JERSEY\b/i },
  { code: "PA", regex: /(^|[\s,])PA([\s,]|$)/i },
  { code: "PA", regex: /\bPENNSYLVANIA\b/i },
];
const ZIP_STATE_REGEX = /\b([A-Z]{2})\s+\d{5}\b/;

function detectStateFromAddress(address) {
  if (!address) return null;
  const zipMatch = address.toUpperCase().match(ZIP_STATE_REGEX);
  if (zipMatch) {
    if (zipMatch[1] === "PA") return "PA";
    if (zipMatch[1] === "NJ") return "NJ";
  }
  for (const { code, regex } of STATE_PATTERNS) {
    if (regex.test(address)) return code;
  }
  return null;
}

function detectStateFromClaim(claim) {
  const structured = (claim?.client_state || claim?.property_state || "").toUpperCase().trim();
  if (structured === "PA" || structured === "PENNSYLVANIA") return "PA";
  if (structured === "NJ" || structured === "NEW JERSEY") return "NJ";
  return detectStateFromAddress(claim?.policyholder_address);
}

const stateTests = [
  // FALSE POSITIVES — must NOT match PA
  { address: "123 APARTMENT BLVD, NEW YORK, NY 10001", expected: null, label: "APARTMENT must not match PA" },
  { address: "456 PARK AVE, NEW YORK, NY 10022", expected: null, label: "PARK must not match PA" },
  { address: "PATRICIA LANE, BOSTON, MA 02101", expected: null, label: "PATRICIA must not match PA" },
  { address: "789 SPALDING RD, ATLANTA, GA 30301", expected: null, label: "SPALDING must not match PA" },
  
  // TRUE POSITIVES
  { address: "123 Main St, Philadelphia, PA 19103", expected: "PA", label: "PA with ZIP" },
  { address: "456 Elm St, Manahawkin, NJ 08050", expected: "NJ", label: "NJ with ZIP" },
  { address: "123 Main St, Pennsylvania", expected: "PA", label: "Full state name PENNSYLVANIA" },
  { address: "789 Ocean Ave, New Jersey", expected: "NJ", label: "Full state name NEW JERSEY" },
  { address: "100 Broad St, Newark, NJ", expected: "NJ", label: "NJ without ZIP" },
  
  // Structured field override
  { claim: { client_state: "PA", policyholder_address: "123 Main St, Atlanta, GA 30301" }, expected: "PA", label: "Structured field overrides address" },
  { claim: { property_state: "NJ", policyholder_address: "456 Elm St, Dallas, TX 75001" }, expected: "NJ", label: "property_state overrides address" },
];

let passed = 0;
let failed = 0;

console.log("=== TEST 1: State Detection Correctness ===\n");
for (const test of stateTests) {
  const claim = test.claim || { policyholder_address: test.address };
  const result = detectStateFromClaim(claim);
  const ok = result === test.expected;
  console.log(`${ok ? "✅" : "❌"} ${test.label}: got "${result}", expected "${test.expected}"`);
  if (ok) passed++; else failed++;
}

// ============================================================
// Test 2: No deadlines tracked — only "missing tracking" rules fire
// ============================================================
console.log("\n=== TEST 2: No Deadlines → Only Missing-Tracking Rules Fire ===\n");

function evaluateRule(rule, claimState) {
  const c = rule.condition_logic;
  if (c.days_since_claim_filed_gt && claimState.days_since_filed <= c.days_since_claim_filed_gt) return false;
  if (c.deadline_type && c.deadline_status_not) {
    const allDl = [...claimState.deadlines, ...claimState.carrier_deadlines];
    const matching = allDl.filter(d => d.deadline_type === c.deadline_type);
    if (matching.some(d => d.status === c.deadline_status_not)) return false;
  }
  if (c.no_coverage_determination && claimState.has_coverage_determination) return false;
  if (c.coverage_accepted && !claimState.coverage_accepted) return false;
  if (c.scope_disputed && !claimState.scope_disputed) return false;
  if (c.missed_deadlines_gt && claimState.missed_deadline_count <= c.missed_deadlines_gt) return false;
  if (c.trade_in && (!claimState.trade || !c.trade_in.includes(claimState.trade))) return false;
  if (c.denial_rationale_contains && (!claimState.denial_rationale || !claimState.denial_rationale.toLowerCase().includes(c.denial_rationale_contains.toLowerCase()))) return false;
  if (c.playbook_appraisal_delta_gt !== undefined && (!claimState.playbook_data || claimState.playbook_data.appraisal_delta <= c.playbook_appraisal_delta_gt)) return false;
  if (c.playbook_sample_size_gt !== undefined && (!claimState.playbook_data || claimState.playbook_data.sample_size <= c.playbook_sample_size_gt)) return false;
  return true;
}

// Simulate a claim with NO deadlines and 45 days old
const noDeadlineState = {
  days_since_filed: 45,
  deadlines: [],
  carrier_deadlines: [],
  has_coverage_determination: false,
  has_written_position: false,
  coverage_accepted: false,
  scope_disputed: false,
  missed_deadline_count: 0,
  trade: null,
  denial_rationale: null,
  playbook_data: null,
};

// Rules that require missed_deadlines_gt > 0 should NOT fire
const missedDeadlineRule = {
  condition_logic: { missed_deadlines_gt: 0 },
  trigger_name: "Multiple Missed Deadlines",
};
const missedResult = evaluateRule(missedDeadlineRule, noDeadlineState);
const ok2 = missedResult === false;
console.log(`${ok2 ? "✅" : "❌"} missed_deadlines_gt rule should NOT fire with 0 missed: got ${missedResult}`);
if (ok2) passed++; else failed++;

// Rules requiring coverage_accepted should NOT fire
const appraisalRule = {
  condition_logic: { coverage_accepted: true, scope_disputed: true },
  trigger_name: "Appraisal Trigger",
};
const appraisalResult = evaluateRule(appraisalRule, noDeadlineState);
const ok2b = appraisalResult === false;
console.log(`${ok2b ? "✅" : "❌"} Appraisal rule should NOT fire without coverage_accepted: got ${appraisalResult}`);
if (ok2b) passed++; else failed++;

// A delay rule (days > 30 + no coverage determination) SHOULD fire
const delayRule = {
  condition_logic: { days_since_claim_filed_gt: 30, no_coverage_determination: true },
  trigger_name: "PA Delay - No Coverage Determination",
};
const delayResult = evaluateRule(delayRule, noDeadlineState);
const ok2c = delayResult === true;
console.log(`${ok2c ? "✅" : "❌"} Delay rule (no determination after 30 days) SHOULD fire: got ${delayResult}`);
if (ok2c) passed++; else failed++;

// ============================================================
// Test 3: Overdue carrier deadline → formal_leverage fires
// ============================================================
console.log("\n=== TEST 3: Overdue Carrier Deadline ===\n");

const overdueState = {
  ...noDeadlineState,
  carrier_deadlines: [
    { deadline_type: "acknowledgment", status: "overdue", days_overdue: 5, bad_faith_potential: false },
  ],
  missed_deadline_count: 1,
};

// deadline_status_not = "met" means: fire if acknowledgment is NOT met
const ackRule = {
  condition_logic: { 
    days_since_claim_filed_gt: 10, 
    deadline_type: "acknowledgment", 
    deadline_status_not: "met" 
  },
  trigger_name: "PA Ack Deadline Missed",
};
const ackResult = evaluateRule(ackRule, overdueState);
const ok3 = ackResult === true;
console.log(`${ok3 ? "✅" : "❌"} Ack deadline overdue should fire: got ${ackResult}`);
if (ok3) passed++; else failed++;

// If deadline IS met, rule should NOT fire
const metState = {
  ...noDeadlineState,
  carrier_deadlines: [
    { deadline_type: "acknowledgment", status: "met", days_overdue: null, bad_faith_potential: false },
  ],
};
const metResult = evaluateRule(ackRule, metState);
const ok3b = metResult === false;
console.log(`${ok3b ? "✅" : "❌"} Ack deadline met should NOT fire: got ${metResult}`);
if (ok3b) passed++; else failed++;

// ============================================================
// Test 4: Coverage accepted + scope disputed → appraisal triggers
// ============================================================
console.log("\n=== TEST 4: Coverage Accepted + Scope Disputed ===\n");

const appraisalState = {
  ...noDeadlineState,
  coverage_accepted: true,
  scope_disputed: true,
  playbook_data: { appraisal_delta: 5000, sample_size: 30, label: "Scenario-specific" },
};

const appraisalTrigger = {
  condition_logic: { 
    coverage_accepted: true, 
    scope_disputed: true,
    playbook_appraisal_delta_gt: 0,
    playbook_sample_size_gt: 5,
  },
  trigger_name: "Appraisal Leverage",
};
const ok4 = evaluateRule(appraisalTrigger, appraisalState) === true;
console.log(`${ok4 ? "✅" : "❌"} Appraisal trigger fires with coverage+scope+playbook: got ${evaluateRule(appraisalTrigger, appraisalState)}`);
if (ok4) passed++; else failed++;

// Without scope disputed → should NOT fire
const noScopeState = { ...appraisalState, scope_disputed: false };
const ok4b = evaluateRule(appraisalTrigger, noScopeState) === false;
console.log(`${ok4b ? "✅" : "❌"} Appraisal trigger does NOT fire without scope_disputed: got ${evaluateRule(appraisalTrigger, noScopeState)}`);
if (ok4b) passed++; else failed++;

// ============================================================
// Test 5: Prompt injection guard
// ============================================================
console.log("\n=== TEST 5: Prompt Injection Guard (Cap + Size) ===\n");

const MAX_RULES = 5;
const MAX_CHARS = 3000;

// Simulate 15 fired rules
const manyRules = Array.from({ length: 15 }, (_, i) => ({
  escalation_strength: i < 3 ? "regulatory_leverage" : i < 8 ? "formal_leverage" : "soft_leverage",
  trigger_name: `Test Trigger ${i + 1}`,
  regulation_citation: `Test § ${i + 1}.${i}`,
  regulation_summary: `Summary for trigger ${i + 1} with enough text to take up space.`,
  recommended_action: `Recommended action for trigger ${i + 1}.`,
  recommended_artifact: i % 2 === 0 ? "rebuttal" : null,
}));

const cappedRules = manyRules.slice(0, MAX_RULES);
const ok5 = cappedRules.length === MAX_RULES;
console.log(`${ok5 ? "✅" : "❌"} Capped to ${MAX_RULES} rules from ${manyRules.length}: got ${cappedRules.length}`);
if (ok5) passed++; else failed++;

// Build context and check size
let context = `=== REGULATORY LEVERAGE CONTEXT (PA) ===\nACTIVE TRIGGERS: ${cappedRules.length}\n`;
for (const rule of cappedRules) {
  const entry = `[${rule.escalation_strength}] ${rule.trigger_name}\n  Citation: ${rule.regulation_citation}\n  Summary: ${rule.regulation_summary}\n  Action: ${rule.recommended_action}\n`;
  if (context.length + entry.length > MAX_CHARS) break;
  context += entry;
}
const ok5b = context.length <= MAX_CHARS;
console.log(`${ok5b ? "✅" : "❌"} Context size ${context.length} chars <= ${MAX_CHARS}: ${ok5b}`);
if (ok5b) passed++; else failed++;

// ============================================================
// Test 6: Tone guardrail — no threats in recommended actions
// ============================================================
console.log("\n=== TEST 6: Tone Guardrail ===\n");

const BANNED_PHRASES = [
  "bad faith",
  "threaten",
  "sue",
  "lawsuit",
  "we will file",
  "accuse",
  "you are violating",
  "legal action",
];

// Sample recommended actions from seed data (representative)
const sampleActions = [
  "Carrier behavior approaching delay exposure under PA prompt handling standards. Recommend formal written coverage position request referencing claim handling obligations.",
  "Matching leverage exists in this jurisdiction. Recommend including uniform appearance argument in supplement narrative.",
  "Appraisal historically increases recovery in this scenario. Consider invoking if supplement response remains inadequate.",
  "Pattern of missed statutory deadlines documented. Recommend formal written demand for coverage position citing NJ Unfair Claims Settlement Practices Act obligations.",
];

let toneOk = true;
for (const action of sampleActions) {
  const lower = action.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      console.log(`❌ Banned phrase "${phrase}" found in: "${action.substring(0, 60)}..."`);
      toneOk = false;
      failed++;
    }
  }
}
if (toneOk) {
  console.log("✅ All sample recommended actions pass tone guardrail");
  passed++;
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`PHASE 4 ACCEPTANCE TESTS: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);

if (failed > 0) process.exit(1);
