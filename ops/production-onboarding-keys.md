# Production onboarding KMS keys

## Why

Compliance & Docs uploads fail in production. `providers/onboarding/documents.mjs` needs
`FILES_BUCKET` and `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN` before it issues an upload URL, and
refuses with 503 `document_storage_unavailable` when either is missing. On 2026-10-30 the
production API `checksops-production-prep-api` had `FILES_BUCKET`
(`checksops-production-privatefiles-806168576068`) but no `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN`
and no `MOOV_ONBOARDING_PII_KMS_KEY_ARN`, and neither key existed in the account (read-only
check; only `alias/checksops-staging-compliance-documents` and
`alias/checksops-staging-moov-onboarding-pii` exist). Staging has both keys, defined in
`aws/template.yaml`, and uploads work there.

- **Compliance documents key** (`alias/checksops-production-compliance-documents`): SSE-KMS for
  files under `files/verification-docs/` (`DOCUMENTS_PREFIX`). Used by the production API role
  only through S3 (`kms:ViaService`), only for objects under that prefix.
- **Onboarding PII key** (`alias/checksops-production-moov-onboarding-pii`): field encryption
  of the EIN and representative DOB (`crypto.mjs`). Used by the production API role only with
  encryption context `app = checksops-moov-onboarding` and the keys `app`, `environment`,
  `tenant_id`, `field`.

Definition: `aws/production/onboarding-keys.yaml` (stack `checksops-production-onboarding-keys`).
Both keys are `DeletionPolicy: Retain`, rotation on, and tagged
`checksops-stack = checksops-production-onboarding-keys`. The key policies name the production
API role `checksops-production-api-execution` directly, so that role, the Lambda, the bucket
and the bucket policy do not change. The production bucket policy already lets that role read,
write and delete object versions.

## Order (each step is its own owner approval)

1. **One-time IAM prerequisite (owner-approved, manual).** The deploy role
   `ChecksOpsGitHubProductionLambdaOverlay` has no CloudFormation or KMS rights for this stack
   until an operator attaches the statements checked in at
   `aws/production-lambda-overlay/policies/permissions-policy.json`, once:
   - `InspectExactOnboardingKeysStack`: describe, events, resources and template of this stack only.
   - `CreateExactOnboardingKeysStack`: `cloudformation:CreateStack` on this stack only. No
     update or delete.
   - `ListKmsAliasesForOnboardingKeys`: `kms:ListAliases` (it takes no resource ARN).
   - `InspectTaggedOnboardingKeys`: describe, key policy, rotation status and tags, only on keys
     tagged for this stack.
   - `CreateOnboardingKeysThroughCloudFormation`: `kms:CreateKey`. KMS has no key ARN before
     creation, so the resource is `*`. It is bounded instead: only through CloudFormation
     (`aws:CalledVia`), this account, `SYMMETRIC_DEFAULT` / `ENCRYPT_DECRYPT`, not multi-Region,
     no lockout bypass, and only with the request tag
     `checksops-stack = checksops-production-onboarding-keys` that the template sets on both keys.
   - `SetUpNewOnboardingKeysThroughCloudFormation`: `kms:PutKeyPolicy`, `kms:TagResource` and
     `kms:EnableKeyRotation`, only through CloudFormation and only on keys tagged for this stack.
   - `CreateExactOnboardingKeyAliasesThroughCloudFormation` and
     `AliasTaggedOnboardingKeysThroughCloudFormation`: `kms:CreateAlias` for the two alias names
     only, onto a key tagged for this stack, through CloudFormation.

   There is no `ScheduleKeyDeletion`, `DisableKey`, `DeleteAlias`, `UpdateStack` or
   `DeleteStack` right. Until the statements are attached, inspect fails with `AccessDenied`
   and nothing changes. After the create, `CreateExactOnboardingKeysStack`,
   `CreateOnboardingKeysThroughCloudFormation`, `SetUpNewOnboardingKeysThroughCloudFormation`
   and both CreateAlias statements can be detached again.

2. **Inspect** through `.github/workflows/guarded-production-onboarding-keys.yml`
   (`mode: inspect`, production environment). Preflight
   `scripts/deployment-guard/github-production-onboarding-keys.mjs` (read-only). It checks the
   template bytes against the pinned sha256
   (`e584bb95750afd6a174b76f47288e197316c225aadcadcd4508bb1d21d1d85c2`, `sha256sum` of the file
   on an LF checkout), and reads the stack, both aliases and the prep Lambda configuration
   (RevisionId, role, `FILES_BUCKET`, and whether the two key variables are set). `ABSENT`
   (no stack, no alias) means create may proceed. The run summary shows the snapshot SHA-256.

3. **Create** (`mode: create`) with `approved_commit` = main, `expected_snapshot_sha256` from
   the inspect, `staging_acceptance_reference` = the staging evidence the owner accepts (the
   staging stack's equivalent keys and working staging uploads), and `approval_phrase` exactly
   the owner's words for this run:

   `CREATE ONBOARDING KEYS IN PRODUCTION`

   The production environment reviewer approves the job. It takes the
   `production-onboarding-keys` lease, issues a KMS-signed receipt whose preflight fingerprint
   is the whole snapshot, re-reads before and immediately before the write, then the writer
   `scripts/deployment-guard/production-onboarding-keys.mjs` sends one `CreateStack` with exactly
   the pinned template bytes and `OnFailure=DO_NOTHING`. It waits for `CREATE_COMPLETE`. On any
   other end state it prints the failed stack events and stops: no retry, no delete. A failed
   create is reported to the owner, and cleaning it up is a separate approved step.

4. **Verify** (same run). The stack is `CREATE_COMPLETE` from the pinned template; both aliases
   point at enabled keys with rotation on, tagged for this stack, whose key policies equal the
   template's; the prep Lambda RevisionId did not move. The run prints both key ARNs.

5. **Point the API at the keys** (a separate PR and run, after step 4). Add
   `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN` and `MOOV_ONBOARDING_PII_KMS_KEY_ARN` with the two ARNs
   from step 4 to the production section of `ops/deployment-guard/lambda-config-plan.json`,
   then apply through `.github/workflows/guarded-production-lambda-config.yml` with the owner's
   `APPLY API CONFIGURATION TO PRODUCTION`. This PR does not add those plan rows: the ARNs do
   not exist until the keys are created.

6. **Test upload.** The owner, or a tenant, uploads one document on Compliance & Docs in
   production. The upload returns no `document_storage_unavailable`; the object under
   `files/verification-docs/` is SSE-KMS with the compliance documents key.

## What this does not do

No Lambda code or configuration change, no IAM role change, no bucket or bucket policy change,
no SQL. The workflow cannot update or delete the stack or the keys. Removing them is a separate
operator step with its own approval (the keys are retained even if the stack is deleted).
