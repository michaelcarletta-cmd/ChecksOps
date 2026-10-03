# Mortgage Agent Management + Compensation

Source/staging workstream. **No production writes.**

Phase 2 source is in this folder plus the Tenant Management tab and Class A
compensation handler. Staging SQL uses the dedicated oneshot
`checksops-staging-macomp47-oneshot`. It does not teach SQL 47 to the shared
`checksops-staging-guarded-sql-executor`.

Read `PHASE1_INVESTIGATION.md` and `PHASE2_SQL_DIFF.md` before any apply.
