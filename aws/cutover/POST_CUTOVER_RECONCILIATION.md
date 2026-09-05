# Reconciliation immediately after cutover (plan only)

**Do not run a production delta or production financial transactions from this PR.**

Report-only tools already exist:

- `aws/rls/sql/28_financial_aggregates.sql`
- `POST /financial/reconcile` — `auto_corrected` constrained false; does not update money tables
- PR #127 rehearsal recon gates (counts, PK fingerprints, FKs, identity, `financial_stepup_log`)

## T0 snapshot (before write-freeze lifts)

Capture (no PII in Git):

1. Row counts for every approved business table (DB bridge `counts`).
2. Financial aggregates (report-only SQL).
3. Storage object count + bytes (bridge inventory).
4. Identity mapped-user count (not emails).
5. Provider webhook high-water event ids (ids only).

## Immediately after T6 (DNS on AWS, flags still OFF)

Within the first 15 minutes:

1. `GET /health` 200, `productionSupabaseChanged=false`, `environment` is the production API env name (not accidentally `staging`).
2. `GET /ops/readiness` holds.ok; every execution flag false.
3. `GET /db-health` connected; application role `checksops`; not `checksops_admin`.
4. Repeat financial aggregates vs T0 — unexplained drift is a tripwire → `ROLLBACK.md` point B.
5. Storage: AWS S3 count/bytes vs final bridge inventory; missing keys → do not delete production; re-COPY from bridge if still deployed.
6. Identity: smoke EMAIL_OTP for one CheckOps, one WhiteLabel, one MortgageOps operator (no money).
7. Confirm production Moov/CheckAlt webhooks still on Supabase unless T5 dual-run was explicitly added.

## After T7 (flags ON — separate approval)

1. `POST /financial/reconcile` report-only; `autoCorrected=false`.
2. Compare provider dashboard object ids to internal operations (no unsigned URLs / no secrets in logs).
3. Finding types that force halt: `amount_mismatch`, `duplicate_provider_transaction`, `unknown_provider_transaction`, sandbox IDs on production rows.

Do not enable auto-correct in the cutover window.
