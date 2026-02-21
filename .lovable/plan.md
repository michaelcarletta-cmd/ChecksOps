
# Phase 4: PA/NJ Regulatory and Leverage Engine

## Overview

Transform Darwin from a passive regulation lookup into an active **Escalation Intelligence Engine** that automatically detects carrier behavior patterns and recommends precisely-timed leverage actions for PA and NJ claims.

## What Exists Today

- **state_insurance_regulations** table: 48 rows across PA/NJ/TX/FL with basic regulation types (insurer_response, bad_faith, pol_deadline, unfair_claims)
- **DarwinStateLawAdvisor**: Static read-only display of regulations by state tab
- **DarwinDeadlineTracker**: Auto-generates regulatory deadlines from claim creation date
- **DarwinCarrierDeadlineMonitor**: Manual deadline tracking with overdue/bad-faith badge
- **DarwinComplianceChecker**: Regex-based compliance scanning for outgoing messages
- **CarrierScenarioPlaybook**: Phase 3 playbook with win rates and tactic rankings

**Gap**: No system connects claim timeline events to specific regulatory triggers, and no component recommends *when* and *how* to escalate.

---

## Build Plan

### 1. Database: Escalation Rules Table

Create `escalation_trigger_rules` -- a deterministic rule engine, not vibes.

| Column | Purpose |
|--------|---------|
| id | Primary key |
| state_code | PA or NJ |
| trigger_category | delay / matching / appraisal / bad_faith / scope_reduction / coverage_demand |
| trigger_name | Human-readable name |
| condition_logic | JSONB: deterministic conditions (e.g., `{"days_since_claim_filed_gt": 30, "no_coverage_determination": true}`) |
| escalation_strength | soft_leverage / formal_leverage / regulatory_leverage |
| regulation_citation | Statute reference (e.g., "31 Pa. Code SS 146.5") |
| regulation_summary | Plain-language summary (no legal advice) |
| recommended_action | Procedural next step phrased as colleague advice |
| recommended_artifact | rebuttal / rfi / supplement / doi_complaint / formal_position_request / appraisal_demand |
| priority_order | Sort order within category |
| is_active | Toggle |

**Seed data**: ~30 rules covering the core PA/NJ triggers you specified:
- **Delay triggers**: No acknowledgment within 10 business days, no investigation complete within 30 days, no written coverage determination within statutory window, repeated document requests without substantive decision
- **Matching triggers**: Repairability tactic ranked high + uniformity risk + state supports matching
- **Appraisal triggers**: Coverage accepted but scope disputed + playbook shows high appraisal delta
- **Bad faith triggers**: Pattern of delay + missed deadlines + inconsistent positions across documents
- **Coverage demand triggers**: No formal written position after reasonable window

### 2. Backend: Escalation Evaluation Engine (Edge Function)

Create `darwin-strategic-intelligence` edge function (or extend existing) with a `evaluateEscalationTriggers` function:

```text
Input:
  claim_id, state_code

Steps:
  1. Load claim data (dates, status, deadlines from claim_deadlines + claim_carrier_deadlines)
  2. Load claim timeline events (status changes, document uploads, communications)
  3. Load active escalation_trigger_rules for this state
  4. For each rule, evaluate condition_logic against claim state:
     - days_since_claim_filed > threshold?
     - coverage_determination_received = false?
     - playbook win_rate for appraisal > threshold?
     - deadline status = missed?
  5. Return fired triggers ranked by escalation_strength + priority
  6. Cross-reference with carrier_scenario_playbooks for data backing
```

Output: Array of `EscalationAlert` objects:
- trigger_name, escalation_strength, regulation_citation, regulation_summary
- recommended_action (colleague-tone)
- recommended_artifact
- playbook_backing (confidence + n if available)

### 3. AI Integration: Darwin Consults Escalation Engine

Update `claims-ai-assistant` system prompt to include escalation context:

- Before generating strategic advice, call `evaluateEscalationTriggers`
- Inject fired triggers into the prompt as `REGULATORY LEVERAGE CONTEXT`
- Darwin must cite statute short reference + plain-language summary
- Darwin must recommend procedural next step, never threats
- Tone enforcement: "Strategic. Not aggressive."

