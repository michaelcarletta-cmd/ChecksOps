# Collection V2 temporary UAT/inspector removal

SOURCE ONLY. Do not deploy. Do not write `checksops-staging-api`.
Do not touch production. Do not start Platform Finance. Do not reconcile the real $139.

## Fresh live starting fingerprint

Read 2026-10-05 against `checksops-staging-api`:

| Field | Value |
| --- | --- |
| CodeSha256 | `GnVu6M3syf8AcnQCXpQ8ONBvGH6k5Q07rkd4yVW1i7A=` |
| RevisionId | `c19a91f4-8935-4e51-8b43-a39b321f0ec3` |
| Members | 6488 |
| Live `index.mjs` | `9b26e9910e180cd516bab80a86909b98c40b13216f4ba97bb7023552410eddce` |
| Harness `tenant-collection-v2-uat.mjs` | `adf8f25053fbde1259c97add99f89005dfbcb09e4dae8577003f7959182c910e` |
| Inspector `tenant-maintenance-payments-catalog-inspect.mjs` | `4caa3728bb50c144f930d16b3392b8df624a0b9edf7b7ead5ee1a8511a982350` |

Any later drift is `DEPLOYMENT_COLLISION`. Stop.

## Forward-remove only

Start from the current live `index.mjs` composition. Do not revert it to an older branch copy.

Remove:

1. `tenant-collection-v2-uat.mjs`
2. `tenant-maintenance-payments-catalog-inspect.mjs`
3. Only their temporary import / `READ_ONLY_PATHS` / dispatcher wiring from `index.mjs`

Leave Collection V2 production-path members, Invoice Recovery members, and every unrelated ZIP member byte-identical.

## Proposed guarded overlay

Official apply, later authorization only:

1. Fresh-download current live ZIP (`origin=fresh-live-download`).
2. CAS CodeSha256 + RevisionId against this prepare fingerprint unless a later inspect updates it.
3. Overlay owned members:

```json
{
  "owned_members": [
    "index.mjs",
    "tenant-collection-v2-uat.mjs",
    "tenant-maintenance-payments-catalog-inspect.mjs"
  ],
  "owned_member_ops": {
    "replace": ["index.mjs"],
    "add": [],
    "remove": [
      "tenant-collection-v2-uat.mjs",
      "tenant-maintenance-payments-catalog-inspect.mjs"
    ]
  },
  "member_sources": {
    "index.mjs": "aws/functions/api/index.mjs"
  }
}
```

4. Candidate member count must be 6486.
5. Candidate `index.mjs` SHA-256 must be `8c2f9d459ed4f5fdd78255c018707a961855b8738e706bbc6903c2b823315117`.
6. Protected Collection V2 and Invoice Recovery hashes must match the live values in `collection-v2-uat-infra-remove-live.json`.

No SQL. No SQL 39 rollback. No grant changes. No SQL 40 changes.
No application environment change. No production.
