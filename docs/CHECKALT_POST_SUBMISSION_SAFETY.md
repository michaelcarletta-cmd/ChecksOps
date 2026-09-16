# CheckAlt post-submission safety + tenant auto-deposit

**Workstream:** isolated. Do not change TOTP/session architecture, Cognito mappings, Moov, endorsement gates, or unrelated AWS migration work.

**This document is investigation + design only.** No production deploy. No real CheckAlt submission. No Moov activity. No financial writes.

Production baseline used for the trace:

| Fact | Value |
| --- | --- |
| Check number | `#9562` |
| Check UUID | `623442f0-a408-4db5-85be-14bae231a722` |
| Amount | `$9,984.11` |
| Existing CheckAlt reference | `122678838` |
| Submissions | exactly one real CheckAlt `/fincapture/deposit/process` call |
| Rule | **never resubmit #9562** |

---

## Phase 1 — Trace

### Lifecycle after a successful AWS CheckAlt submit

```text
Ready for Deposit (check_intake_items.status = approved_for_deposit,
                   check_stage = ready_for_deposit)
        │
        │  Deposit click
        │  preflight (no provider HTTP)
        │  TOTP deposit.submit
        │  POST /functions/v1/checkalt-submit-deposit
        ▼
handleProductionCheckAltSubmit
        │
        ├─ load checkalt_deposits for tenant + check
        ├─ pickBlockingDeposit → replay / reconcile if a row already exists
        ├─ else INSERT checkalt_deposits (queued)
        ├─ claim provider_http_attempted_at
        └─ POST /fincapture/deposit/process   ← money movement
                │
                ▼
        persistProviderOutcome
          • writes checkalt_deposits.status
          • writes checkalt_deposits.checkalt_reference
          • does NOT update check_intake_items.status
          • does NOT update check_intake_items.check_stage
          • does NOT set deposited_at
        ▼
check row remains Ready for Deposit
checkalt_deposits row is the only authoritative post-submit record
```

Authoritative money-path files:

- `aws/functions/api/providers/production/checkalt-submit.mjs` — persist outcome on `checkalt_deposits` only
- `aws/functions/api/providers/production/checkalt-idempotency.mjs` — `pickBlockingDeposit`, `shouldReconcileInsteadOfPost`, never a second process POST once a reference / HTTP attempt exists
- `aws/functions/api/providers/production/checkalt-poll.mjs` — locate existing row by `deposit_id` or `checkalt_reference`; `createdDeposit: false`; `requireStepUp: false`
- `aws/functions/api/providers/production/checkalt-preflight.mjs` — if a blocking reference exists, returns `historicalReference: true` and still `readyForVerification: true`
- `aws/functions/api/providers/webhook-apply.mjs` — production CheckAlt webhooks do **not** update `checkalt_deposits` or the check row (sandbox operations only)

Backend idempotency is already fail-closed. Two concurrent Deposit clicks cannot create a second FinCapture process POST when a `checkalt_deposits` row with a reference or HTTP attempt exists. The bug is **UI + lane derivation**, not missing submit idempotency.

### Why #9562 still appears Ready for Deposit

The check was successfully submitted. Reference `122678838` exists. The Command Center still treats the check as depositable because **UI state is derived from `check_intake_items.status` / `check_stage`**, which submit never changes.

Four independent surfaces all stay “Ready”:

#### 1. Detail badge and recommendation

`CheckCommandCenter` renders `prettifyStatus(check.status)`. `approved_for_deposit` always pretty-prints as **Ready for Deposit**. Refresh, logout/login, another browser, or another authorized user re-reads the same RDS check row and sees the same label.

```3933:3934:src/pages/CheckCommandCenter.tsx
            <Badge className={statusColors[check.status] ?? ""}>
              {prettifyStatus(check.status)}
```

#### 2. Deposit button does not consult an authoritative CheckAlt row

The one-click Deposit CTA is shown when endorsements look complete and the check is not `deposited`:

