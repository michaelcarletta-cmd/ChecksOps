# Migration rehearsal scorecard (PR #127)

| Gate | Result |
|---|---|
| Safety (prod RO, flags OFF, no DNS/webhooks) | PASS |
| Sept-1 baseline artifacts retained | PASS |
| Staging inventory oneshot (sanitized) | PASS |
| Financial aggregates staging == Sept-1 | PASS |
| FK orphan spot-checks | PASS |
| Staging vs Sept-1 row-count explanation | PARTIAL |
| Live production storage inventory (bridge) | PASS (1,411 objects) |
| Prod → staging S3 COPY + hash recon | PASS (1,411/1,411, 0 missing/failed/mismatched) |
| Staging-only UAT objects preserved | PASS (21 left in place) |
| Fresh production DB dump in S3 | FAIL (blocked) |
| Isolated restore rehearsal from fresh dump | FAIL (blocked) |
| Prod↔AWS database reconciliation | FAIL (blocked) |
| Cutover delta procedure documented | PASS |
| Timed cutover dry-run | FAIL (blocked) |

**Storage: PASS**  
**Overall data-migration readiness: PARTIAL / NO-GO for cutover** (DB dump still blocked)

See `MIGRATION_REHEARSAL_REPORT.md` and `STORAGE_COPY_RECONCILE.md`.
