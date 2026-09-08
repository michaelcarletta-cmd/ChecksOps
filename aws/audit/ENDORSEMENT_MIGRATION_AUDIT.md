# Endorsement migration audit

This package compares endorsement/payee evidence in the original ChecksOps database with the migrated AWS database. It is read-only and does not send messages, create endorsement requests, or change check stages.

## Safety guarantees

- Both database sessions begin with `BEGIN READ ONLY`.
- The script verifies `transaction_read_only = on` before querying.
- Only non-secret operational columns are selected.
- Routing/account numbers, tokens, signature images, and document contents are not read or exported.
- Output is local CSV and JSON only.

## Prerequisites

Use the same approved Cursor environment and existing database connection variables used for the migration. Do not paste database URLs into chat or commit them.

Install the already-pinned API dependencies if needed:

```bash
npm --prefix aws/functions/api ci
```

Set the two connection variables from the existing migration credential sources:

```bash
export CHECKSOPS_SOURCE_DATABASE_URL='<original source database URL>'
export CHECKSOPS_TARGET_DATABASE_URL='<AWS database URL>'
```

Run:

```bash
node aws/audit/endorsement-migration-audit.mjs
```

The command writes:

- `endorsement-migration-audit.json`
- `endorsement-migration-audit.csv`

## Finding classes

| Classification | Meaning | Action |
| --- | --- | --- |
| `missing_signed_payee` | Source proves the missing payee had completed/waived endorsement | Restore relationship/status only after review; never resend |
| `missing_pending_payee` | Source contained the payee but no completed signature was found | Review, then restore without notification |
| `signed_status_regression` | Source says signed; AWS does not | Critical manual review before any workflow action |
| `target_only_payee` | AWS has a payee not found in the source snapshot | Review for legitimate post-copy additions |

Do not run a repair from the audit output automatically. Restoration is a separate reviewed operation.
