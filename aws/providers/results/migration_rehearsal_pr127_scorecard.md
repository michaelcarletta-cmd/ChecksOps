# Migration rehearsal scorecard (PR #127)

| Gate | Result |
|---|---|
| Safety (prod RO, flags OFF, no DNS/webhooks) | PASS |
| Sept-1 baseline artifacts retained | PASS |
| DB bridge fail-closed (`mode:read_only`, writes/deletes/rpc/rawSql false) | PASS |
| Authoritative production delta vs Sept. 1 (632/66/3 I/U/D) | PASS |
| Isolated `checksops_rehearsal_20260905` overlay | PASS |
| `financial_stepup_log` DDL + 2-row overlay | PASS |
| Prod↔rehearsal row counts / critical PK fingerprints | PASS |
| Financial aggregates (report-only) | PASS |
| Identity / membership / FK / required-null | PASS |
| `profiles.preferred_auth_method` | N/A — Cognito replaced; not added |
| Live `checksops` schema-only DDL (empty table) | PASS (0 production rows copied) |
| Live production storage inventory (bridge) | PASS (1,411 objects) |
| Prod → staging S3 COPY + hash recon | PASS (1,411/1,411, 0 missing/failed/mismatched) |
| Staging-only UAT objects preserved | PASS (21 left in place) |
| DNS/webhook/Auth switch | N/A — not performed |

**Storage: PASS**  
**DB: PASS**  
**Overall data-migration readiness: PASS / GO**  
**Production cutover: STOP FOR REVIEW** (not performed)

See `DB_BRIDGE_RECONCILE.md`, `PREFERRED_AUTH_METHOD.md`, `MIGRATION_REHEARSAL_REPORT.md`, and `STORAGE_COPY_RECONCILE.md`.
