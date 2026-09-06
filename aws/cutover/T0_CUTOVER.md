# T0 production AWS cutover

**Authorized:** 2026-09-06 after PRE-T0 GO.  
**T0 clock:** started immediately on authorization (not waiting for 20:00 UTC).

## Immediate pre-freeze check

**PASS** at 2026-09-06T11:44:56Z. Bridges healthy, Lovable still source, AWS healthy, all provider/financial flags OFF, DNS Lovable, rollback available.

## Write-freeze

This environment has **no Lovable application freeze control plane** (no freeze API, no Cloudflare/Lovable admin, `write-freeze-drill --freeze` is a refused drill). T0 capture started immediately to minimize source drift. Lovable remains writable until an operator freeze exists.

Bridges stay `read_only` / `sign_only`. Live `checksops` is not overwritten by the isolated T0 rehearsal DB `checksops_rehearsal_20260906b`. Timed rehearsal `checksops_rehearsal_20260906` is not recreated.

## Holds

- Moov / CheckAlt / provider execution / financial grants stay OFF
- `64_financial_activation_grants.sql` not applied
- Both bridges kept
- PR #125 left open
