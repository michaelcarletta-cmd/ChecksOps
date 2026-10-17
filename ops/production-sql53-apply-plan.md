# SQL53 guarded apply plan

Evaluate-only preparation for `lambda-sql53-temporary-config`. No production
lease, receipt, Lambda configuration change, diagnostic invoke, or SQL was
performed.

## SQL53_GUARDED_APPLY_READY: NO

## Live fingerprints

CodeSha256 and RevisionId still match the prior official pin:

- CodeSha256: `oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=`
- RevisionId: `534d4e36-0e62-461e-948e-e2bf00d3920e`
- LastModified: `2026-10-10T18:26:47.000+0000`

The prior configuration SHA256
`e8da3b0605848139ed780d7d0f358fc70e358761e75381a6c7ca38ba3253222b` is
request-scoped AWS SDK `$metadata` and must not be used for CAS. After
excluding `$metadata`, official consecutive reads hash identically to
`8a6ffde71f66390b27dc688e8276536bbbc37ffebcd9f756290ed2cde03a2a24`. SQL53
authorization environment variables remain absent. `CHECKSOPS_ENV` remains
`production-prep`.

## Required production approval

`evaluateProductionGate` requires all of:

- `approval.approved === true`
- `approval.workstream_id` equal to the **apply** workstream (not this plan,
  not `prod-sql53-overlay-prep-3bc9`, not `prod-sql53-fingerprint-3bc9`)
- `approval.inherited` and `approval.from_previous_workstream` must not be true
- `staging_acceptance.ok === true` plus a non-inherited `reference`
- `production_fingerprint` and `immediately_before_fingerprint` equal the
  signed `preflight_live_fingerprint`

## Receipt and exclusive lease

A later authorized apply must use:

```bash
node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest.json>
```

The expired overlay lease on `production::checksops-production-prep-api` may
be replaced then. The overlay receipt is expired, consumed, and the wrong
deployment type. `--skip-contracts` does not work; include executed
`contract_results.tenant-isolation`. Hand-written receipt JSON is
`RECEIPT_FORGED`.

## Temporary authorization and cleanup

The official writer adds only
`CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION` and
`CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT`, generates the token itself,
invokes `{diagnostic, authorization}`, and deletes those two keys in
`finally` using the latest RevisionId. Caller-supplied env or payload is
refused. Default window is five minutes; maximum is two hours.

## Diagnostic is read-only

The live overlay module accepts `production` and `production-prep`, refuses
HTTP events, allowlists only `BEGIN READ ONLY`, `ROLLBACK`, the identity
probe, and three catalog SELECTs, and refuses privileged users, non-production
RDS hosts, and writable transactions. Main-source inspect still requires
`CHECKSOPS_ENV=production`; do not overlay it over the live module.

## Exact next authorized action

Owner authorize a **new apply workstream** with matching
`approval.workstream_id` and a non-inherited staging acceptance reference.
Then fingerprint-only, then `preflight.mjs --acquire-lease --receipt`, then
later guarded `--apply` as `ChecksOpsProductionSql53ConfigWriter`.
