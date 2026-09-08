# Step 3 raw execute-api caller audit

**Result: PASS** (operator privileged read-only list, 2026-09-08).

Hostname: `kiqojucc02.execute-api.us-east-1.amazonaws.com`

Agent staging role still cannot list EventBridge / Scheduler / Synthetics /
alarms. A privileged read-only operator list in `us-east-1` found:

| Surface | Result |
|---|---|
| EventBridge rule targets | no `kiqojucc02` references |
| API Destinations | none |
| EventBridge Connections | none |
| Scheduler targets | none |
| Synthetics canaries | none |
| CloudWatch alarms | only `checksops-prod-api-4xx` and `checksops-prod-api-5xx` (metric observers, not HTTP callers) |

Agent-side supporting evidence (unchanged):

- CloudFront origin `ProductionPrepHttpApi` is the required runtime user of the hostname
- Prep Lambda invoke policy is APIGW `kiqojucc02` only
- No Lambda env value contains the hostname
- No event source mappings / Lambda URLs
- Live SPA `index-reP2FWHf.js` has no execute-api hostname
- Staging API `psr19uhop4` does not target production

Gate 3A–3C observe mode may proceed. Do **not** begin Gate 3D require-mode
from this audit.

`holds.ok=true`. `productionExecution=false`. `64_financial_activation_grants.sql`
**NOT_APPLIED**.
