
# War Room 2.0 -- Strategic Command Center

## Overview

Transform the existing War Room from a 4-quadrant strategic dashboard into a predictive, litigation-grade Strategic Command Center with composite scoring, predictive intelligence, scenario simulation, and exportable strategic memos.

---

## Phase 1: Database Schema (New Tables + Column Additions)

### 1A. Extend `claim_strategic_insights` table
Add new columns for the Weighted Strategic Index (WSI), Litigation Readiness, and Pressure Index:

- `procedural_compliance_score INTEGER` (new WSI component)
- `carrier_conduct_risk_score INTEGER` (new WSI component)
- `wsi_score INTEGER` (replaces `overall_health_score` conceptually; stored alongside for backward compatibility)
- `wsi_components JSONB` (breakdown of all 5 weighted sub-scores with explanations)
- `litigation_readiness_score INTEGER` (0-100)
- `litigation_readiness_factors JSONB` (expert reports present, damages quantified, causation documented, statutory violations, pre-suit demand, evidence gaps)
- `pressure_index_score INTEGER` (0-100)
- `pressure_index_level TEXT` (low / moderate / high)
- `pressure_index_factors JSONB` (statutory violations, missed deadlines, bad faith indicators, complaint exposure, litigation cost risk)
- `strategic_memo JSONB` (structured: executive summary, strongest leverage, greatest vulnerability, immediate action, 30-day plan, escalation trigger, settlement range, bad faith viability)
- `predicted_carrier_move JSONB` (prediction text, confidence, timeline, basis)
- `scenario_simulations JSONB` (array of simulation results)

### 1B. New table: `claim_predictive_analysis`
```
id UUID PK
claim_id UUID FK -> claims
prediction_type TEXT (carrier_next_move, timeline, outcome)
prediction TEXT
confidence INTEGER (0-100)
basis JSONB (what data points fed this)
predicted_timeline TEXT (e.g. "within 14 days")
actual_outcome TEXT (filled when prediction resolves)
was_accurate BOOLEAN
created_at TIMESTAMPTZ
resolved_at TIMESTAMPTZ
```

