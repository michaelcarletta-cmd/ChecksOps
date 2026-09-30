# Settings / billing / branding / deposits — staging-accepted source lock

This file records accepted behavior and provenance. It does **not** deploy,
associate any homeowner account, change configuration or provider flags,
initiate charges, move money, or send test client emails.

This file remains staging provenance. Production-locked deployed-code evidence
is recorded in
`ops/release-locks/proof/settings-billing-branding-deposits-production-apply.md`.
This lock does not lift the hold for item #3 (homeowner Moov association).
Authenticated user acceptance remains **NOT ESTABLISHED**.

## Source SHAs

| Identity | SHA |
|---|---|
| Application candidate (items #1, #2, #5) | `17fa334d69fb9ca673bcde462b5bb0632e42f3dc` |
| Deployment-tooling / SPA preflight composition fix | `6059f03918cdba8858ad53a512aa030051bffb11` |
| Live production SPA source lineage (WalletOps Item #4) | `338ede0e6313bfcf88feac36101d67a20c756fd9` |
| Workstream | `settings-billing-branding-deposits-51c8` |

Future builds must start from **current live source**, not from these historical
artifact hashes. The SHAs above are provenance. They are not rollback targets.

## Accepted staging SPA

Documented staging acceptance for the composed candidate:

| Field | Value |
|---|---|
| Host | `https://staging.checksops.com/` |
| Entry | `/assets/index-CEKjixtZ.js` |
| Entry SHA256 | `bd36849ef6b63f2d10b03225f2796427440baddd9c9caf508eff76ba2bc18fae` |
| index.html SHA256 | `bd9cb1cb5d8d76e3979d96101d0cfae5578beaeaadcd1670ebc2e9176a0fa6ee` |
| Invalidation | `I9YHW13PUL6USXM8D5QRO07W1X` |
| Isolated HTTP login | `NOT ESTABLISHED` |

Staging Lambda reuse (not a production restore target):
`//BfiiKna/KRIuX8NEPipSyagIVFxM/5BY7nTaT7OUs=` /
`3698b6c6-3d83-444b-ace3-0eb80e362adc`.

Authenticated user acceptance is **not** claimed. This is deployed-code /
bundle verification plus staging host confirmation.

## Reviewed production baseline at lock time (do not restore over newer work)

| Surface | Identity |
|---|---|
| Production SPA entry | `/assets/index-C_fh5VBD.js` |
| Production SPA JS SHA256 | `a357373bef9e41b004f887ee312ca239f64236706c826afb69400312e6fbad22` |
| Production index.html SHA256 | `d0d59415d6692713f73b8edabefec10a261f1b7a85d6f4a6abd719f9011b3eb4` |
| Production S3 version | `VrLJwkt.ge_P4S2pjYAX5YX_uAoP8A6F` |
| Production Lambda | `checksops-production-prep-api` |
| Production CodeSha256 | `pxZj4G6pGntJrkcRO5uNNEbiyvDpCOKPiWAboDnPvBA=` |
| Production RevisionId | `3bccd144-4e61-422f-8151-9ed0fe713aac` |

If live fingerprints differ from this reviewed baseline immediately before
apply: **stop**. Do not restore an older SPA or Lambda package over newer work.

## Accepted behavior (regression checks)

- Company branding invoice accent color remains editable (`invoice_accent_color`)
- Email sender settings remain Class A sender-identity UI (no sending-subdomain UI)
- Bank deposit reconciliation keeps rejected/returned/error/declined exclusion
- Stakeholder account settings distinguish Bank verified vs Provider linked
- Tenant billing account panel remains part of the composed settings surface
- Official SPA preflight CLI forwards `accepted_source_composition` and does
  not infer acceptance from `accepted_composition` alone
- Composition evidence never grants production approval
- WalletOps Item #4 remains: hide Payment Account / Payout Preferences; keep
  “Go to Payment Account”
- Signature, Claim Ledger, OCR, and other independent fixes remain untouched
  by this ownership group

## Reconcile-with-live-source rule

A later build must compose these settings/billing/branding/deposit fixes onto
**current live** production source. Do not promote unreconciled `main`. Do not
promote wholesale staging SPA bundles (`index-DvVldu_B.js` or later uncomposed
staging entries). Do not restore `index-BPbQUNFr.js`, `index-C9QrEEkl.js`,
`index-C_fh5VBD.js` after a newer accepted live identity exists, or any other
historical pin.

Stop on:

1. Live fingerprint drift vs the reviewed-or-newer accepted baseline
2. Missing accepted invariants
3. Source conflicts on shared files
4. Attempts to restore a historical SPA or Lambda package

## Owned Lambda overlay members (evaluate/apply overlay-only)

- `app-services.mjs`
- `tenant-settings-handlers.mjs`
- `tenant-email-domain-handlers.mjs` (tenant-email still owns the path)
- `providers/parity/moov-functions.mjs`
- `providers/parity/moov-stakeholder-status.mjs`

Preserve production `esign.mjs` and every unrelated live member.

## Item #3 (not recorded as fixed)

Read-only homeowner Moov lookup remains unfixed. This lock does not authorize
association, relink, or override.
