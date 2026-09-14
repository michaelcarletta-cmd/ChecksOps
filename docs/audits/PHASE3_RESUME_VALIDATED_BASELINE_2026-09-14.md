# Phase 3 Functional Audit — inventory reconciliation (STOP)

**Date:** 2026-09-14  
**Workstream:** Functional Audit  
**This turn:** reconcile A7-024 FAIL and C1C blocker classification. **No further Phase 3 testing. No deploy. No Cognito mutation. No Phase 4.**

Authoritative pin (unchanged, not re-tested this reconciliation):

- Lambda CodeSha256 `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=`
- SPA `index.html` ETag `113dfd26211290d0be78377d4b8e1ee2`
- SQL `29 → 52 → 39 → 69 → 71 → 72 → 73`; SQL 30 unapplied

---

## 1. Authoritative inventory counts

| Metric | Evidence-supported now |
|---|---:|
| Discovered | 1,421 |
| N/A | 285 |
| Live/non-N/A | 1,136 |
| PASS | **713** |
| FAIL | **2** |
| INTERNAL BLOCKED | **247** |
| EXTERNAL BLOCKED | **173** |
| AWAITING_INTEGRATION_DEPLOYMENT | **1** |
| Operational PASS | **713 / 1,136 = 62.8%** |

Independently valid change from the 2026-09-14 resume (kept): `A5-203` BLOCKED → `AWAITING_INTEGRATION_DEPLOYMENT`.

## 2. Complete FAIL list

| ID | Control | Evidence |
|---|---|---|
| `A8-035` | Sign in with password | Freedom admin `identity_not_linked` (out of scope; unchanged) |
| `A7-024` | Sign Direction to Pay | Live false-success on this SHA; see below |

## 3. Complete AWAITING_INTEGRATION_DEPLOYMENT list

| ID | Control | Why |
|---|---|---|
| `A5-203` | Save All Categories | Live SPA `writes_disabled` + missing Lambda `claim_settlements` executor. Git-fixed in PR **#309**. **Do not deploy yet.** |

`A7-024` is **FAIL**, not AWAITING. PR #304 is an undeployed Git repair and does not convert FAIL without a later physical PASS after deploy.

`A5-201` / `A5-202` / `A5-204` remain BLOCKED (session / credential handoff), not AWAITING. Tabs, Cancel, and inputs do not require the settlement write deploy to be physically exercised.

## 4. How A7-024 disappeared from FAIL

Last **physical** result on this live SHA is FAIL:

- Commit `98e2562e69b226882dcc0b251d3838fe025e033f` (`cursor/phase3-live-pin-resume-3bce`)
- Report `docs/audits/PHASE3_FUNCTIONAL_AUDIT_RESUME_2026-09-13.md`
- Artifact `/opt/cursor/artifacts/phase3_a7_024_dtp_reprove.json`
- POST `sign_dtp` HTTP 200 `signed=true`; follow-up GET still `Pat Homeowner` / `2026-09-13T11:13:05.404Z`; `falseSuccess=true`

That FAIL never landed on inventory #291.

Sequence:

1. `b941ba9b4` (`cursor/phase2-integration-inventory-3bce`, PR #291) converted A7-024 AWAITING → **PASS** after the Phase 2 SQL 42 / PR #288 overlay. Message: `docs(audit): convert A7-024 and A7-027 from AWAITING to PASS`. That PASS is tied to a **prior** overlay, not to a re-proof on the current pin after the false-success.
2. `98e2562e6` on a **parallel** branch (`cursor/phase3-live-pin-resume-3bce`) re-proved FAIL against SHA `OSiyHTQq…` and moved PASS 714 → 713 / FAIL 1 → 2. That branch was not merged into #291.
3. The 2026-09-14 resume prompt started from the #291 counts (PASS 714 / FAIL 1) and this workstream checked out that HEAD. Commit `c5c3bf902` then **preserved** A7-024 as PASS and wrote that Sign Direction to Pay was not clicked, so it “remains PASS from prior port.” That was inventory error: no subsequent physical PASS exists on this SHA, and this turn did not click Sign.

No Integration repair for A7-024 has been deployed since `98e2562e6`. Live Git repair PR #304 is still undeployed.

## 5. C1C blocker classification

C1C authentication is **restored and verified** for the existing user `payments@condition1commercial.com`:

- Cognito sub `e418f488-4011-7046-5a09-3f8b51140899` (unchanged)
- Application user `fd857564-9534-4b0f-95ac-624ed1273725`
- Tenant `4f172140-f57a-4744-8050-95f4f07b13b4`
- Role `admin`
- `/auth/login` HTTP 200
- `/identity/me` HTTP 200
- Mapping intact

No replacement user. No tenant/application data change. Cognito was **not** mutated this reconciliation.

“No mapped C1C plaintext this turn” means **this audit environment does not possess the authorized staging credential**. It is **not** an unresolved C1C identity defect.

A5-201 / A5-202 / A5-204 blocker is now `secure_credential_handoff` (INTERNAL BLOCKED / `BLOCKED_FIXTURE`). A5-203 secondary blocker is the same handoff; primary remains missing write-path deploy.

## 6. PR #309 after reconciliation

**Still a valid Integration handoff. Do not deploy yet.**

#309 only remediates `claim_settlements` persist (`A5-203`). It does not repair A7-024. It is independent of the restored FAIL. After a later authorized deploy, Functional Audit still needs the C1C credential handoff to click Save on the retained fixture.

## 7. Nothing deployed / applied / modified

This reconciliation is Git/docs only on `cursor/phase3-resume-validated-baseline-3bce`.

- Lambda / SPA / CloudFront / SQL / RLS / GRANTs / env: **not modified**
- Cognito: **not mutated**
- Production / production-prep: **untouched**
- Provider / CheckAlt / Moov: **not enabled**
- PR #309: **not deployed**
- SQL 40 / SQL 30 / SQL 23: **not applied / not run**
- Phase 4: **not started**
- No further Phase 3 physical testing this turn

---

## Preserved (still valid) 2026-09-14 findings

- Live SPA/API cannot persist `claim_settlements` → `A5-203` AWAITING (#309)
- Portal `sign_document` / `submit_mortgage_intake` / `complete_action` still 501 → A7-028–041 BLOCKED_MISSING_FEATURE
- Pay-setup invalid tokens physically confirmed; found-token path fail-closed 409 while Moov is off
- Retained C1C ledger fixture unchanged
- CCC persist / status-gated / CRC / settled-payment still unexecuted (now: wait for credential handoff, not identity repair)

**STOP.**
