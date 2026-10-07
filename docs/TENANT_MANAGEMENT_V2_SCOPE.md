# Tenant Management V2 — guarded scope

Base: `805b25a1cd74e6652c91cc354b254e294e88c11b`

This workstream is read-heavy and fail-closed. It covers only:

1. Organization Overview
2. Usage Integrity
3. Billing Status
4. Provider Health
5. Audit History
6. Storage & Operations

## Safety boundaries

- Forward-compose from current main before consequential edits.
- No AWS, staging, or production deployment/write.
- No Moov, CheckAlt, ACH, provider, or financial execution.
- Do not modify Collection V2 settlement behavior (#737) or the manual-deposit repair (#741).
- Do not weaken Release Locks, Deployment Guard, Accepted Feature Registry, authentication, tenant isolation, RLS, or financial safeguards.
- Do not restore or replace production SPA locks or historical deployment metadata.
- Prefer authoritative AWS read endpoints/rollups rather than new direct browser-side aggregation.
- Provider Health is persisted-state/read-model only; opening the dashboard must never call a provider.
- New platform administration reads must require platform-owner authorization and explicit tenant scope.
- No production/staging data mutation for UAT.

## Intended read model

Organization Overview should consolidate tenant identity/status, plan/environment, users, usage, billing, provider readiness, and operational health.

Usage Integrity should reconcile actual operational activity to usage/billing events and surface discrepancies without silently repairing data.

Billing Status should show charges, collections, outstanding amounts, auto-billing state, and relevant billing periods without initiating collection.

Provider Health should summarize persisted Moov/CheckAlt account state, capabilities, environment, last sync, restrictions/errors, and readiness without live provider calls.

Audit History should expose tenant-scoped administrative/configuration events with actor, action, timestamp, and safe before/after metadata.

Storage & Operations should provide tenant-scoped counts/rollups for checks, files/storage where authoritative metadata exists, OCR, signature requests, MortgageOps, deposits/disbursements, and recent operational activity.

Implementation must include tenant-isolation/platform-owner authorization tests and focused read-model tests before merge consideration.