```4294:4312:src/pages/CheckCommandCenter.tsx
                        {allEndorsementsComplete && !isDepositBlocked && check.check_stage !== "deposited" && check.status !== "deposited" && (
                          checkAltEnabled ? (
                            <>
                            <CheckAltImageComplianceCard
                              checkId={check.id}
                              frontImagePath={check.front_image_path}
                              backImageDepositPath={check.back_image_deposit_path}
                            />
                            <Button
                              size="sm"
                              variant="success"
                              className="w-full mt-1"
                              disabled={depositingWithCheckAlt}
                              onClick={handleDepositWithCheckAlt}
                            >
```

`allEndorsementsComplete` is forced true whenever `status === "approved_for_deposit"` (`manuallyReadyForDeposit`). `checkalt_deposits` is used only to detect `rejected` / `returned` / `error` so the button can say **Resubmit Deposit**. A `pending_approval` / `submitted` row with reference `122678838` does **not** hide Deposit.

There is a second unsafe control on the same panel: **Mark as Deposited** still appears for any `approved_for_deposit` check, including one that already has a live CheckAlt reference.

#### 3. Ready lane only special-cases `pending_approval`

```836:844:src/pages/CheckCommandCenter.tsx
  const readyForDeposit = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);
      const stage = c.check_stage;
      if (stage === "deposited" || getCheckAltStatus(c) === "pending_approval") return false;
      return (s === "approved_for_deposit" ||
        (c.deposit_recommendation === "ready_for_deposit" && s !== "deposited")) &&
        matchesSearch(c);
    },
  );
```

`getCheckAltStatus` is the latest nested `checkalt_deposits.status`. It is **not** “has a reference”. If the stored status is `submitted`, `processing`, `approved`, `cleared`, `submitting`, or the embed is empty, #9562 stays in Ready.

Submit status mapping is also narrower than CheckAlt’s real envelopes:

```382:388:aws/functions/api/providers/production/checkalt-submit.mjs
    const apiStatus = Number(json?.status ?? json?.statusCode);
    const isRejected = apiStatus === 120 || /^\s*rejected/i.test(String(json?.status ?? ''));
    const status = !resp.ok
      ? 'error'
      : isRejected
        ? 'rejected'
        : (apiStatus === 40 ? 'pending_approval' : 'submitted');
```

Numeric `40` becomes `pending_approval`. A string such as `"Pending Approval"` is `Number(...) === NaN`, so it is stored as **`submitted`**. That alone keeps the check in the Ready lane even when the embed works.

#### 4. Queries omit `checkalt_reference`

Queue, deposited, shared, prefetch, and detail selects load:

```text
checkalt_deposits(id, status, submitted_at, approved_at, updated_at[, last_status_payload])
```

They never select `checkalt_reference`, `provider_http_attempted_at`, `failure_class`, or `status_unresolved`. `CheckAltDepositSummary` in `src/features/check-command/types.ts` has no reference field. The UI cannot render `CheckAlt: Pending Approval — Ref #122678838` from authoritative RDS even when the row is joined.

`CheckAltDepositSummary` also means session/localStorage is not the source of the Deposit button — the source is the **wrong RDS columns**. That is still a derivation bug.

### Poll Now (current vs required)

| Requirement | Current code | Verdict |
| --- | --- | --- |
| Manager → Poll Now must not require TOTP | UI does not call `useFinancialGuard` / `requireStepUp`. Backend `handleProductionCheckAltPoll` uses `requireStepUp: false`. | Met |
| Status reconciliation only | Poll calls `/fincapture/deposit/item` then `/fincapture/deposit/history`. Never `/fincapture/deposit/process`. | Met |
| Never create a deposit | `loadExistingProductionDeposit` + `createdDeposit: false`. Missing locator → 400, not INSERT. | Met |
| Use existing deposit/reference records | Production poll **requires** `deposit_id` or `checkalt_reference`. | Broken at the UI contract |
| Usable from Manager | `PendingApprovalDeposits` and Settings both `invokeAwsCheckAltProviderFunction("checkalt-poll-status", { body: {} })`. | Empty body → `deposit_locator_required` |
| Toast shape | UI expects `{ polled, updated, errors }` (UAT/legacy batch). Production returns a single-row reconcile object. | Contract mismatch |

