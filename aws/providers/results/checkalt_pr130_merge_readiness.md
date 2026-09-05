# PR #130 merge readiness — final code/safety review

**Date:** 2026-09-05  
**Reviewer:** Cloud agent (read-only + tests; no merge; no CheckAlt submit)  
**PR:** [#130](https://github.com/michaelcarletta-cmd/ChecksOps/pull/130) `cursor/checkalt-lovable-parity-3a4a` → `main`  
**Related:** [#125](https://github.com/michaelcarletta-cmd/ChecksOps/pull/125) CheckAlt UAT certification evidence  

## MERGE #130: **YES**

Safe to merge into `main` **with all production CheckAlt / provider / financial execution flags remaining OFF**, after human acknowledgement of the separate UAT synthetic-VOID limitation. **Do not merge in this turn — STOP FOR REVIEW.**

Synthetic CheckAlt UAT VOID HTTP 500 is a **certification limitation**, not a merge blocker for Architecture A.

---

## Scope of #130

| Path | Role |
|---|---|
| `aws/functions/api/providers/parity/checkalt-client.mjs` | Lovable-identical `/fincapture/deposit/process` body builder |
| `aws/functions/api/providers/parity/checkalt-functions.mjs` | Submit: download prepared storage → Base64 only; ignore client images; sandbox RLS GUC |
| `aws/functions/api/providers/parity/checkalt-image.mjs` | Browser path decision + allowlist (`.deposit2.jpg` siblings) |
| `aws/functions/api/storage-write-auth.mjs` | Allow browser `.deposit2.jpg` writes for Architecture A |
| `aws/functions/api/storage.mjs` | Read auth includes endorsed + `.deposit2.jpg` siblings |
| Tests (4 files) | Gates, parity, storage, Lovable prep parity |

**Not changed:** `aws/template.yaml`, Supabase/Lovable production functions, frontend, financial activation SQL, production flag defaults.

---

## Safety checklist

| Requirement | Result | Evidence |
|---|---|---|
| No production activation | **PASS** | Diff does not touch `aws/template.yaml`. Flags remain `AWS_CHECKALT_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`, `AWS_MOOV_ENABLED=false`. CI asserts these. |
| No customer/historical resubmit behavior | **PASS** | No code path resubmits historical deposits. Submit operates on a caller-selected check id with prepared paths; forensic/UAT docs forbid historical resubmit. |
| No tenant-isolation regression | **PASS** (with note) | Submit enforces `check.tenant_id === ctx.tenantId` (non-admin). UAT accounts use `aws_provider_sandbox_*` with `request.provider_sandbox` GUC; production `checkalt_tenant_accounts` not written (`production_table_written: false`, `production_execution: false`). |
| No unsafe storage access | **PASS** (with note) | Prepared paths allowlisted to this check’s front/back/deposit columns + `.deposit2.jpg` siblings; cross-check path → `prepared_path_denied`. Storage read/write expanded only for those siblings. |
| No client-controlled image injection | **PASS** | Client `frontImage`/`rearImage` ignored; tests assert injected bytes discarded; Base64 is of stored prepared objects only. |
| No regression to Lovable production flow | **PASS** | No Supabase/Lovable/src changes. Architecture A **matches** Lovable: browser prepare → store → backend Base64 only. Offline 8/8 incl. known-good `120846345`. |
| Do not “fix” synthetic VOID via Architecture A changes | **PASS** | Review made **no code changes**. Synthetic 500 treated as separate UAT limitation. |

### Notes (non-blocking)

1. **Staging sandbox flag:** `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true` is already on staging template (pre-existing on `main`). That enables **sandbox/UAT** provider calls only; production CheckAlt/provider/financial flags stay false. #130 does not widen this.
2. **Storage write-by-image-path:** New `.deposit2.jpg` write strategy relies on the same DB/RLS trust model as existing check-UUID writes (lookup without an extra `hasTenantMembership` call). Optional defense-in-depth: add explicit membership check after path lookup in a follow-up — not required to land Architecture A.
3. **PR is still draft:** Mark ready-for-review before human merge.

---

## Tests & CI

| Suite | Result |
|---|---|
| GitHub **AWS Migration CI** on latest #130 head | **pass** (249/249 in CI log; flag asserts green; run `33982421982`) |
| Local PR130-relevant: gates + parity + providers + storage + lovable-prep | **63/63 pass** |
| Local full `test:aws-api` | 247/249 — **2 failures unrelated to #130** (also fail on `main` here): sandbox `/status` env assert; passkey `.ts` loader without bun transpile. CI (bun) passes both. |
| Template flag greps (CI equivalent) | **PASS** |

---

## Known-good forensic tie-in

Portal Accepted `120846345` ↔ deposit `e630c449-48b3-4b92-8585-8a24421c600c` / fp `ed9b7609164ba6f0` (**first of #130 offline 8/8**). Architecture A byte-identical front/rear. Process keys match Lovable. **#130 reproduces the known-good path.**

---

## What should happen to PR #125 after #130 merges

| Option | Recommendation |
|---|---|
| Keep #125 open as UAT certification evidence | **Yes** — docs, escalation packages, synthetic VOID matrix, known-good forensic, STOP record |
| Rebase #125 onto `main` after #130 | **Yes, when convenient** — drop any stale “encoder gap” narrative; keep certification artifacts current |
| Supersede / close #125 | **No** — #125 still owns the **open UAT certification** item (synthetic VOID 500 / vendor policy). #130 supersedes only the **Architecture A implementation** gap |
| Merge #125 with #130 | **No** — do not merge #125 until product accepts UAT limitation or CheckAlt provides synthetic acceptance guidance |

**Summary:** Merge **#130** (Architecture A). Keep **#125** open as the UAT certification / STOP evidence PR; rebase later; do not treat #125 as superseded for certification.

---

## Explicit STOP

- **Do not merge #125 or #130 in this agent turn**
- **Do not make another CheckAlt submission**
- Production provider/financial flags remain **OFF**
- No speculative IQA / Architecture A pipeline changes for synthetic VOID

## Recommendation line

**MERGE #130: YES** — Architecture A is correct and safety-gated; CI green; known-good path reproduced; synthetic VOID UAT remains a separate #125 certification limitation.
