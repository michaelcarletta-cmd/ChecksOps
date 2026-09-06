# T0 production AWS cutover

**Authorized:** 2026-09-06 after PRE-T0 GO.  
**T0 clock:** started immediately on authorization (not waiting for 20:00 UTC).

## Immediate pre-freeze check

**PASS** at 2026-09-06T11:44:56Z. Bridges healthy, Lovable still source, AWS healthy, all provider/financial flags OFF, DNS Lovable, rollback available.

## Write-freeze

This environment has **no Lovable application freeze control plane** (no freeze API, no Cloudflare/Lovable admin, `write-freeze-drill --freeze` is a refused drill). T0 capture started immediately to minimize source drift. Lovable remains writable until an operator freeze exists.

Bridges stay `read_only` / `sign_only`. Isolated T0 rehearsal DB is `checksops_rehearsal_20260906b`. Timed rehearsal `checksops_rehearsal_20260906` is not recreated. Live `checksops` overlay is gated (`confirmChecksopsOverlay` + isolated recon PASS) and skips `identity_accounts`.

## Isolated final DB delta

**PASS** at 2026-09-06T12:02:23Z on `checksops_rehearsal_20260906b` (template clone + live overlay).  
Counts, financial aggregates, PK fingerprints, membership, FKs, and required-null all matched production. Live `checksops` was not overwritten by this step. RDS `CreateDBSnapshot` is denied for this role; rollback remains Lovable + isolated rehearsal DBs.

Selected live counts: tenants 6, profiles 8, intake 194, endorsements 533, claims 183, deposit items 125, disbursement splits 117, ledger events 716.

## Holds

- Moov / CheckAlt / provider execution / financial grants stay OFF
- `64_financial_activation_grants.sql` not applied
- Both bridges kept
- PR #125 left open
