# Final Supabase runtime dependency audit (AWS staging)

## Actual AWS staging runtime dependencies (when `VITE_AUTH_PROVIDER=cognito`)

| Area | Status |
|---|---|
| `functions.invoke` for Class A migrated names | **AWS** `/functions/v1/*` |
| `/h/upload` auth | **AWS OTP** (no Supabase Auth) |
| Storage | **AWS** `/storage/*` |
| DB reads/writes | **AWS** `/data/query|/data/write` |
| Realtime | **noop stub** (not Supabase) |
| Cron | **AWS** `/scheduled/*` (safe jobs) |

## Production fallback code (KEEP — do not delete)

SPA still contains `supabase.auth` / `supabase.from` / `supabase.functions.invoke` paths for production Lovable builds where `VITE_AUTH_PROVIDER` is unset.

## Still required temporarily on staging surfaces

- WhiteLabelLogin / MortgageOpsLogin Cognito wiring is **complete on staging** (PR #126). Production SPA still uses Supabase Auth until cutover.
- Signature vendor / QuickBooks / Stripe / Moov / CheckAlt invokes remain provider_disabled or Class B/C. Plaid is not used.
- `ingest-shared-check` / first-party e-sign remain Class A outstanding on `main` (not this PR).

See `aws/cutover/CUTOVER_READINESS_MATRIX.md`.

## Obsolete / removable later

- Supabase passkey edge functions on CheckOps HTTPS staging
- Soft organizations UI
