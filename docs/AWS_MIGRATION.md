# ChecksOps AWS Migration

## Objective
Move the ChecksOps backend from Supabase/Lovable Cloud to AWS without interrupting the production application.

Production remains on the existing Supabase backend until AWS passes parity and reconciliation checks.

## Target architecture

- Frontend: existing Vite/React app
- API: Amazon API Gateway + AWS Lambda
- Database: Amazon RDS for PostgreSQL 18.3 (existing `checksops-staging` instance; do not create another)
- Authentication: Amazon Cognito
- Object storage: Amazon S3
- Secrets: AWS Secrets Manager
- Scheduling: Amazon EventBridge
- Logging/metrics: Amazon CloudWatch
- DNS/TLS: Route 53 + ACM

Payment provider calls, secrets, webhooks, tenant authorization, and money movement must remain server-side.

## Current production inventory

The live Lovable ChecksOps project is the migration source of truth. Authoritative catalog: `aws/db-copy/LIVE_SOURCE_INVENTORY.md`.

- 166 public **base tables**
- 20 public **views** (186 public relations = tables + views; there is no 20-table data gap)
- 960 public functions
- 211 public triggers
- 380 RLS policies (extract, do not apply on first RDS restore)
- 9 auth users (separate Cognito migration; do not dump password hashes)
- 1,335 storage objects (separate S3 migration)

Important functional domains include:

- check intake and check cases
- endorsements
- deposits and CheckAlt
- disbursements
- Moov wallets/transfers/sweeps
- stakeholder accounts
- loss draft and mortgage tracking
- homeowner ledger
- tenant/user/role data
- billing/fees
- webhooks and idempotency
- audit/security logs

## Migration principles

1. Never cut production directly from Supabase to AWS.
2. Build and validate AWS in parallel.
3. Preserve identifiers used by checks, tenants, payments, Moov, CheckAlt, endorsements, and webhooks.
4. Preserve audit records and provider event history.
5. Do not expose RDS directly to the browser.
6. Do not place Moov, CheckAlt, Resend, Plaid, or other private credentials in Vite environment variables.
7. Every payment/webhook write path must retain idempotency protection.
8. Tenant isolation must be enforced in the AWS API layer and database.
9. Storage migration must preserve a durable mapping from existing object path/key to the new S3 key.
10. Supabase remains available as rollback/read-only source until final reconciliation is complete.

## Migration phases

### Phase 0 - Inventory and safety

- inventory public tables, primary keys, foreign keys, indexes, triggers, routines, extensions and RLS policies
- inventory Auth configuration/users
- inventory storage buckets and object counts
- inventory Supabase Edge Functions in GitHub
- inventory scheduled jobs and database HTTP callbacks
- inventory all frontend `supabase.from`, `supabase.rpc`, `supabase.storage`, `supabase.auth`, and `supabase.functions.invoke` usage
- identify hardcoded Supabase project URLs/refs
- rotate any credentials that have been committed to Git history

### Phase 1 - AWS foundation

Provision a non-production AWS environment first:

- VPC with private database subnets
- RDS PostgreSQL 17
- S3 buckets for private ChecksOps files
- Cognito user pool
- API Gateway
- Lambda execution roles
- Secrets Manager
- CloudWatch log groups/alarms

No production DNS changes occur in this phase.

The SAM stack in `aws/template.yaml` is staging-only. It creates the HTTP API, Lambda, private S3 bucket, Cognito user pool, and Secrets Manager container. It attaches the API Lambda to the existing RDS VPC and adds a 5432 rule from a dedicated Lambda security group. It does not create, import, or modify the `checksops-staging` RDS instance. The API reads the application database secret ARN from Secrets Manager; passwords never go in Git or plaintext environment variables. Provider credentials are populated in Secrets Manager after deploy, never in CloudFormation `SecretString`.

### Phase 2 - Database parity

Preparation tooling and the exact copy sequence live in `docs/AWS_DB_COPY_RUNBOOK.md` and `aws/db-copy/`. That phase is still **preparation only** until a copy is explicitly approved.

When a copy is approved:

