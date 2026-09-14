# ChecksOps Integration validated baseline — 2026-09-14

**Workstream:** sole ChecksOps Integration & Release  
**This turn:** record live staging as the validated Integration baseline; put SQL 72/73 and their Git commits in the authoritative release lineage  
**Deploy this turn:** NO  
**Real SES this turn:** NO (final controlled endorsement email E2E is PASS and CLOSED; do not send again)  
**Provider execution:** remains fail-closed  
**Shared-staging freeze:** remains in effect for all non-Integration workstreams  
**Production / production-prep:** do not modify; record prep SHA drift only

This document is the **authoritative live-staging identity**. It supersedes the 2026-09-13 coherent report’s “NOT READY / SQL catalog unverified” verdict for live catalog status. The 2026-09-13 report remains the Git-merge record for `cursor/integration-coherent-ec26` at `3d0235c31`.

---

## Authoritative baseline identity (pin these)

| Surface | Identity | Notes |
|---|---|---|
| Lambda `checksops-staging-api` CodeSha256 | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` | Pin on **SHA**, not RevisionId. Env flips change RevisionId. |
| SPA `index.html` ETag | `113dfd26211290d0be78377d4b8e1ee2` | Bucket `checksops-staging-frontend-c48b`; CloudFront `E1CG52WRQZI7X1` |
| SQL 73 fingerprint | `d388bb4ec4a9cd6ee83d7e02e193b47c` | `md5(pg_get_functiondef)` of `aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid)` |
| SQL 72 fingerprint | `445994fc428e76a872899c37701cb590` | `md5(pg_get_functiondef)` of `aws_public_endorsement_by_token(text)` |
| Endorsement email E2E | **PASS and CLOSED** | Do not perform additional real endorsement email testing |

### Lambda composition (why live SHA is not a plain `git archive`)

Live CodeSha256 is the coherent Git zip `Wk5V+GVPry6FUpty7Jn21YZeQ62TMBXo4oDM0bj2IBI=` (built from `3d0235c31994493468c7aed732dc1125e501b617`) **plus** the surgical public-GET transaction patch from commit `320685542f070ba23ed8970d870f3eded590fd9a`.

After the authorized SES env flip/restore used by the closed E2E:

- RevisionId `dc0dc597-e8b7-435b-aff4-6906001b9dcf`
- LastModified `2026-09-14T00:54:33.000+0000`
- CodeSha256 still `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=`

Do **not** redeploy Lambda to “match Git.” Do not treat RevisionId as the pin.

### SPA (unchanged by SQL 72/73)

- `index.html` ETag `113dfd26211290d0be78377d4b8e1ee2`
- `index-a512Q1W0.js`
- `Endorse-CUIf-fxB.js`
- Last restored `2026-09-13T12:32:10Z`

### Environment (must keep)

| Flag | Value |
|---|---|
| `AWS_EMAIL_MODE` | `ses-identity` |
| `AWS_EMAIL_SES_LOCK_RECIPIENT` | `mcarletta@freedomadj.com` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| CheckAlt | disabled |
| Moov | disabled |

`ses-identity` never SendEmail. The closed E2E used one temporary `AWS_EMAIL_MODE=ses` flip then restore. Do **not** flip again.

### Database (staging RDS `checksops`)

| SQL | Staging | Git source | Notes |
|---|---|---|---|
| 29 `29_mortgage_ops_agent_access.sql` | **present** | coherent merge / #249 | Distinct from library 29 |
| 39 `39_detected_claim_number_grant.sql` | **present** | coherent merge / #264 | GRANT UPDATE (`detected_claim_number`) only; **no** amount UPDATE |
| 52 `52_mortgage_ops_staff_grants.sql` | **present** | coherent merge / #249 | |
| 69 `69_staging_homeowner_ledger_view.sql` | **present** | coherent file-select / #235 | |
| 71 `71_endorsement_email_audit.sql` | **present** | coherent merge / #255 | |
| 72 `72_public_endorsement_token_lookup.sql` | **present** | PR #289 `e34f6878c` | GET lookup RPC |
| 73 `73_public_endorsement_submit_payee.sql` | **present** | PR #289 `e7c7bfde3` | Submit signs matching payee in the same SECURITY DEFINER txn |
| 30 `30_tenant_documents_mortgage_doc_type.sql` | **intentionally unapplied** | coherent merge / #267 (code only) | Keep unapplied |

SQL 73 live function:

- `aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid)`
- owner `checksops_admin`
- SECURITY DEFINER, `search_path=public, pg_temp`, `row_security=off`
- `md5(pg_get_functiondef)` = `d388bb4ec4a9cd6ee83d7e02e193b47c`
- EXECUTE `{checksops, checksops_admin}`; PUBLIC EXECUTE false
- `checksops` has **no** table UPDATE on `check_payees`

Stable siblings (must remain unchanged by SQL 73):

| Function | md5 |
|---|---|
| GET `aws_public_endorsement_by_token` | `445994fc428e76a872899c37701cb590` |
| reject `aws_public_reject_endorsement` | `ab7190e3d7b9c092d436fc59fac45d07` |
| mark-sent `aws_mark_endorsement_request_sent` | `a69ab02bcc8432c8c1edc7021888d3b6` |
| SQL 71 submit body (rollback only) | `89d7c65888ee551fc2488fefdf6d287c` |

Do **not** rewrite historical SQL 71/72 in place. Do not GRANT public table UPDATE. Do not blindly reapply historical SQL 01.

---

## Authoritative Git lineage for the next coherent artifact

SQL 72/73 are **applied on staging** and **in Git** on `cursor/public-endorsement-rpc-ec26` (PR **#289**, base `cursor/integration-coherent-ec26`). They are **not** yet on `cursor/integration-coherent-ec26` HEAD `3d0235c31`. The next coherent artifact/release build **must merge PR #289** so this staging SQL is not staging-only.

| Commit | Full SHA | Role |
|---|---|---|
| Coherent Git HEAD (PR #282) | `3d0235c31994493468c7aed732dc1125e501b617` | Mailer, homeowner, mortgage, SQL 29/39/52/69/71 source, SPA |
| SQL 72 | `e34f6878cfed4ca422f6c0c2b073a0b35e3bb0d3` | `aws/workflows/sql/72_public_endorsement_token_lookup.sql` + PG16 tests |
| GET read-only txn | `320685542f070ba23ed8970d870f3eded590fd9a` | Public GET begins a txn so `SAVEPOINT` in `safeQuery` actually runs SQL 72. **This patch is in the live Lambda pin.** |
| SQL 73 + JS contract | `e7c7bfde3fc352e9d320a4570178cae27785a2c0` | `73_public_endorsement_submit_payee.sql` + rollback + tests + skip second public payee UPDATE |

PR: https://github.com/michaelcarletta-cmd/ChecksOps/pull/289

### Next Git-built zip recipe (do not execute this turn)

1. Start from `cursor/integration-coherent-ec26` at `3d0235c31`.
2. Merge `cursor/public-endorsement-rpc-ec26` (PR #289) so SQL 72, the GET txn, SQL 73, and the JS fail-closed skip are in the tree.
3. `git archive HEAD aws/functions/api` then `npm ci --omit=dev`. Do **not** reuse historical zip `node_modules`.
4. Preflight apply order on a disposable PG16 (already encoded in `aws/tests/coherent-sql-preflight-pg.test.mjs`): **29 → 52 → 39 → 69 → 71 → 72 → 73**; SQL **30 stays unapplied**.
5. Prove SQL 72 md5 `445994fc428e76a872899c37701cb590` and SQL 73 md5 `d388bb4ec4a9cd6ee83d7e02e193b47c`.

### Reproducibility gap (document, do not “fix” by deploying)

| Piece | Staging live | Git on PR #289 |
|---|---|---|
| SQL 72 | applied | yes |
| SQL 73 | applied | yes |
| GET read-only txn | in Lambda pin `OSiyHTQq…` | yes (`320685542`) |
| Skip second public payee UPDATE when RPC returns `payee_status=signed` | **not deployed** | yes (`e7c7bfde3`) |

Staging CTA submit works today because SQL 73 persists the matching payee inside the SECURITY DEFINER RPC; leftover JS `UPDATE public.check_payees` is RLS-denied (0 rows) and ignored. The next Git-built Lambda **must** include the JS contract so a future catalog without SQL 73 cannot return HTTP 200 with payee still pending.

---

## Closed endorsement email E2E (do not repeat)

Exactly one authorized send `2026-09-14T00:54:31Z`:

- Recipient `mcarletta@freedomadj.com`
- Check `SYN-SES73-CTA-1789347251854` amount `$12.73`
- SES MessageId `010001a09d6891d7-abf61698-cc38-4537-a960-d9d6dcb19b7b-000000`
- Replay `duplicate=true`, `reason=idempotent_replay`, same MessageId
- Public CTA loaded without login; UI sign succeeded; endorsement `signed` / `signature_method=portal`; associated payee `signed`
- GET consumed `token_consumed`; second submit `invalid_or_used_token`
- Cross-tenant denied; CC-117 PASS
- Env restored to `ses-identity`

Mailbox Outlook password wall remains **EXTERNAL_VERIFICATION_LIMITATION**, not an application P1.

---

## Production-prep (record only)

Do not touch `checksops-production-prep-api`.

Last recorded SHA: `ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=` (`LastModified` `2026-09-13T18:34:36Z`). Drift is from other writers, not this workstream.

---

## Deferred (not blocking this baseline)

- **P2** unknown-token GET still returns `token_consumed` because SQL 72 returns NULL for both never-valid and rotated consumed tokens. Distinguishing `invalid_link` vs `token_consumed` needs token history or stopping rotation. Do not remap GET missing without that.
- SQL 30 remains intentionally unapplied.
- Hosted tax containment, bank/Moov/CheckAlt execution, DynamoDB, production remain dark.

---

## Stop line

**PASS** live staging is the validated Integration baseline.  
**SQL 72 and SQL 73 are in Git (PR #289) and applied on staging.**  
**Do not deploy. Do not send real SES. Maintain the shared-staging freeze.**  
The next coherent artifact must include PR #289 so this state is fully reproducible from Git.