UAT parity `pollStatus` in `aws/functions/api/providers/parity/checkalt-functions.mjs` already batches existing sandbox rows and returns `{ polled, updated, errors }`. Production was intentionally tightened to a locator so poll cannot invent a deposit — the Manager button was not updated to match.

Approve/Reject on the same Manager card still correctly requires financial step-up (`deposit.approve`). That must stay. Poll must not inherit it.

### Uncertain provider result

Already fail-closed on the submit path:

- HTTP attempted + no safe replay → `reconciliation_required`, `uncertain: true`, no second process POST
- RDS update after provider accept → status stays `submitting`, recovery is poll by `deposit_id`, never retry process
- Poll without a unique reference match → `reconciliation_required`, no INSERT

The UI does **not** honor this. An uncertain / `submitting` / `error` row with `provider_http_attempted_at` still presents Deposit because the check row is still Ready.

### Ready-tab badge

`get_check_stage_totals` buckets `status = approved_for_deposit` as `ready` with **no** `checkalt_deposits` join. With no search filter, the Ready card prefers this RPC over the in-memory filtered list, so the badge can stay inflated after the list is corrected.

---

## Phase 1 — Proposed repair (smallest)

Do **not** flip `#9562` (or any submitted check) to `deposited` as the first fix.

Advancing `check_intake_items` to `deposited` on submit would touch wallet-funding / stage-advance triggers, `deposited_at`, partner mirrors, and “Mark as Deposited” semantics. That is larger than the bug and is not required for safety. Backend idempotency already prevents a second process POST.

**Derive Command Center Deposit / lane / label from authoritative `checkalt_deposits`.** Leave the check row at Ready until a later, explicit cleared→deposited design (out of scope).

### Authoritative UI helper (pure)

Add to `src/features/check-command/status.ts` (unit-testable, no React):

```ts
POST_SUBMISSION_CHECKALT = {
  pending_approval, submitted, approved, processing,
  deposited, cleared, settled, submitting
}

RESUBMIT_CHECKALT = { rejected, returned, error }  // only when NO checkalt_reference
                                                   // and NO provider_http_attempted

hasAuthoritativeCheckAltSubmission(check):
  latest deposit has checkalt_reference
  OR status in POST_SUBMISSION_CHECKALT
  OR provider_http_attempted_at / failure_class in {provider_timeout, db_after_provider}
  OR status_unresolved === true
  OR last_status_payload.uncertain / reconciliation_required

normalDepositAllowed(check):
  check is Ready AND NOT hasAuthoritativeCheckAltSubmission(check)
  AND status not in RESUBMIT-blocked-with-reference

formatCheckAltLifecycleLabel(deposit):
  "CheckAlt: Pending Approval — Ref #122678838"
```

Fail closed: if a deposit row exists but status/reference is ambiguous, treat as authoritative. **Never restore Deposit.**

Rejected / returned / error **with** a reference: hide normal Deposit; show status + reference; do not offer a one-click resubmit that can POST process again. Existing “Resubmit” copy is unsafe for #9562-class rows.

Rejected / returned / error **without** a reference **and** without `provider_http_attempted_at`: the current resubmit path may remain (true failed-before-provider cases).

### Deposit button

In the detail panel:

- If `normalDepositAllowed` → show **Deposit** (unchanged preflight + TOTP + submit).
- If `hasAuthoritativeCheckAltSubmission` → hide Deposit **and** hide **Mark as Deposited**.
- Show `formatCheckAltLifecycleLabel` from the latest deposit (status + reference).
- If uncertain / `status_unresolved` → show “Reconciliation required” and point at Manager Poll Now. Do not show Deposit.

Same derivation on refresh, new session, other browser, other authorized user: they all read RDS `checkalt_deposits`.

### Ready / Deposited lanes

