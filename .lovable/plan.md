## What's happening

The toast shows a **Cloudflare 400 Bad Request** HTML page (notice the `<center>cloudflare</center>` footer). That means the request is being rejected at CheckAlt's edge/WAF — it never reaches their app. So the "Request body is required" JSON error from earlier and this Cloudflare 400 are **two different failures**, and our last fix (switching to `Content-Type: application/json` with `body: "{}"`) traded one for the other.

CheckAlt's own sample is unambiguous:

```
POST https://uatapi.checkalt.com/public/jwtauth/authenticate
merchant: lockbox5
Content-Type: application/x-www-form-urlencoded
Authorization: Basic ••••••
--body ''
```

That is: **empty body**, **form-urlencoded**, Basic auth header. The earlier "Request body is required" 400 we saw was almost certainly not from this happy-path call — it was likely from a fallback path or a different endpoint that the helper was also trying.

## Plan

1. **Revert `authenticateCheckAlt` in `supabase/functions/_shared/checkalt.ts`** to match CheckAlt's sample exactly:
   - `Content-Type: application/x-www-form-urlencoded`
   - `body: ""` (truly empty)
   - Keep `merchant`, `Authorization: Basic <base64(user:pass)>`, `Accept`
   - Remove the `{}` JSON body that's tripping Cloudflare

2. **Remove any leftover path/endpoint fallbacks** in that function so we only ever hit `/public/jwtauth/authenticate` — extra attempts at wrong paths are what produced the earlier confusing 404/400 chain and can re-lock the account.

3. **Improve the error surfaced to the UI** when Cloudflare returns HTML: detect `<html>` in the response body and show "CheckAlt edge rejected the request (Cloudflare 400) — likely IP block, header value, or malformed request. Contact CheckAlt support with the request ID." instead of dumping raw HTML into the toast.

4. **Redeploy all five CheckAlt edge functions** so they pick up the shared helper:
   - `checkalt-submit-deposit`
   - `checkalt-approve-deposit`
   - `checkalt-poll-status`
   - `checkalt-account-status`
   - `checkalt-register-account`

5. **Test with `supabase--curl_edge_functions`** against `checkalt-submit-deposit` (or a dedicated auth-only test path if simpler) to confirm auth returns a JWT before you retry from the app.

## What I will NOT change

- Secrets (`CHECKALT_USERNAME=freedom_api_user_uat`, `CHECKALT_MERCHANT=lockbox5`, `CHECKALT_PASSWORD`) — those are confirmed correct.
- Any deposit/registration logic — only the auth call shape.
- Frontend code.

## If it still fails after this

The remaining likely cause is **CheckAlt's WAF blocking Supabase edge function IPs** or expecting an allowlisted source. In that case the fix is on CheckAlt's side — we'll capture the exact request ID from the Cloudflare response headers and forward to their support.
