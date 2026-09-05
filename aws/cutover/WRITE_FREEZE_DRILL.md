# Timed write-freeze drill (not a real freeze)

**This is a drill.** Production writes were **not** frozen. Final DB/storage delta was **not** run.

Script: `node aws/cutover/scripts/write-freeze-drill.mjs`  
`--apply` / `--freeze` are refused (exit 2).

## Measured 2026-09-05 (read-only bridges only)

| Step | ms |
|---|---|
| DB bridge `health` | 156 |
| `tables` (181) | 1,016 |
| `counts` (180 tables) | 23,157 |
| `identity_map` | 497 |
| Storage bridge `health` | 171 |
| Storage `inventory` | 40,459 |
| **Capture-path floor** | **~64 s** (repeat 2026-09-05 ~63.5 s) |

Bridges stayed fail-closed (`mode:read_only` / `sign_only`, writes/deletes false). Apex/`www` DNS unchanged.

## What this does **not** measure

Isolated overlay/restore, financial recon, storage COPY, Cognito import, and DNS — still the PR #127 budget **~45–110 min** pre-DNS. Add ~5–10 min to **announce + enable** a real freeze on cutover night.

## Cutover night

Do not treat this 65s figure as the freeze window. Enable a real write-freeze only with explicit production-cutover approval.
