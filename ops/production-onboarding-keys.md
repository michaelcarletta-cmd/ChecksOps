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

   There is no `ScheduleKeyDeletion`, `DisableKey`, `DeleteAlias` or `DeleteStack` right.
   `UpdateStack` came later, for the reviewed update in "Update 2026-11" below
   (`UpdateExactOnboardingKeysStack`). Until the statements are attached, inspect fails with `AccessDenied`
   and nothing changes. After the create, `CreateExactOnboardingKeysStack`,
   `CreateOnboardingKeysThroughCloudFormation`, `SetUpNewOnboardingKeysThroughCloudFormation`
   and both CreateAlias statements can be detached again.

2. **Inspect** through `.github/workflows/guarded-production-onboarding-keys.yml`
   (`mode: inspect`, production environment). Preflight
   `scripts/deployment-guard/github-production-onboarding-keys.mjs` (read-only). It checks the
   template bytes against the pinned sha256 (at the create, 2026-11-01:
   `e584bb95750afd6a174b76f47288e197316c225aadcadcd4508bb1d21d1d85c2`; since the update below:
   `c48853d998a494ee5766e5f069365c3a11dceaac2e25f26429817fd91a950b11`; `sha256sum` of the file on an
   LF checkout), and reads the stack, both aliases and the prep Lambda configuration
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

5b. **Bucket CORS for the upload headers** (added 2026-11-04). The browser's presigned PUT sends the
   SSE-KMS headers, so the production files bucket's CORS must allow them, as staging's does. It
   was missed in this rollout and every production upload failed with "Network error while
   uploading."; the fix is `ops/production-files-bucket-cors.md`.

6. **Test upload.** The owner, or a tenant, uploads one document on Compliance & Docs in
   production. The upload returns no `document_storage_unavailable`; the object under
   `files/verification-docs/` is SSE-KMS with the compliance documents key.

## Update 2026-11: let the files replication role decrypt compliance documents

**Why.** The production files bucket is copied to `us-east-2`
(`ops/security/FILES_BUCKET_REPLICATION_2026_11.md`, phase 1 applied 2026-11-09). Compliance
documents under `files/verification-docs/` are SSE-KMS with this stack's compliance documents key,
whose policy lets only the production API role use it, so S3 replication cannot read them. Phase 2
of that runbook needs the replication role `checksops-production-files-replication` to decrypt them.

**The change** (`aws/production/onboarding-keys.yaml`, pinned sha256 `c48853d9…`). One statement
added to the compliance documents key policy, `FilesReplicationRoleDecryptViaS3`: `kms:Decrypt`
only, for that role only, only through S3 in `us-east-1` (`kms:ViaService`), only for objects under
`files/verification-docs/` (`kms:EncryptionContext:aws:s3:arn`), plus a three-line comment. Nothing
else changes: the writer rebuilds the previous template by removing exactly those two pieces and
requires the result to hash to the live stack's template (`e584bb95…`). The PII key, both aliases, the
outputs, rotation, tags and the API role's statement stay exactly as they are.

**Steps (each is its own owner approval):**

1. **One-time IAM step (owner, CloudShell, as `michael-admin`).** Add the single statement
   `UpdateExactOnboardingKeysStack` (`cloudformation:UpdateStack` on this stack only) to the live
   inline policy `ChecksOpsGitHubProductionLambdaOverlayLeastPrivilege` of
   `ChecksOpsGitHubProductionLambdaOverlay`. Do **not** upload
   `aws/production-lambda-overlay/policies/permissions-policy.json` as a whole: the live policy
   differs from it in other workstreams' statements (read 2026-11-09). Add only this statement:

   ```bash
   ROLE=ChecksOpsGitHubProductionLambdaOverlay
   POLICY=ChecksOpsGitHubProductionLambdaOverlayLeastPrivilege
   aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY" --query PolicyDocument --output json > /tmp/live.json
   python3 - <<'PY2'
   import json
   d = json.load(open('/tmp/live.json'))
   sids = [s.get('Sid') for s in d['Statement']]
   assert 'UpdateExactOnboardingKeysStack' not in sids, 'already there'
   assert 'SetUpNewOnboardingKeysThroughCloudFormation' in sids, 'PutKeyPolicy through CloudFormation is missing'
   d['Statement'].append({
     'Sid': 'UpdateExactOnboardingKeysStack', 'Effect': 'Allow', 'Action': 'cloudformation:UpdateStack',
     'Resource': 'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-onboarding-keys/*'})
   json.dump(d, open('/tmp/new.json', 'w'))
   print('statements', len(sids), '->', len(d['Statement']))
   PY2
   aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" --policy-document file:///tmp/new.json
   ```

   The key policy write itself uses the existing `SetUpNewOnboardingKeysThroughCloudFormation`
   (`kms:PutKeyPolicy` only through CloudFormation, only on keys tagged for this stack); the role
   still has it (read 2026-11-09).

2. **Inspect** (`mode: inspect`). Expect state `UPDATE_READY`: the live stack holds the previous
   template and its key policies, with nothing else drifted. Record the snapshot SHA-256.

