# T0 selection and PRE-T0 checkpoint

**STOP FOR FINAL AUTHORIZATION.** This document selects T0 and records the read-only preflight. It does **not** enable write-freeze.

| Field | Value |
|---|---|
| Selected T0 | **2026-09-06 20:00:00 UTC** (16:00 America/New_York) |
| Window | Controlled same-day cutover window; freeze starts only after explicit authorization |
| Estimated freeze-to-pre-DNS | ~45–110 minutes per the approved runbook |
| Production source until T0 | Lovable / Supabase |
| Provider / financial flags | Remain **OFF** through this cutover |
| Bridges after cutover | **Keep both** for rollback |
| PR #125 | Leave open/unmerged |

Preflight script: `node aws/cutover/scripts/pre-t0-preflight.mjs`  
`--freeze` / `--apply` / `--cutover` are refused.

Live GO/NO-GO is filled after the read-only preflight run.
