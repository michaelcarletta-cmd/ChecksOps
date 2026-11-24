# Production check endorsement state inspect (read-only)

`scripts/deployment-guard/check-endorsement-state-inspect.mjs --inspect --check-id <uuid>`
answers one question about one production check, without changing anything:

> This check's endorsements are signed. Why did it not advance to ready for deposit, and why is
> there no endorsed back image?

Owner report 2026-11-24: a check for $5542 received all endorsements but did not move to ready for
deposit, and its deposit image section shows no endorsed back image. The owner approved "1 and 3";
step 1 is this read-only look at that one check.

When the last endorsement is signed, `finalizeEndorsementState`
(`aws/functions/api/check-endorsement.mjs`) evaluates the endorsements, rebuilds the official
rear (`compositeEndorsementSignatures`, `aws/functions/api/endorsement-composite.mjs`) and only
then, if the official rear is ready, advances the check (`applyAutoAdvanceIfEligible`). Any of
several conditions stops it. This tool reads the rows those functions read and runs the
functions' own pure decisions on them (imported from the Lambda modules, not re-implemented).

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in `ops/deployment-guard/check-endorsement-state-inspect.json`
names the same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## What it reads

One `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s statement
timeout and a 2 s lock timeout. Inside it, only the fixed statements in `Q`
(`lib/check-endorsement-state-inspect.mjs`); the check id is the only input and is always a bound
parameter. A statement whose columns are missing is reported as
`{ "read": false, "reason": "columns_missing:…" }` and the others still run. An unknown check id
reads nothing but the check row.

| statement | reads | mirrors |
|---|---|---|
| `check` | the check row, reduced in SQL to `id`, `tenant_id`, `status`, `check_stage`, `deposited_at`, `deposit_recommendation`, the four image columns that exist, `endorsement_render_meta`, `endorsement_render_status` | `loadCheckForEndorsement`, the composite's check SELECT |
| `completion` | `status, payee_type` of the check's endorsements | `evaluateCompletionState`, verbatim |
| `endorsements` | `payee_type`, `status`, `signature_method` and a class of `signature_image_url` / the payee's `endorsement_image_path` (`data:image/`, `''`, `other` or NULL), in the composite's order | the composite's endorsement SELECT |
| `deposits` | the check's CheckAlt deposits, reduced to what `pickBlockingDeposit` reads | `loadDepositsForCheck` |
| `compositeAudits` | the path keys of the last 25 `endorsement_signatures_composited` audit rows | `loadCompositeAudits` |
| `eligibilityPayees`, `eligibilityEndorsements` | only when `back_image_deposit_path` is a CheckAlt artifact | `reuseExistingOfficialRear`'s loaders, verbatim |
| `events` | `event_type, created_at` of the check's 20 latest `check_audit_log` rows (no `event_data`) | |

The signature values never leave the database. Image paths and audit paths are read for the
recovery decision and never printed.

## What it prints

Labels and booleans only: no id, name, email, amount, image path, token or signature data.

| section | content |
|---|---|
| `check` | `status`, `check_stage`, `deposit_recommendation`, `endorsement_render_status`; `deposited_at_set`; `status_in_ineligible_auto_advance_statuses`; `ineligible_for_auto_advance`; `active_loss_draft` (`isActiveLossDraft`); `ready_transition` (`decideReadyTransition`); what `endorsement_render_meta` holds (booleans) |
| `images` | for `back_image_path`, `back_image_original_path`, `back_image_deposit_path`, `endorsed_back_image_path`: `column_exists`, `present`, `clean_raster_original`, `endorsed_artifact`, `checkalt_artifact` (`isCleanRasterOriginalPath`, `isEndorsedArtifactPath`, `isCheckAltArtifactPath`) |
| `endorsements` | per row: `index`, `payee_type`, `status`, `signature_method`, `signature_image_url_present`, `endorsement_image_path_present`, `has_usable_drawn_ink`, `is_exception_completion`, `satisfied`, `blocks_composite` |
| `completion` | `allSigned`, `anyRejected` (`evaluateEndorsementCompletion`) |
| `deposits`, `historical_deposit_locked` | deposit count, the blocking row's status, and `isHistoricalCheckLocked` |
| `recovery` | `recoverTrustedOriginalBackPath`: `{ ok, error, source }`, see S3 below |
| `official_rear` | whether the stored official rear could be reused (`reuseExistingOfficialRear`, the non-signing path) |
| `prediction` | `predicted_blocker`, every `blockers` entry, `possible_blockers`, `undetermined` |
| `recent_events` | `event_type`, `created_at`, newest first, at most 20 |

### Blockers, in the order `finalizeEndorsementState` meets them

| blocker | meaning |
|---|---|
| `check_not_found` | no check with that id |
| `ineligible_status` | status in `INELIGIBLE_AUTO_ADVANCE_STATUSES` or `deposited_at` set: finalize returns `skipped_ineligible` |
| `any_rejected` | an endorsement is rejected: the check goes back to review |
| `not_all_signed` | not every endorsement is satisfied (a contractor is a required signer) |
| `historical_deposit_locked` | a historical status, `deposited_at`, or a CheckAlt deposit that blocks a new one: no re-composite |
| `original_back_missing`, `original_back_ambiguous` | no trusted clean original rear can be recovered |
| `signature_image_missing` | a signed, non-exception endorsement has no drawn ink |
| `loss_draft_hold` | an active loss draft (status or stage): the advance is held |
| `none` | nothing the database shows would stop it |
| `undetermined` | no determined blocker, but a database-side check could not be decided (see `undetermined` and `possible_blockers`) |

`predicted_blocker` is the first determined blocker. When the original-back recovery is
undetermined, its possible outcomes are in `possible_blockers`; in the real run it is met before
`signature_image_missing` and `loss_draft_hold`.

`undetermined` always also names two things no database read shows: the Lambda's
`AWS_ENDORSEMENT_AUTO_ADVANCE` flag (when it is not `true`, nothing advances) and the composite's
download, render and upload of the rear image (S3).

### S3

The composite's recovery checks that candidate originals exist in S3. The SQL53 runner's role
reads the transfer bucket and the admin secret; it has no access to the check image bucket and
no `FILES_BUCKET`, so the tool makes **no S3 call**. It runs `recoverTrustedOriginalBackPath`
twice instead, once with every object absent and once with every object present. When both agree
(or no existence check was needed, for example a clean `back_image_original_path`), `determined`
is `true` and the answer is exact. Otherwise `determined` is `false`, `s3` is `skipped`, and both
outcomes are printed.

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main, and only with the owner's go for this run.
The owner gives the check id; it is the only argument.

1. Stage main: dispatch `.github/workflows/sql53-temporary-transfer.yml` on `main`. When its
   `upload` job has finished, copy `SOURCE_COMMIT` and `TARBALL_SHA256` from the `package` job log.
2. Check the runner: `i-0c35557c4e5385406` (`checksops-sql53-temporary-runner`, profile
   `ChecksOpsSql53TemporaryRunner`) is `stopped` and has no SSM command in progress. Start it, wait
   for `running`, then for SSM `PingStatus` `Online`.
3. Send one SSM `AWS-RunShellScript` command:

   ```bash
   set -euo pipefail
   SHA=<full main sha>
   TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
   CHECK_ID=<the check's uuid>
   WORK=$(mktemp -d /var/tmp/check-endorsement-state-inspect-XXXXXX)
   trap 'cd / && rm -rf "$WORK"' EXIT
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/check-endorsement-state-inspect.mjs --inspect --check-id "${CHECK_ID}"
   ```

   The tarball carries `aws/functions/api/node_modules` (the transfer workflow's `npm ci`), which
   the tool needs because it imports the Lambda modules' decisions.

4. Stop the runner and wait for `stopped`, whatever the result.
5. Record the date, SSM command id, source commit and the answer in `production_inspect` of the
   configuration file, in a reviewed change. Do not record the check id in a public place beyond
   what the owner asks for.

## Reading the answer

- `signature_image_missing`: a payee is `signed` without drawn ink (a typed signature through the
  portal). The composite refuses, so there is no endorsed rear and no advance.
- `original_back_missing` / `original_back_ambiguous` (or `possible_blockers` with them): the
  check has no trusted clean original rear (`images` shows which columns hold endorsed or CheckAlt
  artifacts instead).
- `historical_deposit_locked` / `ineligible_status`: the check is past the point where the
  composite or the advance runs.
- `loss_draft_hold`: an active loss draft holds the advance by design.
- `none`: the database shows nothing that stops it; look at the Lambda's auto-advance flag and
  at the composite's S3 download, render and upload (`recent_events` shows whether an
  `endorsement_signatures_composited` or `all_endorsements_complete` event was ever written).

What to do about any of these is the owner's decision; this tool changes nothing.

## Staging

This change adds no staging tool. The tests run the same statements on PostgreSQL 16
(`aws/tests/check-endorsement-state-inspect.test.mjs`).
