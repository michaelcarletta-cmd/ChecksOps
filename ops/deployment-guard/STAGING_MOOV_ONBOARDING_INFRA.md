# Staging Moov onboarding infrastructure (guarded writer)

`scripts/deployment-guard/staging-moov-onboarding-infra.mjs` creates the Moov
onboarding infrastructure that `aws/template.yaml` defines but the
`checksops-staging` stack never received (its last deploy was 2026-09-03).
Without it, staging onboarding fails with `pii_encryption_unavailable`.

A full `sam deploy` is forbidden because it would overwrite live overlay state.
This writer changes only the pieces below. It is **staging only**: account
`806168576068`, region `us-east-1`, Lambda `checksops-staging-api`, role
`checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`, bucket
`checksops-staging-privatefilesbucket-erzqsolpucjp`. It never touches production.

## What it changes, in order

| # | Step | Change |
|---|---|---|
| 1 | `create-pii-key`, `create-pii-key-alias`, `enable-pii-key-rotation` | KMS key + `alias/checksops-staging-moov-onboarding-pii`, rotation on |
| 2 | `create-docs-key`, `create-docs-key-alias`, `enable-docs-key-rotation` | KMS key + `alias/checksops-staging-compliance-documents`, rotation on |
| 3 | `put-role-policy` | inline policy `MoovOnboardingKms` on the API role (three template statements, concrete ARNs). The other 9 inline policies are untouched. |
| 4 | `put-bucket-policy` | the two template Deny statements for `files/verification-docs/*`. The bucket has no policy today; if one exists, the writer stops. It never merges. |
| 5 | `put-bucket-cors` | both existing rules kept; the PUT rule gains `content-length`, `x-amz-server-side-encryption`, `x-amz-server-side-encryption-aws-kms-key-id` and exposes `ETag`, `x-amz-version-id`. No origin removed. |
| 6 | `put-bucket-lifecycle` | `AbortIncompleteMultipartUploads` kept; adds `ComplianceDocumentUploadsExpire` (uploads/, 1 day + noncurrent 1 day) and `ComplianceDocumentsExpireNoncurrentVersions` (final/, noncurrent 7 days). `TransitionDefaultMinimumObjectSize` is passed through unchanged. |
| 7 | `update-lambda-env` | current env + `MOOV_ONBOARDING_PII_KMS_KEY_ARN`, `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN`, `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED="false"`, with `--revision-id` CAS. Last, so the code sees the ARNs only once everything it needs exists. |

Key policies follow the template (`KeyAdministrationOnly` for the account root;
no Encrypt/Decrypt/CreateGrant for root), but use is bound to the exact role ARN
(`ArnEquals aws:PrincipalArn`) instead of the `${StackName}-ApiFunctionRole-*`
wildcard. The PII key requires encryption context `app=checksops-moov-onboarding`
with keys limited to `app, environment, tenant_id, field` (as `crypto.mjs`
sends). The documents key allows only `kms:GenerateDataKey`/`kms:Decrypt` via
`s3.us-east-1.amazonaws.com` for `aws:s3:arn` under `files/verification-docs/*`.

Not created: no KMS VPC endpoint (the Lambda SG allows 443 out and a NAT
exists), no CloudFormation change, no code change.

## Preconditions (checked on every run; any failure exits with `DEPLOYMENT_COLLISION`)

- caller account is `806168576068`; `AWS_REGION` unset or `us-east-1`
- Lambda role is the exact role above, `State=Active`, `LastUpdateStatus=Successful`, `FILES_BUCKET` is the bucket
- bucket versioning `Enabled`; S3 Bucket Keys not enabled (they would change the KMS context to the bucket ARN)
- each piece is either the pinned baseline or exactly the desired state, and the
  done steps form a prefix of the order above (a clean resume point)
- no tagged onboarding key exists without its alias (orphan from an interrupted run)
- the merged Lambda env stays under 4 KB; the role's inline policies stay under 10,240 characters

## Runbook

Run from a Linux or macOS shell (or CI). The guard's lease and receipt file names
contain `:` (`staging::staging-moov-onboarding-infra.json`), which Windows refuses,
so `preflight.mjs --acquire-lease` does not work on a Windows checkout.

The operator's AWS identity needs: `sts:GetCallerIdentity`;
`lambda:GetFunctionConfiguration`, `lambda:UpdateFunctionConfiguration`;
`iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:PutRolePolicy` on the role;
`kms:CreateKey`, `kms:TagResource`, `kms:CreateAlias`, `kms:DescribeKey`,
`kms:GetKeyPolicy`, `kms:GetKeyRotationStatus`, `kms:EnableKeyRotation`;
`tag:GetResources`; `s3:GetBucketPolicy`, `s3:PutBucketPolicy`, `s3:GetBucketCORS`,
`s3:PutBucketCORS`, `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration`,
`s3:GetBucketVersioning`, `s3:GetEncryptionConfiguration` on the bucket.

### 1. Plan (read-only)

```bash
git checkout main && git pull
node scripts/deployment-guard/staging-moov-onboarding-infra.mjs --plan
```

Exit code 2 is expected. The output lists every step as `pending`/`done`, and
`preflight_live_fingerprint`. Copy that object **verbatim** into the manifest.

### 2. Contracts, lease and receipt

Run the contracts this target requires:

```bash
node --test aws/tests/tenant-security-compliance.test.mjs
node --test aws/tests/staging-moov-onboarding-infra.test.mjs
```

`staging-onboarding-infra.json` (do not commit it):

