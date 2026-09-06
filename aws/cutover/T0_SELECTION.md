# T0 selection and PRE-T0 checkpoint

**STOP FOR FINAL AUTHORIZATION.** Freeze is **not** enabled. Production remains on Lovable.

## PRE-T0: GO

Live read-only preflight: **2026-09-06T11:37:14Z**.

| Field | Value |
|---|---|
| Selected T0 | **2026-09-06 20:00:00 UTC** (16:00 America/New_York) |
| Freeze start | **Not started.** Starts only after explicit authorization after this checkpoint |
| Estimated freeze-to-pre-DNS | ~45–110 minutes |
| Production source now | Lovable / Supabase (`185.158.133.1`) |
| Provider / financial flags | **OFF** |
| Bridges after cutover | **Keep both** |
| PR #125 | **OPEN** (unmerged) |

`--freeze` / `--apply` / `--cutover` on `pre-t0-preflight.mjs` are refused.

## Immediate-before-freeze confirmations

| Check | Result | Evidence |
|---|---|---|
| current `main` includes merged PR #135 | **YES** | `origin/main` = `2c9818b138731a9f494e77c0ff2d8b3018864a3f` |
| Lovable → AWS application parity | **PASS** | Post-#135 audit; handlers on `main` |
| Database parity | **PASS** | Live `checksops` Sept 3 payee-mirror overlay; return columns present |
| Historical storage / check-image parity | **PASS** | 8/8 older checks; 16/16 source SHA-256 matches; T0 storage delta still required |
| Both migration bridges healthy | **YES** | DB `read_only` writes/deletes false; storage `sign_only` |
| Production Cognito / SES ready | **YES** | Pool `us-east-1_h00WorYMT`, 0 users, MFA OFF, RP `checksops.com`, `EmailSendingAccount=DEVELOPER`, deletion protection ACTIVE. Staging RP still `staging.checksops.com`. Users not imported yet (T3). |
| Production ACM issued / usable | **YES** | Cert `5cdde8e7-…` **ISSUED**; both names SUCCESS. Not attached to any distribution yet (attach at T6). |
| AWS production CloudFront target ready | **YES** | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` Deployed, enabled, **0 aliases** |
| DNS still points to Lovable | **YES** | apex + `www` → `185.158.133.1` |
| Lovable remains production source until T0 | **YES** | DNS unchanged; `productionSupabaseChanged=false` |
| Provider / financial execution flags OFF | **YES** | Staging + prep Lambdas |
| Moov execution OFF | **YES** | `AWS_MOOV_ENABLED=false` |
| CheckAlt execution OFF | **YES** | `AWS_CHECKALT_ENABLED=false` |
| `AWS_PROVIDER_EXECUTION_ENABLED=false` | **YES** | Staging + prep |
| `AWS_CHECKALT_ENABLED=false` | **YES** | Staging + prep |
| `64_financial_activation_grants.sql` NOT applied | **YES** | Stub still `NOT_APPLIED` / `DO NOT APPLY` |
| PR #125 remains open / unmerged | **YES** | Draft OPEN |
| Rollback path to Lovable confirmed | **YES** | Point A: DNS still Lovable; revert apex/`www` to `185.158.133.1`; keep bridges; flags stay OFF |

## T6 note (not a freeze blocker)

ACM is issued and unused. Attach it to CloudFront and add aliases only at the approved SPA/DNS step — not before freeze.

## Authorized sequence after your next yes (not started)

T0 write freeze → final DB delta → isolated reconciliation → final storage delta → identity import → AWS API/application smoke tests → Cognito SPA/CloudFront → DNS switch → post-cutover monitoring.

Holds that remain even after that authorization:

- Do not activate Moov, CheckAlt, financial execution, or `64_financial_activation_grants.sql`
- Do not tear down either migration bridge
- Preserve existing checks, stages, endorsements, documents, and historical images
