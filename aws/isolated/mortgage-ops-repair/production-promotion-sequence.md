# Mortgage Ops production promotion — guarded sequence

This is preflight only. It does not write production. GATE4-B must stay
in_progress. Only a later workstream that is explicitly designated as the
release workstream may execute these writes.

## Stop rules

1. Fresh-read live Branding SPA pins. If they differ from
   `/assets/index-BgOCQCWm.js` +
   `7d65f3c16d638fb5b01b9333338040e0a082ab75c62d65f5bb21a891711f11bf` +
   index.html `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df` +
   S3 version `w6KPzOeYx631RcnJr9la9tTZ2_J3mSSd`, STOP.
2. Fresh-read `checksops-production-prep-api`. If CodeSha256 is not
   `nc1J1gjRR4GZinIJh/rNMpi/PXd3ZwqgoUSc9NRlwVg=` or LastModified is not
   `2026-10-02T20:26:42.000+0000`, STOP and recompose from the new live ZIP.
3. If live `workflow-rpc.mjs` no longer matches
   `afd8ac239ad60786e6ac54eac41595cb06a7cbc5de217ddcbbb82a210507cd87`, STOP.
4. Dedicated production SQL 39 inspect must run first. If the before
   snapshot is not the historical MHR overlay (or the analog staging-before
   hash `511955b6821b55225a019a0f60ccf783a285456b87f0c5987ee2174127f6da2d`),
   STOP. Do not apply SQL 39 over a newer production catalog.
5. Do not deploy `checksops-staging-guarded-sql-executor` to production.
   Do not restore origin/main SQL executor bytes.
6. Do not replace live `workflow-rpc.mjs` with the worktree subset.
7. Do not upload the staging Mortgage Ops SPA (`index-BcLmLtnF.js`,
   `moprRpr*`, `mopsRprD`, `sw.js`).
8. Do not change production Lambda environment variables.
9. Do not Complete GATE4-B.

## Sequence

1. Re-read live production SPA, Lambda, and SQL catalog immediately before
   any write (TOCTOU). Compare to this preflight.
2. Confirm release locks still record:
   - `database-rls` tree_hash `e3dfbb80a5502b331b096574b3d84fb27b864be38f86fc288b646e66f296e128`
   - `production-spa` live Branding pins above
3. Create a dedicated production inspect-only oneshot modeled on
   `checksops-prod-pr601-sql-inspect-a2a4`. It must set
   `default_transaction_read_only=on`, refuse caller SQL, and run
   `snapshotMortgageOpsState`. Record the before hash.
4. If inspect matches the expected historical baseline, apply only
   `aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql`
   (`c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f`)
   through a dedicated production apply oneshot that embeds that hash.
   Expected after analog: `4adc182c4ed13b11b37e8412056781112ea8f2a788bc1b51e21810460d13239b`.
   Re-inspect. Confirm #601 hashes `010a4501…` / `74a234df…` and Claim
   Ledger SQL43/SQL44 remain exact.
5. Compose the production Lambda ZIP from the then-current live ZIP:
   - add `mortgage-ops-usage.mjs` =
     `9856f51fa1a71a909689b7420001c6f7f4bb7eff3711ea4dedbefda6b68dadb2`
   - replace only `workflow-rpc.mjs` with the live file plus the
     SAVEPOINT + isolated-usage overlay
     (`635da37e3aaed8ed1b9551dc2fc5c76926e2fd708f37c66ef015cfd94d3aa654`
     if the live before-hash is still `afd8ac23…`)
   - keep every other member, including
     `tenant-billing-engine.mjs` `65b75735825f9a…`
6. Deploy that ZIP to `checksops-production-prep-api` through
   `scripts/deployment-guard` with `input.apply=true`, no caller
   `owned_member_ops`, and recorded contract results. Do not set
   production env flags.
7. Overlay the Branding SPA in place (`per_object_put`, no `s3 sync --delete`):
   - put `assets/MortgageOpsQueue-BD_nUT7A.js` first
     (`092057a7bb4c06844b061df806f0178449cfed3c6f42a7c63ad1849d010a7318`)
   - put `assets/index-BgOCQCWm.js`
     (`ae4ea2c96546b590f442fcff73d557e2ceafea25cb3ed2a51642948cbdad4190`)
   - do not rewrite `index.html` (it already points at Branding)
   - do not upload `sw.js`
   - invalidate CloudFront `E1B0ZWWO5559U5` for those two objects plus `/`
8. Candidate fingerprint for `scripts/production-deploy-guard.mjs` must
   set `based_on_baseline`, `preflight_production`, and `live_production`
   to the TOCTOU Branding pins. `deploy_mode=per_object_put`.
9. Re-read live fingerprints. Update the production-spa lock to the
   overlaid entry hash only after the write succeeds.
10. Mark SQL 39 `applied=true` / `applied_environment=production` only
    after the production inspect proves the after snapshot.

## Not this workstream

- Completing GATE4-B
- Writing production
- Replacing Branding with the staging Mortgage Ops SPA
- Broadening financial/provider flags


## Execution result (2026-10-03T10:46Z)

STOPPED after dedicated production inspect. SQL 39 / Lambda / SPA were
not written. See `production-promotion-stop-2026-10-03.json`.

## 2026-10-03T11:14Z Lambda+SPA promotion Gates 1-3

SQL remains the accepted post-transition catalog
`0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126`.
No further SQL is authorized.

Fresh live Lambda still `nc1J1gjRR4GZinIJh/rNMpi/PXd3ZwqgoUSc9NRlwVg=` /
`c8483271-f94e-4c76-aec4-05ac8707cc8a`. Candidate reconstructed from the
fresh live ZIP only: add `mortgage-ops-usage.mjs` `9856f51f…`, replace
`workflow-rpc.mjs` `afd8ac23…` → `635da37e…`. Candidate ZIP
`4b6095d23df359f61fc9f4af988ab46b13219d289bd549ed65956a3afcf105b7`.

Fresh live SPA still `/assets/index-BgOCQCWm.js` `7d65f3c1…` /
index VersionId `w6KPzOeYx631RcnJr9la9tTZ2_J3mSSd`. Forward-composed
queue `092057a7…` and entry `ae4ea2c9…`. `index.html` unchanged.
Branding repair and Homeowner `/h/ledger` routing are excluded.

Gate 4 contracts are next. No Lambda/SPA write until they pass.

## Gate 5 applied (2026-10-03T11:23:02Z)

Gates 1–4 passed. Guarded CAS/overlay applied Lambda, then official
production SPA writer applied queue + entry + identical `index.html`.

- Lambda after: `S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=` /
  `2f112f18-9055-4760-859d-62be8899b91f`
- SPA after: entry `ae4ea2c9…`, queue `092057a7…`, index VersionId
  `.Z.2EBH5QBbyDTgcLX9fSOPrcr5u8y5P`
- CloudFront: `I5XLBBM5QYJF5P3G3JKGGO1GPP` on `E1B0ZWWO5559U5`
- SQL / Cognito / provider flags / RLS / env vars: unchanged

Dedicated Mortgage Agent production acceptance is next. Mortgage Agent
Management/Compensation is not this workstream.