```json
{
  "workstream_id": "staging-moov-onboarding-infra-20261019",
  "target_environment": "staging",
  "target_component": "staging-moov-onboarding-infra",
  "deployment_type": "staging-onboarding-infra",
  "owned_components": ["staging-moov-onboarding-infra"],
  "preflight_live_fingerprint": {
    "component": "staging-moov-onboarding-infra",
    "function_name": "checksops-staging-api",
    "revision_id": "<from plan>",
    "code_sha256": "<from plan>",
    "pending_steps": ["create-pii-key", "create-pii-key-alias", "enable-pii-key-rotation", "create-docs-key", "create-docs-key-alias", "enable-docs-key-rotation", "put-role-policy", "put-bucket-policy", "put-bucket-cors", "put-bucket-lifecycle", "update-lambda-env"],
    "snapshot_sha256": "<from plan>"
  },
  "contract_results": {
    "tenant-isolation": { "ok": true },
    "staging-moov-onboarding-infra": { "ok": true }
  }
}
```

```bash
node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input staging-onboarding-infra.json
```

The receipt lasts 15 minutes and is bound to that fingerprint, this workstream,
the commit, `staging` and `staging-moov-onboarding-infra`. A production receipt
or a receipt for another component is refused.

### 3. Apply

```bash
CHECKSOPS_STAGING_ONBOARDING_INFRA_EXECUTE=1 \
CHECKSOPS_WORKSTREAM_ID=staging-moov-onboarding-infra-20261019 \
CHECKSOPS_COMMIT=$(git rev-parse HEAD) \
node scripts/deployment-guard/staging-moov-onboarding-infra.mjs
```

The writer re-reads live state, validates the receipt against the fresh
fingerprint, re-reads again immediately before writing (TOCTOU) and consumes the
receipt once. Each step re-reads the resource it is about to change. It then
reads everything again and refuses unless the only changes are the planned ones:
every pre-existing env key unchanged (compared by hash), the nine other inline
policies, both existing CORS rules and the existing lifecycle rule untouched.

Output carries step names, ARNs and fingerprints only. Lambda env values are
never printed, and every output line is also redacted against them.

### 4. Verify

```bash
node scripts/deployment-guard/staging-moov-onboarding-infra.mjs --plan   # every step "done"
node scripts/deployment-guard/lease.mjs release --workstream-id staging-moov-onboarding-infra-20261019 --environment staging --component staging-moov-onboarding-infra
```

Then on `https://staging.checksops.com`: save an EIN in Compliance & Docs (no
`pii_encryption_unavailable`) and upload a document (presigned PUT succeeds,
finalize succeeds).

## Interrupted run / resume

If a step fails, the error lists `completed_steps` and the key ARNs created so far.
Run the plan again: completed steps are detected as `done` and only the rest is
pending. The fingerprint has changed, so issue a fresh receipt (step 2) and apply
again. A key whose alias exists is never recreated.

If the run stopped between `create-*-key` and `create-*-key-alias`, the plan
reports `<slot>_orphan_tagged_key_requires_review` (keys are tagged
`checksops:onboarding-infra-key=pii|docs`). Review that key. Once the owner
approves, schedule its deletion through a reviewed change, then plan again.
A key pending deletion is not treated as an orphan.

## Rollback

There is no rollback mode in this writer. A rollback is a new reviewed, guarded
change (receipt for `staging-moov-onboarding-infra`). Never run raw `aws` writes
against staging. In reverse order, the rollback must:

1. **Lambda env**: remove `MOOV_ONBOARDING_PII_KMS_KEY_ARN`,
   `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN` and `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED`
   from the current env with RevisionId CAS, keeping every other key. Onboarding
   then fails closed again (`pii_encryption_unavailable`). Do this first.
2. **Lifecycle / CORS**: restore the single `AbortIncompleteMultipartUploads` rule
   and the PUT rule's `AllowedHeaders ["content-type"]` with no `ExposeHeaders`.
3. **Bucket policy**: delete it, but only if it still holds exactly the two
   compliance Deny statements.
4. **Role policy**: delete inline policy `MoovOnboardingKms`.
5. **KMS keys**: keep them. **Disable, never delete**: PII ciphertext and
   compliance documents already written cannot be decrypted without them. Keep the
   aliases so a re-run resumes instead of creating new keys. If deletion is ever
   required, use `ScheduleKeyDeletion` with the maximum 30-day window, and only
   after confirming no stored ciphertext or document references the key.

## WARNING: resources outside CloudFormation

The two keys, their aliases, the `MoovOnboardingKms` inline policy, the bucket
policy, the CORS/lifecycle additions and the three env keys now exist **outside**
the `checksops-staging` CloudFormation stack.

A future stack deploy of `aws/template.yaml` will collide:

- `MoovOnboardingPiiKeyAlias` / `ComplianceDocumentsKeyAlias` would fail with
  "alias already exists". Without the aliases, new keys would be created and the
  env would point at keys without the existing ciphertext.
- `PrivateFilesBucketPolicy` would replace the live bucket policy.
- `PrivateFilesBucket` CORS (staging origin only, MaxAge 600) and lifecycle would
  replace the live rules, dropping the `checksops.com` / `www` origins.
- The template's role statements would duplicate `MoovOnboardingKms`.

Before any staging stack deploy, **import** the keys (resource import, with
`DeletionPolicy: Retain`) and point the aliases at them, or remove the template
resources. Reconcile the bucket CORS/lifecycle with the live rules, and remove the
inline `MoovOnboardingKms` policy in the same reviewed change. The deployment
guard forbids a thin `sam deploy` over the live overlay Lambda in any case.
