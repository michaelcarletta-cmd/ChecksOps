# Migration rehearsal scorecard (PR #127)

| Gate | Result |
|---|---|
| Safety (prod RO, flags OFF, no DNS/webhooks) | PASS |
| Sept-1 baseline artifacts retained | PASS |
| Staging inventory oneshot (sanitized) | PASS |
| Financial aggregates staging == Sept-1 | PASS |
| FK orphan spot-checks | PASS |
| Staging vs Sept-1 row-count explanation | PARTIAL |
| Fresh production dump in S3 | FAIL (blocked) |
| Isolated restore rehearsal from fresh dump | FAIL (blocked) |
| Prod↔AWS full reconciliation | FAIL (blocked) |
| Cutover delta procedure documented | PASS |
| Timed cutover dry-run | FAIL (blocked) |

**Overall: PARTIAL**  
**Recommendation: NO-GO for data migration readiness / cutover**

See `MIGRATION_REHEARSAL_REPORT.md`.