3. **Update** (`mode: update`) with `approved_commit` = main, `expected_snapshot_sha256` from the
   inspect, `staging_acceptance_reference` = this change's reviewed PR (staging has no replication;
   the evidence is the reviewed change and its tests), and `approval_phrase` exactly the owner's
   words for this run:

   `UPDATE ONBOARDING KEYS IN PRODUCTION`

   The writer sends one `UpdateStack` with the pinned bytes, no parameters and no capabilities,
   and waits for `UPDATE_COMPLETE`. On any other end state (CloudFormation rolls a failed update
   back by itself) it prints the failed events and stops: no retry.

4. **Verify** (same run): the stack is `UPDATE_COMPLETE` from the pinned template; the same stack,
   aliases, outputs and keys; the PII key unchanged in every field; the compliance documents key
   unchanged except its policy, which now equals the template's; the prep Lambda unmoved.

5. **Record PR**, then phase 2 of `ops/security/FILES_BUCKET_REPLICATION_2026_11.md` (the
   `us-east-2` key, the role's KMS rights, the rule and a second batch copy).

### Applied 2026-11-09

| Step | Evidence |
|---|---|
| 1. IAM step | Owner in CloudShell as `michael-admin` (Identity Center `AdministratorAccess`, not root): "statements 15 -> 16". CloudTrail `PutRolePolicy` on `ChecksOpsGitHubProductionLambdaOverlay` / `ChecksOpsGitHubProductionLambdaOverlayLeastPrivilege`, 11:37:42 UTC, event `e5b297ad-7a46-4b71-a976-b62b1e60cd04`, no error. Read back as `claude-code`: `UpdateExactOnboardingKeysStack` present, `SetUpNewOnboardingKeysThroughCloudFormation` still present, no other `UpdateStack` statement. |
| 2. Inspect | Run [42613740402](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42613740402) on main `69e29f49d` (#1707): `UPDATE_READY`, no problems, snapshot `2f21e93653b9b5deb6568beee68e95f9787af9941921c16835ec27461c4c4f45`, template `c48853d9…`. |
| 3a. Update, first run | Run [42613905050](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42613905050): failed closed before any write. `RECEIPT_FORGED`: KMS `Sign` refused the receipt (`message` longer than 4,096 bytes; the snapshot carries both live key policies). No `UpdateStack` or `PutKeyPolicy` in CloudTrail from it. Fixed by #1710 (receipts signed over their SHA-256 digest). |
| 2'. Inspect again | Run [42618609552](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42618609552) on main `ac8e34600` (#1710): `UPDATE_READY`, no problems, the same snapshot `2f21e936…`. |
| 3b. Update | Run [42618763202](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42618763202) on main `ac8e34600`, with the owner's words for this run `UPDATE ONBOARDING KEYS IN PRODUCTION`. CloudTrail as `ChecksOpsGitHubProductionLambdaOverlay/checksops-production-onboarding-keys-42618763202`, no error: `UpdateStack` 12:39:38 UTC, event `b5d82c42-25c9-4576-aa12-f66313dce244`; `PutKeyPolicy` on key `59d713da-72f3-43a6-8a48-a826d432d53f` 12:39:42 UTC, event `972f6fca-96e5-4d4b-8bf2-ff321852e743`. Stack events: only `ComplianceDocumentsKey` `UPDATE_IN_PROGRESS` → `UPDATE_COMPLETE`; stack `UPDATE_COMPLETE` 12:40:45 UTC. |
| 4. Verify | The run's after-write check stopped at `post_write_not_live:key_policy_drift:alias/checksops-production-compliance-documents`: KMS stores the new statement's one-item action list `["kms:Decrypt"]` as the string `"kms:Decrypt"`, and the guard compared literally. Fixed by #1711 (key policies compared the way AWS reads them, tested on the exact policy KMS returned). Read-only inspect [42622069338](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42622069338) on main `e7ed53ace` (#1711): **`LIVE`, no problems**, stack `UPDATE_COMPLETE`, template `c48853d9…`, snapshot `e87bc108322e6275960dedd391443f8910199875c0075397a8dc8102a66e1730`, documents key `59d713da-…`, PII key `30d2da88-…` (unchanged), prep Lambda RevisionId `6bd20885-4561-421f-8c0b-8b7ba18aa549` (unmoved). |

The live compliance documents key policy has three statements: `KeyAdministrationOnly`,
`ProductionApiRoleViaS3` and `FilesReplicationRoleDecryptViaS3`. Next: phase 2 of
`ops/security/FILES_BUCKET_REPLICATION_2026_11.md` (the `us-east-2` key, the role's KMS rights, the
rule and a second batch copy).

## What this does not do

No Lambda code or configuration change, no bucket or bucket policy change, no SQL. The only IAM
changes are the one-time deploy-role statements above. The workflow cannot delete the stack or the
keys; its only update is the reviewed one above. Removing them is a separate
operator step with its own approval (the keys are retained even if the stack is deleted).
