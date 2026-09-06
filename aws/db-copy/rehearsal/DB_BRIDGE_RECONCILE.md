# DB bridge rehearsal recon — PR #127

**Generated:** 2026-09-06T02:27:41.604Z  
**Production cutover performed:** **NO**  
**Live staging DB `checksops` overwritten:** **NO**  
**Rehearsal database:** `checksops_rehearsal_20260906`

## Safety attestation

| Control | Result |
|---|---|
| Production Supabase modified | **NO** |
| DNS / webhooks / Auth changed | **NO** |
| Moov/CheckAlt/Plaid execution | **NO** |
| PR #125 touched | **NO** |
| PII/row contents/tokens in committed evidence | **NO** |
| Temporary DB + Storage bridges left deployed | **YES** |

## Phase 1 — Bridge validation

| Check | Result |
|---|---|
| HTTP health | PASS |
| mode=read_only | PASS |
| writes/deletes/rpc/rawSql all false | PASS |
| Approved tables | 161 |
| Excluded secret/token tables | email_unsubscribe_tokens, homeowner_bank_link_tokens, homeowner_ledger_tokens, payment_idempotency_keys, spatial_ref_sys, tenant_openai_credentials, user_passkeys, webauthn_challenges |
| Numeric count tables | 180 |
| Current production row sum (approved counted) | 12399 |

## Phase 2 — Production delta vs Sept. 1 baseline

Baseline dump: `Migration/checksops_260901(1).backup` (49100401 bytes, cutoff 2026-09-01T20:36:44.000Z).

| Totals | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| All approved business tables | 0 | 0 | 0 | 11614 |

Tables with any insert/update/delete:

| Table | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| _(none)_ | 0 | 0 | 0 | |

Secret columns were not copied (`[redacted]` omitted; null preserved).

## Preferred auth method (not added)

Production `profiles.preferred_auth_method` is present. AWS login uses Cognito WebAuthn / EMAIL_OTP; the write allowlist ignores this column. It was **not** added to staging schema.

## Phase 3 — Isolated rehearsal restore/sync

Isolated rehearsal was created without overwriting live `checksops`, then migratable business tables were replaced with current production rows from the DB bridge. Secret columns with value `[redacted]` were omitted; generated columns were skipped.

| Step | Result |
|---|---|
| Isolated rehearsal DB | `checksops_rehearsal_20260906` |
| Restore mode | template_clone_then_overlay |
| Overlay apply | PASS (11614 rows upserted; 0 table(s) skipped) |
| Live `checksops` data overwritten | **NO** |
| checksops schema-only DDL | n/a |
| Production Supabase mutated | **NO** |

## Phase 4 — Rehearsal vs live production

| Gate | Result |
|---|---|
| Table row counts | PASS |
| Primary-key sets (fingerprints) | PASS |
| Tenant ownership | PASS |
| Financial aggregates (report-only) | PASS |
| Application-user UUIDs / identity_map | PASS |
| Membership/role relationships | PASS |
| FK integrity | PASS |
| Duplicates / required-null regressions | PASS |

Count mismatches: []  
Financial mismatches: []

## Phase 5 — Storage (already completed; not rerun)

| Item | Result |
|---|---|
| Approved production objects | **1,411** |
| Bytes | **2,565,912,220** |
| Storage migration | **PASS** |
| Staging-only UAT objects | **21** (left in place) |

## Discrepancies & remediation

- TEMPLATE clone copied staging-only identity_accounts onto rehearsal. That table is not production migratable data; live checksops identity_accounts was not modified.

## Repeatable final cutover delta procedure

1. Leave both temporary Lovable bridges deployed.
2. Enter production write-freeze.
3. `health` must remain `mode:read_only` with writes/deletes/rpc/rawSql false.
4. Page `keysOnly` for approved business tables; classify vs the frozen baseline (or vs the prior rehearsal snapshot).
5. Fetch full rows only for reconstruct keys; omit `[redacted]` secret columns.
6. Restore Sept. 1 dump (or last rehearsal snapshot) into a new `checksops_rehearsal_YYYYMMDD`.
7. Apply insert/update/delete delta. Do not overwrite live `checksops`.
8. Reconcile counts, PK fingerprints, financial aggregates (report-only), identity UUID fingerprints, FKs.
9. Storage: inventory delta only; COPY new objects; do not overwrite hash-verified keys.
10. **STOP FOR REVIEW.** Do not switch DNS, auth, webhooks, or provider flags.

## Expected write-freeze window

Timed freeze-free rehearsal 2026-09-06 (production **not** frozen): DB capture+overlay+recon **~6 min**; storage inventory **~8 min**; full hash re-verify **~11 min** with **0** new objects. See `WRITE_FREEZE_TIMING.md`. Customer-facing hold **45 min**; calendar hold **60 min**.

## Rollback

Production Supabase remains system of record until a future cutover PR.

1. Keep DNS/webhooks on Lovable.
2. Drop `checksops_rehearsal_*` only (`DROP DATABASE` that name). Never drop `postgres` or live `checksops`.
3. Leave S3 production copies in place (append-only).
4. Leave staging Cognito/`identity_accounts` on live `checksops`.

## Verdict

**Bridge validation:** **PASS**  
**DB rehearsal recon:** **PASS**  
**Storage:** **PASS**  
**Overall data-migration readiness:** **PASS**  
**GO/NO-GO for data migration readiness:** **GO for data migration readiness**  
**Production cutover:** **STOP FOR REVIEW — production cutover not performed**

STOP FOR REVIEW. Production cutover was not performed.
