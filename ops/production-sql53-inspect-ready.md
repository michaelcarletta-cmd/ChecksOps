# Production SQL 53 inspect window (evaluate-only)

The guarded two-file overlay is live. This workstream prepares the one-time
authorization window and stops before configuration, IAM, or invoke.

## Live module (fresh-read 2026-10-10)

- Function: `checksops-production-prep-api`
- CodeSha256: `oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=`
- RevisionId: `534d4e36-0e62-461e-948e-e2bf00d3920e`
- Deployed inspect SHA-256: `4e356350e4abdf58fdb6ba3ab4e62efbe1aa21f7720a49f1f0128860870edb68`
- Live `CHECKSOPS_ENV=production-prep`
- Deployed module accepts `production` or `production-prep`
- Direct-invoke hook is present on live `index.mjs`
- No HTTP route
- Temporary SQL53 env vars are absent
- Secret host must bind `checksops-production` and end with `.rds.amazonaws.com`
- Catalog SQL is allowlisted and runs only inside `BEGIN READ ONLY`

`origin/main` still requires `CHECKSOPS_ENV=production`. The live overlay
module is the authority for this inspect.

## Token

A 43-character owner-chosen token was generated locally, mode `0600`, and
was not printed or committed. Recompute `CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT`
immediately before any later authorized configuration write. The window
must be RFC 3339 and no more than two hours. The published marker
`OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT` is refused.

## Exact temporary changes required later

1. Lambda configuration update with RevisionId CAS against the current
   live RevisionId. Send all 49 existing environment variables unchanged
   and add only:
   - `CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION`
   - `CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT`
2. Temporary IAM on a dedicated principal, not `ChecksOpsCursorCloudStaging`,
   limited to `checksops-production-prep-api`:
   - `lambda:GetFunction`
   - `lambda:GetFunctionConfiguration`
   - `lambda:UpdateFunctionConfiguration`
   - `lambda:InvokeFunction`
3. One direct invoke: `{ "diagnostic": "sql53-production-readonly-inspect", "authorization": "<token>" }`
4. Mandatory cleanup: remove both temporary env vars with RevisionId CAS,
   preserving the original 49 keys, and delete the temporary IAM.

## Blockers

- There is no official guarded Lambda configuration writer. The live AWS
  adapter refuses configuration mutation. Direct CLI configuration updates
  are forbidden.
- `ChecksOpsCursorCloudStaging` cannot list or change IAM and must not be
  broadened.
- This workstream does not authorize credentials, IAM, configuration, or
  invoke.

Verdict: live module is ready. Execute is not ready.
