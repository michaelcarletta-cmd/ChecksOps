# SQL53 temporary-config workstream

Dedicated production inspection workstream
`prod-sql53-temporary-config-3bc9`. Preparation only. No apply, lease,
receipt, Lambda configuration change, invoke, SQL, or IAM change.

## SQL53_EXECUTION_READY: NO

## Official stable fingerprint

```json
{
  "function_name": "checksops-production-prep-api",
  "code_sha256": "oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=",
  "revision_id": "534d4e36-0e62-461e-948e-e2bf00d3920e",
  "configuration_sha256": "8a6ffde71f66390b27dc688e8276536bbbc37ffebcd9f756290ed2cde03a2a24"
}
```

Two consecutive official `--fingerprint-only` reads as
`ChecksOpsProductionSql53ConfigWriter/sql53-tmp-config-fp` produced that
identical hash. CodeSha256, RevisionId, and LastModified
`2026-10-10T18:26:47.000+0000` still match the approved baseline. SQL53
authorization variables remain absent.

## Staging acceptance

Non-inherited reference:

`prod-sql53-temporary-config-3bc9:acceptance:sql53-writer+sql53-readonly-inspect+tenant-isolation`

30/30 tests passed:
`sql53-temporary-lambda-config`, `sql53-production-readonly-inspect`,
and `tenant-isolation`.

## Prepared next apply steps

After owner execution approval for **this** workstream only:

1. Refresh official `--fingerprint-only`
2. Set `approval.approved=true` and `approval.workstream_id=prod-sql53-temporary-config-3bc9`
3. `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input ops/deployment-guard/production-sql53-temporary-config-manifest.json`
4. `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 node scripts/deployment-guard/sql53-temporary-lambda-config.mjs --apply`

Stop here until that execution approval exists.