- export schema and public data from the live ChecksOps Supabase database
- restore to the existing `checksops-staging` RDS PostgreSQL 18.3 instance
- recreate required PostgreSQL extensions supported by RDS
- replace Supabase-specific auth/RLS dependencies where required
- compare row counts and key financial aggregates
- verify tenant/check/payment relationships
- leave Auth→Cognito, Storage→S3, RLS apply, and Edge Function/webhook cutover for later phases

High-risk tables requiring explicit reconciliation include:

- check_cases
- check_intake_items
- check_payees
- check_endorsements
- endorsement_requests
- deposit_batches
- deposit_items
- checkalt_deposits
- disbursement_batches
- disbursement_splits
- payment_provider_accounts
- payment_transfers
- payment_wallets
- payment_wallet_ledger
- payment_webhook_events
- stakeholder_accounts
- tenants
- tenant_users
- user_roles
- claim_checks
- claims
- loss_draft_tracking
- homeowner_ledger_events

### Phase 3 - Backend API

Create an AWS API layer rather than allowing the browser to connect to PostgreSQL.

Initial service boundaries:

- auth/identity
- tenants/users/roles
- checks
- endorsements
- deposits/CheckAlt
- payments/Moov
- disbursements
- stakeholders
- mortgage/loss draft
- files
- notifications/email/SMS
- webhooks

Frontend migration should happen domain-by-domain, not with a single all-or-nothing rewrite.

### Phase 4 - Provider functions

Convert Supabase Edge Functions to Lambda/API routes. Payment-related functions are highest priority.

Examples already referenced by the application include Moov readiness, transfers, sweep configuration, account verification/files, invoices, payment direction requests, email unsubscribe, QuickBooks payment, and public directory endpoints.

All provider webhook routes must validate signatures where supported and store provider event IDs before processing to prevent duplicate execution.

### Phase 5 - Storage

- inventory Supabase buckets and object metadata
- create private S3 bucket(s)
- copy objects
- preserve content type, size, timestamps where useful, and object mapping
- replace public/signed URL generation with S3 presigned URLs
- validate check images, endorsement documents, tenant documents, mortgage/loss draft files and provider files

### Phase 6 - Authentication

Cognito migration should be performed after the API layer exists.

Required outcomes:

- preserve the user's application/profile identity
- map Cognito `sub` to the ChecksOps application user/profile record
- preserve tenant membership and roles
- support forgot-password/reset-password
- support email verification as configured
- keep authorization decisions in the API/database rather than trusting client-side role values

### Phase 7 - Dual-run verification

Before cutover:

- run AWS staging against a restored production snapshot
- test all principal workflows
- reconcile data after test transactions
- validate Moov sandbox/provider sandbox behavior
- validate CheckAlt test/sandbox behavior where available
- validate webhook retries and idempotency
- validate check upload, endorsement, deposit and disbursement lifecycle
- validate tenant isolation
- validate file access controls

### Phase 8 - Production cutover

Only after approval/parity:

1. place legacy write paths into controlled maintenance/freeze state if required
2. take final database delta/snapshot
3. restore/apply delta to RDS
4. reconcile counts and balances
5. switch frontend API/auth configuration
6. switch provider webhook destinations
7. monitor CloudWatch and provider dashboards
8. retain Supabase read-only for rollback/reconciliation

## Cursor workflow

Cursor should work from the `aws-migration` branch until the migration is ready for review.

Do not replace existing production Supabase calls blindly. Introduce AWS APIs behind explicit service modules and migrate one functional domain at a time.

Recommended first implementation domain: read-only tenant/check API. After that is validated, move write operations, then payment/provider operations.

## Required AWS environment variables

See `.env.aws.example`. Actual credentials must be stored in AWS Secrets Manager or protected deployment secrets, never committed to Git.

## Definition of done

The migration is complete only when:

- AWS holds the authoritative production PostgreSQL data
- Cognito handles production authentication
- S3 holds production files
- all required Edge Function behavior has an AWS equivalent
- Moov and CheckAlt production webhooks terminate on AWS
- row/financial reconciliation passes
- tenant authorization tests pass
- production frontend no longer depends on Supabase APIs
- rollback window is completed without unresolved discrepancies
