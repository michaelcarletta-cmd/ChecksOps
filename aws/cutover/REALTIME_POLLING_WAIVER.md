# Realtime polling waiver (AWS)

**Decision:** accept the existing **15s poll/refetch** fallback as the AWS realtime substitute at DNS cut. A dedicated AWS pub/sub design is **out of scope** for cutover.

## Why this is safe to waive

- AWS staging already no-ops Supabase websocket channels.
- `useAwsPollingFallback` refetches Check Command queues every 15 seconds when Cognito staging is active.
- Production Lovable **keeps** realtime websockets until DNS/auth switch. This waiver does not change `.env.production`.
- No money-movement path depends on sub-second invalidation.

## What is not waived

- Identity, RLS, financial flags, webhooks, Moov/CheckAlt execution, and DNS.

## Later (optional, not a cutover blocker)

Replace polling with AppSync / API Gateway websocket / SNS→client if operators want <15s freshness after AWS is the system of record.