- Ready: exclude `hasAuthoritativeCheckAltSubmission`.
- Deposited (or keep the existing pending-approval merge): include submitted / pending_approval / approved / processing / cleared / submitting-uncertain so the check does not vanish.
- Tab label already special-cases `pending_approval` → “Pending Approval”. Extend that helper to use `formatCheckAltLifecycleLabel`.

### Select list

Add to every Command Center `checkalt_deposits(...)` embed:

`id, status, checkalt_reference, submitted_at, approved_at, updated_at, last_status_payload, status_unresolved`

Extend `CheckAltDepositSummary` accordingly. No session/localStorage write.

### Badge RPC (optional in the same PR, recommended)

`get_check_stage_totals` should exclude checks that have an authoritative `checkalt_deposits` row from `ready`, and count them with `deposited` (or a `pending_approval` bucket if we add one). This is a **function replace**, not a table migration. Without it, the Ready card badge stays wrong after the list is fixed.

### Poll Now

Keep `requireStepUp: false`. Do not add TOTP.

Extend `handleProductionCheckAltPoll` with a **manager batch** that the existing empty-body UI already expects:

1. If `deposit_id` or `checkalt_reference` is present → current single-row reconcile (unchanged).
2. If both are absent → load existing `checkalt_deposits` the caller may access (tenant membership), **only rows that already have `id` (always) and prefer those with `checkalt_reference` or `provider_http_attempted_at`**. For each row call `reconcileProductionCheckAltDeposit`. Never INSERT. Never process POST. Cap the batch (e.g. 50, matching the pending-approval query).
3. Return `{ polled, updated, errors, createdDeposit: false, liveProviderCalled, results[] }`.

Manager UI: keep the empty-body call **or** pass the visible pending rows’ `deposit_id`s. Either is safe if batch mode exists. Prefer passing explicit `deposit_ids` from the pending list so Poll Now cannot wander into unrelated historical rows.

Uncertain poll result: persist `status_unresolved` / do not invent status; UI fail-closed as above.

### #9562 specific correction

No production UPDATE of the check or deposit is required for the UI fix **if** the existing row is:

```text
check_intake_items.id = 623442f0-a408-4db5-85be-14bae231a722
checkalt_deposits.check_intake_item_id = that UUID
checkalt_deposits.checkalt_reference = '122678838'
amount ≈ 9984.11
```

After the helper ships, Deposit disappears and the label becomes `CheckAlt: <mapped status> — Ref #122678838` for every authorized user.

**Read-only verification (human, not this agent):**

```sql
SELECT c.id, c.check_number, c.amount, c.status, c.check_stage,
       d.id AS deposit_id, d.status AS ca_status, d.checkalt_reference,
       d.provider_http_attempted_at, d.failure_class, d.submitted_at
  FROM public.check_intake_items c
  LEFT JOIN public.checkalt_deposits d
    ON d.check_intake_item_id = c.id
 WHERE c.id = '623442f0-a408-4db5-85be-14bae231a722'
    OR c.check_number = '9562';
```

A production data repair is required **only if** that join is empty or the reference sits on a different `check_intake_item_id`. Any such repair is a one-row `check_intake_item_id` attach, never a second process POST, and must be human-approved separately.

---

## Affected files / tables

### Phase 1 implementation (next turn, after this design is accepted)

| Area | Files | Change |
| --- | --- | --- |
| Pure helpers | `src/features/check-command/status.ts`, `types.ts` | Authoritative CheckAlt derivation + label |
| Command Center | `src/pages/CheckCommandCenter.tsx` | Embeds, Ready/Deposited filters, hide Deposit / Mark as Deposited, show status+ref |
| Poll UI | `src/components/settings/CheckAltSettings.tsx` | Keep no-TOTP; optionally pass `deposit_ids`; consume batch counts |
| Poll API | `aws/functions/api/providers/production/checkalt-poll.mjs` | Empty-body / `deposit_ids` batch; never INSERT; never process |
| Tests | `aws/tests/api-checkalt-production.test.mjs`, new `aws/tests/checkalt-post-submission-ui.test.mjs` (or frontend equivalent) | See Tests |
| Badge RPC | latest `get_check_stage_totals` definition (Supabase migration **or** AWS SQL apply if that function is managed there) | Exclude authoritative CheckAlt rows from `ready` |
| Preflight (optional, small) | `checkalt-preflight.mjs` | When `historicalReference`, return `readyForVerification: false` so even a stale Deposit click cannot reach TOTP |

