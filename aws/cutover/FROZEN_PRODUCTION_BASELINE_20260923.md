# Frozen production baseline — 2026-09-23

These identifiers are the accepted production baseline for CLOSED
components. Do not reopen, redesign, rebuild, or roll them backward.
A CLOSED component may be reopened only for a concrete current
production regression in that component.

## Accepted identifiers

| Item | Value |
|---|---|
| Git SHA | `707f4f5092b3ac8cd81b113ae36fbef72250ed39` |
| Production Lambda | `checksops-production-prep-api` |
| Accepted Lambda CodeSha256 | `pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=` |
| Accepted Lambda LastModified | `2026-09-23T12:29:41.000+0000` |
| Accepted production SPA | `index-BR49bZTp.js` |
| Accepted SQL | `71_staging_public_workflow_grants.sql` with additive 3-argument `aws_public_homeowner_ledger_upload_insert(text,text,text)` while preserving the existing 4-argument overload |

Live confirmation on 2026-09-23 (this run): Lambda SHA/LastModified and SPA `index-BR49bZTp.js` still match. Both SQL overloads remain present. Money flags untouched.

## CLOSED / PRODUCTION COMPLETE

1. AWS Cognito production foundation
2. AWS `/prep` API foundation
3. RDS/S3 production foundation
4. OCR / AWS Textract
5. Tenant branding / public assets
6. Public Sign
7. Public Endorse
8. Homeowner upload
9. Ledger / tracking
10. Token/storage/tenant isolation for those public workflows

Preserve existing production work already completed elsewhere, including
Manager / Partners / Bank Deposits / WalletOps. Do not broadly retest
those systems without evidence of regression.

## Forward-only rule

Current production + accepted next delta = new production baseline.

Never: old staging snapshot → overwrite current production.
Never roll production backward to make hashes match.

## Explicitly out of scope here

- CheckAlt E14 / deposit execution (separate workstream)
- Moov redesign or Moov flag changes
- Real money movement
