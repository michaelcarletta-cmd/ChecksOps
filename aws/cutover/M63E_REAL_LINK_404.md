# M6.3E — Real pay-setup link 404 (STOP FOR REVIEW)

**2026-09-10T23:56–23:58Z.** User opened the current production `/pay-setup/:token` once after the AWS SPA cutover. Page showed **This link is not valid.** No resend. Token not printed. No KYC/ToS/bank. No money movement.

## What the failed request was

CloudFront + API Gateway, residential IPv6, `checksops.com`:

| Time (UTC) | Request | Result |
|---|---|---|
| 23:56:40 | `GET /pay-setup/{64-hex}` | 200 SPA HTML (`Miss`) |
| 23:56:41–23:58:43 | `POST /prep/public/moov-recipient-session` | **404**, `responseLength=601` |

The 601-byte body matches a dummy 64-hex POST to the same route: `{ error: "This link is not valid.", token_consumed: false, liveProviderCalled: false }`.

Separate 23:50–23:55 `GET /prep/public/moov-recipient-session%2560` 500s are a backtick/devtools URL, not the SPA session POST.

## Token (length / shape only)

Page URI token: **length 64**, lowercase **hex**, no encoding, no whitespace, no uppercase. Lambda `recipientSessionTokenShape` **accepts** it (32–128 hex). SPA `useParams` + `JSON.stringify({ token })` does not trim/decode/truncate that charset. Server `trim()` is a no-op.

`secureToken()` in `stakeholder-resend-verification` emits 64 hex. Column `secure_token` is **text**, currently **present** (redacted), not null.

## Resolver

Lambda has `CHECKSOPS_DB_BRIDGE_TOKEN` (length 43). That value authenticates production bridge `health` **200** on `nbcqwpysqgyxrrbgtmkw`. Secrets Manager JSON wrapper is **not** what Lambda uses.

Because the URI token passes shape, Lambda **does** call `recipient_session_resolve` (shape-fail 404 happens before the bridge and would only apply to malformed tokens).

Live resolve for empty / `x` / dummy UUID / dummy 64-hex all return the same:

`HTTP 404 { ok: false, resolved: false, reason: "invalid_token" }`

Git `aws-staging-db-bridge` does **not** return `reason`. Empty token in git is `400 token_required`. **Live Edge is not the git lookup.** Dummy tests could not distinguish a stub from a miss. The real 64-hex POST then 404s the same way.

Target row `62a858ff-ee6a-49d7-9898-1c8e4a44227b` still exists (`provider=moov`, `environment=production`, `onboarding_status=awaiting_bank`, Chase 1506). `token_used_at` **null**. `updated_at` still `2026-09-10T17:37:32.282001+00:00` (resend). `token_expires_at` is non-null (value redacted). Expired/used would be **410** after a successful resolve, not this 404.

Lambda overlay sha unchanged: `kXmSz1WkLtAIkwq5tj1z5UmoYZnWQRPtD5ra8Xh8rCU=`.

## Root cause

AWS received a well-formed 64-hex body token and mapped a live-bridge **404 `invalid_token`** to the SPA error. The live `recipient_session_resolve` action is listed and authenticated, but it is **not** the git PostgREST `secure_token=eq.{token}` lookup (empty token is 404 `invalid_token`, not `400 token_required`). The real link therefore never resolves.

## Fix required (not done this phase)

Deploy git `supabase/functions/aws-staging-db-bridge` `recipient_session_resolve` (GET `eq` on plaintext `secure_token`) to `nbcqwpysqgyxrrbgtmkw`. Do **not** resend or rotate. Then retry the **same** existing link. Dummy tokens must still 404.

## Holds

Money flags unchanged. SQL72 not applied. No DB/provider mutations in this diagnosis.
