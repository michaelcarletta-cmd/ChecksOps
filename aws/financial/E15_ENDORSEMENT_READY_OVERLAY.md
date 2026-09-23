# E15 — Production code overlay (flag remains OFF)

Recorded 2026-09-23T01:35:48Z. **Code overlay only.** `AWS_ENDORSEMENT_AUTO_ADVANCE` stayed **false**. Brenda Wilcox was **not** mutated. No FinCapture, no Moov, no deposit approval.

## Pre-deploy fingerprint

| Item | Value |
| --- | --- |
| Function | `checksops-production-prep-api` |
| CodeSha256 | `fG/MT+D3Zolft+W94i/eW/uf1uEWIF3YaM4KtuorRCQ=` |
| LastModified | `2026-09-22T23:52:59.000+0000` |
| RevisionId | `23059a6c-e2d5-4407-860f-3026a43f30d5` |
| Env count | 41 |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` |

This matched the recorded E14C overlay. No intervening production code/env change. Staging-tested artifact remained `checksops-staging-api` CodeSha `5HCYMS5Mpa0jaekerlvZiWQGH+tccgl+K9zzXmdjGuU=` (2026-09-23T01:19:08Z).

## Artifact deployed

Exact staging-verified files from `cursor/checkalt-first-deposit-7084` @ `f0731c9fe` (hashes matched the live staging pack):

- `check-endorsement.mjs`
- `endorsement-payee-sync.mjs` (new)
- `write-check-workflow.mjs`
- `write.mjs`
- `documents.mjs`
- `endorsement-composite.mjs`
- `endorsement-completion.mjs`
- `endorsement-parity.mjs`

`UpdateFunctionCode` only. Environment was not written.

## Post-deploy fingerprint

| Item | Value |
| --- | --- |
| CodeSha256 | `mFOs4IbAzVHVwLsaG3PR6iHJhsI3FkbaviPMJMnmvmU=` |
| LastModified | `2026-09-23T01:35:48.000+0000` |
| Env count | 41 (identical key/value set) |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` |
| `AWS_CHECKALT_ENABLED` | `true` (unchanged) |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `true` (unchanged) |
| `AWS_MOOV_ENABLED` | `false` (unchanged) |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `false` (unchanged) |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` (unchanged) |

## Read-only verification

Brenda `f618a3ea-e995-449f-b53f-329c81a6dcbc` / `#1070668`:

- `status=endorsements_in_progress`, `check_stage=endorsing` (unchanged)
- `updated_at=2026-09-22T22:23:04.988Z` (unchanged)
- official rear still missing; payee Brenda still `pending`
- 22 endorsing checks; still 1 stuck (Brenda); 0 new Ready IDs
- `deposited_at` still null; no new `all_endorsements_complete` after overlay

Do **not** enable `AWS_ENDORSEMENT_AUTO_ADVANCE` without a separate approval.