### 1C. New table: `carrier_behavior_analytics`
Aggregate analytics across all claims per carrier:
```
id UUID PK
carrier_name TEXT UNIQUE
total_claims_analyzed INTEGER
avg_days_to_deny NUMERIC
avg_days_to_pay NUMERIC
initial_denial_rate NUMERIC
most_common_denial_reasons JSONB
reversal_rate_after_engineer NUMERIC
reversal_rate_after_supplement NUMERIC
litigation_frequency NUMERIC
avg_first_offer_vs_final NUMERIC
last_computed_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

### 1D. New table: `claim_scenario_simulations`
```
id UUID PK
claim_id UUID FK -> claims
scenario_action TEXT (e.g. "obtain_engineer_report", "send_noi", "escalate_supervisor")
scenario_label TEXT
result_wsi INTEGER
result_litigation_readiness INTEGER
result_pressure_index INTEGER
result_win_probability_range TEXT (e.g. "65-80%")
result_explanation TEXT
created_at TIMESTAMPTZ
```

RLS: All new tables get `auth.uid() IS NOT NULL` policy for authenticated access, consistent with existing pattern.

---

## Phase 2: Backend -- Upgrade `darwin-strategic-intelligence`

### 2A. Expand the AI prompt
The existing edge function already gathers comprehensive claim data. We will:

1. Add a new `analysisType: 'war_room_2'` branch that requests an expanded JSON schema from the AI, including:
   - **WSI** with 5 weighted components (Coverage 25%, Evidence 25%, Leverage 20%, Procedural Compliance 15%, Carrier Conduct Risk 15%), each with an explanation
   - **Predicted Carrier Next Move** with confidence and basis
   - **Litigation Readiness Index** with factor-by-factor breakdown
   - **Pressure Index** with statutory/deadline/bad-faith factors
   - **Structured Strategic Memo** (8 sections per the directive)
   - **Scenario Simulations** for 3-4 predefined "what if" scenarios

2. Store all results in the extended `claim_strategic_insights` columns and the new `claim_predictive_analysis` table.

3. Query `carrier_behavior_analytics` for cross-claim carrier data and inject it into the AI context as "Global Intelligence."

### 2B. Carrier Behavior Analytics Computation
Add a helper function inside the edge function (or a separate scheduled function) that aggregates across all claims for a given carrier:
- Count denials, avg response times, reversal rates
- Store in `carrier_behavior_analytics`
- Use cached data (refresh if older than 7 days)

### 2C. Scenario Simulation
For each simulation scenario (engineer report, NOI, escalation, etc.):
- Re-run the WSI/Litigation/Pressure calculations with the hypothetical condition toggled
- Return delta scores showing impact
- Store in `claim_scenario_simulations`

---

## Phase 3: Frontend -- War Room 2.0 UI

### 3A. Top Stats Bar (replace current 5-card row)
Replace with 6 key metrics:

| WSI (0-100) | Litigation Readiness (0-100) | Pressure Index (Low/Mod/High) | Days Open | Overdue Deadlines | Bad Faith Flags |

- WSI card is clickable and expands to show the 5 weighted sub-scores with progress bars and explanations
- Litigation Readiness is clickable and shows a checklist (expert reports, damages quantified, causation documented, etc.)
- Pressure Index shows a colored badge (green/yellow/red)

### 3B. Four Quadrants (upgraded)

**Q1: Evidence-Linked Timeline** (was Causality Timeline)
- Keep existing timeline but add:
  - Clickable events that navigate to the linked document/file
  - Red highlight on unsupported causal links (events without evidence)
  - "Causation Vulnerability Alerts" section at the bottom when key links lack documentation

**Q2: Strategic Position** (enhanced)
- Replace the 4 score bars with 5 WSI component bars (Coverage, Evidence, Leverage, Procedural Compliance, Carrier Conduct Risk)
- Each bar clickable to show AI explanation
- Add "Predicted Carrier Next Move" card below the bars with prediction text, confidence badge, and timeline

**Q3: Gap Intelligence Engine** (was Evidence Arsenal)
- Keep existing evidence inventory
- Add per-loss-type required evidence checklist (dynamically generated based on claim.loss_type)
- Add "Missing Evidence Risk Score" with impact severity
- Add "Per Denial Reason Defensive Evidence" section showing what's needed for each likely denial

**Q4: Adaptive Counter-Tactics Engine** (was Battle Playbook)
- Keep matched playbooks
- Add rule-based escalation chains with IF/THEN logic displayed visually
- Add "Generate Ready-to-Send Letter" buttons for matched tactics (e.g., 10-day demand)
- Add carrier behavioral analytics section showing global stats ("This carrier initially denies 62% of roof claims")

### 3C. Bottom Section: Structured Strategic Memo
Replace the narrative Senior PA Opinion with a structured card containing 8 sections:
1. Executive Strategic Summary
2. Strongest Leverage Point
3. Greatest Vulnerability
4. Immediate Recommended Action
5. 30-Day Tactical Plan
6. Escalation Threshold Trigger
7. Settlement Range Estimate
8. Bad Faith Viability Assessment

Add "Export as PDF" button using `html2pdf.js` (already installed).

### 3D. Scenario Simulation Panel
Add a collapsible section between Q4 and the Strategic Memo:
- Show 4 scenario cards: "What if we obtain engineer report?", "What if we send NOI?", "What if we escalate to supervisor?", "What if we file complaint?"
- Each card shows delta changes to WSI, Litigation Readiness, Pressure Index
- Click "Simulate" to run (or show cached results)

---

## Phase 4: New/Modified Files

### New Files
- `src/components/claim-detail/war-room/WSIBreakdown.tsx` -- WSI sub-score breakdown dialog
- `src/components/claim-detail/war-room/LitigationReadiness.tsx` -- Litigation readiness checklist dialog
- `src/components/claim-detail/war-room/PressureIndex.tsx` -- Pressure index display
- `src/components/claim-detail/war-room/PredictedCarrierMove.tsx` -- Carrier prediction card
- `src/components/claim-detail/war-room/GapIntelligenceEngine.tsx` -- Upgraded evidence arsenal
- `src/components/claim-detail/war-room/AdaptiveCounterTactics.tsx` -- Upgraded battle playbook
- `src/components/claim-detail/war-room/StrategicMemo.tsx` -- Structured 8-section memo with PDF export
- `src/components/claim-detail/war-room/ScenarioSimulator.tsx` -- What-if simulation panel
- `src/components/claim-detail/war-room/EvidenceLinkedTimeline.tsx` -- Enhanced timeline with clickable events
- `src/components/claim-detail/war-room/CarrierGlobalIntel.tsx` -- Cross-claim carrier analytics display

### Modified Files
- `src/components/claim-detail/ClaimWarRoom.tsx` -- Major rewrite to compose all new sub-components
- `supabase/functions/darwin-strategic-intelligence/index.ts` -- Add `war_room_2` analysis type with expanded prompt and storage logic

### Database Migration
- 1 migration file adding columns to `claim_strategic_insights` and creating the 3 new tables

---

## Implementation Sequence

1. Database migration (new tables + columns)
2. Backend: expand `darwin-strategic-intelligence` with `war_room_2` analysis type
3. Frontend: build sub-components (WSI, Litigation, Pressure, Predictions, Scenarios, Memo)
4. Frontend: rewrite `ClaimWarRoom.tsx` to compose everything
5. Wire up PDF export for Strategic Memo

---

## Non-Negotiables Addressed

- Every score has a clickable explanation (WSI breakdown, Litigation checklist, Pressure factors)
- Every alert links to data (timeline events link to documents, gaps link to missing evidence)
- Everything is timestamped (all tables have `created_at`, analysis has `last_analyzed_at`)
- Everything is exportable (Strategic Memo has PDF export)
- No hallucinated legal conclusions (AI prompt explicitly forbids case law, frames as strategic suggestions)
- Recommendations framed as strategic suggestions, not legal advice (maintained from existing prompt)