### 4. Frontend: Escalation Alerts Panel

Create `DarwinEscalationEngine.tsx` -- replaces or augments the current static State Law Advisor:

**Layout:**
- Header: "Regulatory Leverage Engine" with state badge (auto-detected from claim address)
- Active Alerts section: Cards for each fired trigger, color-coded by strength:
  - Soft leverage (blue): informational timing advantages
  - Formal leverage (amber): recommend formal written action
  - Regulatory leverage (red): DOI/statutory violation territory
- Each alert card shows:
  - Trigger name + escalation strength badge
  - Regulation citation (short) + plain-language summary
  - Recommended action (colleague tone)
  - "Draft [artifact]" button that pre-populates the appropriate Darwin tool
  - Playbook backing if available (confidence + n)
- Bottom section: Full regulation reference (collapsible, pulls from existing state_insurance_regulations)

**Integration point**: Add to the "Claim Intelligence" workspace in DarwinTab alongside CarrierScenarioPlaybook.

### 5. Seed PA/NJ Escalation Rules (Data Insert)

Populate ~30 deterministic rules. Examples:

**PA Delay Trigger:**
- Condition: claim filed > 10 business days ago AND no acknowledgment deadline marked "met"
- Citation: 31 Pa. Code SS 146.5
- Action: "Carrier behavior approaching delay exposure under PA prompt handling standards. Recommend formal written coverage position request referencing claim handling obligations."
- Strength: formal_leverage

**NJ Matching Trigger:**
- Condition: trade = roof/siding AND denial_rationale contains "repairable" AND playbook matching_tactic success_lift > 0
- Citation: N.J.A.C. 11:2-17.7(d)
- Action: "Matching leverage exists in this jurisdiction. Recommend including uniform appearance argument in supplement narrative."
- Strength: soft_leverage

**PA Appraisal Trigger:**
- Condition: coverage accepted AND scope disputed AND playbook appraisal median_delta > 0 AND sample_size > 5
- Citation: Policy appraisal clause
- Action: "Appraisal historically increases recovery in this scenario (median delta $X, n=Y). Consider invoking if supplement response remains inadequate."
- Strength: formal_leverage

**NJ Bad Faith Trigger:**
- Condition: 2+ deadlines missed AND days_since_claim_filed > 60
- Citation: N.J.S.A. 17:29B-4
- Action: "Pattern of missed statutory deadlines documented. Recommend formal written demand for coverage position citing NJ Unfair Claims Settlement Practices Act obligations."
- Strength: regulatory_leverage

### 6. Authority Citation Behavior (Prompt Guardrails)

Add to the AI system prompt:
- Cite statute name + section (short reference only)
- Summarize in plain language
- Never frame as legal advice -- always "recommend procedural next step"
- Never use threatening language -- always strategic/controlled
- Label escalation strength explicitly so the user knows the weight of the recommendation

---

## Technical Details

### Files to Create
- `supabase/migrations/[timestamp]_phase4_escalation_engine.sql` -- escalation_trigger_rules table + seed data
- `src/components/claim-detail/DarwinEscalationEngine.tsx` -- new UI component

### Files to Modify
- `supabase/functions/claims-ai-assistant/index.ts` -- add escalation context retrieval + prompt injection
- `src/components/claim-detail/DarwinTab.tsx` -- add DarwinEscalationEngine to Claim Intelligence workspace
- `supabase/config.toml` -- if new edge function needed

### Data Flow

```text
Claim opened/updated
       |
       v
DarwinEscalationEngine loads claim state
       |
       v
Fetches escalation_trigger_rules for claim state (PA/NJ)
       |
       v
Evaluates each rule's condition_logic against:
  - claim_deadlines status
  - claim_carrier_deadlines (overdue?)
  - carrier_scenario_playbooks (appraisal/matching data)
  - claim timeline (days elapsed, docs received)
       |
       v
Returns fired alerts ranked by strength + priority
       |
       v
Displayed as actionable cards with "Draft" buttons
       |
       v
Darwin AI also receives these as REGULATORY LEVERAGE CONTEXT
in every strategic response
```

### No New Secrets Required
All existing API keys and integrations are sufficient.
