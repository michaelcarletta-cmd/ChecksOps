# Mortgage Ops production promotion — STOPPED

Authorized release started and stopped at the dedicated read-only
production SQL inspect. No SQL 39, Lambda, or SPA mutation was applied.

## What matched

Fresh TOCTOU of live production SPA and `checksops-production-prep-api`
matched the approved preflight pins exactly:

- SPA entry `/assets/index-BgOCQCWm.js`
  `7d65f3c16d638fb5b01b9333338040e0a082ab75c62d65f5bb21a891711f11bf`
- `index.html` `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df`
  version `w6KPzOeYx631RcnJr9la9tTZ2_J3mSSd`
- Lambda CodeSha256 `nc1J1gjRR4GZinIJh/rNMpi/PXd3ZwqgoUSc9NRlwVg=`
  RevisionId `c8483271-f94e-4c76-aec4-05ac8707cc8a`
- `workflow-rpc.mjs` `afd8ac239ad60786e6ac54eac41595cb06a7cbc5de217ddcbbb82a210507cd87`
- `mortgage-ops-usage.mjs` absent
- Production env/provider flags unchanged and unread-for-write

#601 and Claim Ledger remain exact after the inspect:

- `user_can_move_tenant_checks` `010a450154c4d0d97c4d5b4ab82858c83ab57a3044c9937d40dec86a6c7a749d`
- `admin_override_check_status` `74a234df30847cecab759c72d75fb7ced55ef6e0a0e3d7f86d78e51310ab84e5`
- SQL43 exact `31a3d2fb20033987a3bdde93f102573c36acc99ae3969e84ad4dc50c916f4806`
- SQL44 exact source `059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763`

## Why SQL 39 was not applied

Dedicated inspect oneshot `checksops-prod-mops-sql39-inspect-ad99`
(`default_transaction_read_only=on`, refuses caller SQL) returned:

- snapshot hash `9b428140630157a29f7f96f1f368d8eeb264aceaa764c0a214b5a3aa58538ee0`
- not the staging-before analog `511955b6821b55225a019a0f60ccf783a285456b87f0c5987ee2174127f6da2d`
- historical policy `aws_update_mortgage_handling_requests` is present
- SQL 39 policies and `aws_is_mortgage_ops_agent` are absent
- FORCE RLS is still false
- `checksops` already has table-level UPDATE on `mortgage_handling_requests`

The approved preflight expected `login_role_mhr_table_update: []`.
The dedicated apply path would then fail closed: SQL 39 does not REVOKE
that table-level UPDATE, and `handleMortgageOpsAcceptComplete` treats a
leftover login-role table UPDATE as `UNRELATED_MUTATION`.

Authority forbids reconciling that grant during this deployment.

## Not written

- SQL 39 `c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f`
- `checksops-production-prep-api`
- Branding SPA objects
- CloudFront
- Cognito
- production environment/provider flags
- GATE4-B Complete