### Tables

| Table | Phase 1 write? |
| --- | --- |
| `checkalt_deposits` | **No new columns.** Poll already UPDATEs status / `last_polled_at` / `last_status_payload` / `status_unresolved`. |
| `check_intake_items` | **No write** for #9562. Do not set `deposited` in this workstream. |
| `financial_stepup_log` | Unchanged. Poll must not insert step-up rows. |
| `checkalt_config` / `checkalt_tenant_accounts` | Unchanged in Phase 1. |

### Explicitly out of scope

Cognito mapping, TOTP enrollment, Moov, endorsement fingerprint logic, CheckAlt image compliance algorithm, AWS migration / SQL 65 apply, any second submit of #9562.

---

## Tests (Phase 1)

No live CheckAlt. No production RDS writes.

### New pure UI tests

Fixture: check `#9562` shape — `status=approved_for_deposit`, `check_stage=ready_for_deposit`, nested deposit `{ status: 'pending_approval', checkalt_reference: '122678838', amount: 9984.11 }`.

| Case | Expected |
| --- | --- |
| Authoritative reference + pending_approval | `normalDepositAllowed=false`, Ready lane exclude, label contains `Pending Approval` and `122678838` |
| Same after “reload” (re-derive from fixture, no session) | Identical |
| `submitted` / `cleared` / `submitting` + reference | Deposit hidden |
| `submitting` + `provider_http_attempted_at`, no reference | Deposit hidden, reconciliation copy, fail closed |
| `error` + `failure_class=db_after_provider` + reference | Deposit hidden |
| No deposit row, Ready check | Deposit allowed |
| `rejected` + reference | No normal Deposit, no process-retry CTA |
| `rejected` without reference and without HTTP attempt | Existing resubmit may show |
| Two users / two browsers | Same helper input → same output (no localStorage) |

### Existing backend tests to extend

`aws/tests/api-checkalt-production.test.mjs`:

| Case | Expected |
| --- | --- |
| Poll `{ body: {} }` as tenant manager | Batch existing locatable rows; `createdDeposit=false`; `processPosts=0`; returns `polled/updated/errors` |
| Poll `{ deposit_id }` | Current single-row path |
| Poll fabricated reference | `deposit_not_found`, no INSERT |
| Poll does not require step-up | Succeeds with no `financial_stepup_log` row |
| Submit with existing `122678838` | Replay / reconcile, `liveProviderCalled=false` |

Do **not** add a test that posts `/fincapture/deposit/process` for #9562.

### Manual verification (after implement, still no prod submit)

- Open a **staging** Ready check with a fixture deposit row; confirm Deposit gone and label correct.
- Poll Now on Manager pending card: no TOTP dialog; toast shows counts; no new `checkalt_deposits` row.
- Confirm production #9562 is **not** submitted again.

---

## Production migration required?

| Item | Required for Phase 1? |
| --- | --- |
| New `checkalt_deposits` columns | **No** |
| Rewrite #9562 check to `deposited` | **No** (and should not) |
| SQL 65 / financial writer | **No** — already the live submit path |
| `get_check_stage_totals` replace | **Yes, if we want the Ready badge correct** — function body only, no table change |
| One-row FK attach for `122678838` | **Only if** read-only verify shows a broken `check_intake_item_id`. Human-approved, not part of the default PR |
| Backfill historical Ready checks | **No** |

---

## Phase 2 — Tenant auto-deposit (design only; do not implement until Phase 1 is validated)

Existing `checkalt_config.auto_approve_*` and `checkalt_tenant_accounts.auto_approve_*` mean **auto-approve a CheckAlt deposit that is already sitting at status 40**. They are **not** auto-submit. Do not reuse those columns.

### Settings

Store on `checkalt_tenant_accounts` (tenant depositor row already exists) **or** a sibling `checkalt_tenant_deposit_settings` (1:1 on `tenant_id`) if we want to avoid mixing depositor SSO fields with policy:

| Column | Type | Default |
| --- | --- | --- |
| `auto_deposit_enabled` | boolean not null | `false` |
| `auto_deposit_max_cents` | bigint null | `null` (required when enabled) |
| `auto_deposit_updated_at` | timestamptz | null |
| `auto_deposit_updated_by` | uuid | null |

Default **OFF**. Enabling or changing the threshold requires:

- tenant **owner or admin** only (not manager/staff; stricter than money-movement manager role)
- financial step-up with a **new** action key `checkalt.auto_deposit.configure` (tenant-bound, not check-bound)
- server ignores browser tenant/amount; loads the caller’s membership + current setting

This adds an action key and a settings writer. It does **not** change Cognito, TOTP enrollment, or session architecture.

### When auto-deposit may run

Only after the check **legitimately reaches** Ready for Deposit (`approved_for_deposit` / `ready_for_deposit`) **and** every existing CheckAlt gate passes:

- endorsements / fingerprint / official `.checkalt.jpg` images (existing `evaluateProductionDepositEligibility`)
- tenant depositor registered and enabled
- `pickBlockingDeposit` finds no existing reference / HTTP attempt
- amount cents ≤ `auto_deposit_max_cents`
- setting is ON **as of this decision**

Amount above threshold → remain Ready for **manual** Deposit (Phase 1 UI).

### Reuse the proven submit path

Call `handleProductionCheckAltSubmit` (or extract its post-authz core) with an authority record:

```text
authority = tenant_auto_deposit_config
  • setting ON
  • threshold in cents
  • admin step-up already recorded on the setting change
  • requireStepUp for deposit.submit = false
```

Do **not** create a parallel FinCapture client. Do **not** skip preflight/eligibility/idempotency.

Auto-deposit itself has no interactive TOTP. Authorization is the previously step-up-protected setting.

### No retroactive sweep

Turning the feature ON or raising the threshold must **not** submit checks already sitting in Ready.

Implementation rule: evaluate only on the **transition event** into Ready (review decision / endorsement-complete / `mark_ready_for_deposit`) whose `updated_at` is **after** `auto_deposit_updated_at` when the setting became enabled or the threshold last rose enough to include this amount.

A later controlled backfill is a separate, audited job. Out of scope.

### Audit every decision

New table `checkalt_auto_deposit_decisions` (append-only):

- `tenant_id`, `check_intake_item_id`, `amount_cents`
- `auto_deposit_enabled`, `auto_deposit_max_cents` (snapshot)
- `eligible` boolean, `reason` (`below_threshold` / `above_threshold` / `setting_off` / `already_has_reference` / `gates_failed` / `preexisting_ready` / `uncertain_blocked`)
- `created_at`
- `deposit_id`, `checkalt_reference`, `submit_result` when a submit was attempted
- `actor` = `system:auto_deposit`

Never automatically retry an uncertain provider result. Record `uncertain_blocked` and stop. Human Poll Now / reconcile only.

### Phase 2 files (later)

- SQL: columns + `checkalt_auto_deposit_decisions` + RLS (tenant admin read, server write under financial GUCs)
- Settings UI: tenant admin panel, TOTP on save
- Hook from existing Ready transition only
- Tests: OFF default; above threshold no submit; preexisting Ready skipped; existing reference blocks; uncertain not retried; submit path is the same module

---

## Implementation order (after this design is accepted)

1. Phase 1 helpers + Command Center Deposit/lane/label + select list (no deploy of money path).
2. Phase 1 Poll Now batch contract (no TOTP, no process POST).
3. Phase 1 tests. Staging-only UI verify.
4. Optional `get_check_stage_totals` replace.
5. Human read-only verify of #9562 join. Data repair only if FK is broken.
6. **Stop.** Phase 2 waits for Phase 1 validation.
7. No production deploy from this design turn.
