# Accepted Feature Registry

Evaluate-only semantic/source-composition layer. It does **not** replace
Release Locks or Deployment Guard, does not change deployment authority,
and does not block merge or deploy.

| Concern | Release Locks | Deployment Guard | Accepted Feature Registry |
|---|---|---|---|
| Protected-path hashes | authoritative | not used | not used |
| Shared-target deploy | fingerprint vs locked artifact | lease + live TOCTOU + overlay | evaluate-only findings only |
| Feature membership | implicit | `accepted_source_composition=true` boolean | explicit `feature_id` membership |
| Restore authority | locked SHA / tree hash | receipts + live pins | only `status=accepted` with `restore_authority=true` |
| Self-attestation `{ok:true}` | rejected for PRODUCTION_LOCKED | still accepted by some contracts | rejected |

## Safety

- `evaluate_only` is schema-locked to `true`.
- `enforcement.enabled`, `block_merge`, `block_deploy`, and
  `accept_self_attestation` are schema-locked to `false`.
- The CLI always exits `0`.
- `evaluateForDeployGuard()` is a non-enforcing integration point. Existing
  Deployment Guard writers do not import it.
- No GitHub workflow or required check is added.

## Statuses

| Status | Meaning | Eventually enforceable? |
|---|---|---|
| `accepted` | Reviewed source authority, invariants, and bound tests | yes, only after a later activation PR |
| `inventory_only` | Present on main; not asserted safe to enforce | no |
| `missing_from_main` | Named but absent from current main | no |
| `superseded` | Replaced by an explicit supersession record | no |
| `withdrawn` | Intentionally retired | no |

No feature is registered as `accepted` in this foundation.

A SHA that appears in inventory notes is **not** restore authority.

## Branding fixture

`branding` is the first semantic fixture. Current `origin/main` contains the
known #617 regression, so its status is `inventory_only` and the intended
invariants are expected to fail:

- Company Branding remains mounted
- tenant Email Branding is mounted
- tenant mount uses `showSendingDomain={false}`
- tenant Sending Subdomain controls remain hidden
- Admin Branding & Email remains present
- public Branding/logo paths use `src/lib/brandingPublicUrl.ts`

This PR does not repair Branding. The failing report is the control case.

## Forward-safe protection

Accepted features are protected by their required source paths, semantic invariants,
required tests, and explicit feature membership. A normal forward edit to a
registered file is allowed when those contracts still pass. File-byte differences
alone are not treated as stale source; this avoids freezing legitimate development
or encouraging rollback to an older file.

Changing the accepted contract itself (source paths, invariant definitions,
required tests, artifact types, or status) requires reviewed supersession once
enforcement is activated. Removing a required source path is a feature failure even
when another invariant still passes.

## Composition

Do not treat `accepted_source_composition=true` as membership.

Evaluate-only output reports:

- accepted features expected
- features actually present
- missing features
- superseded features
- failing invariants

## Supersession

An accepted feature may change only with an explicit `supersession_history`
record that names old authority, new authority, reason, approving
workstream, review PR, updated invariants/tests, timestamp, and commit.

A normal unrelated PR must not silently supersede an accepted feature.

## Commands

```bash
node scripts/validate-accepted-features.mjs --json
node --test aws/tests/accepted-features-registry.test.mjs
```

`--enforce` is ignored while this foundation is evaluate-only.

## Eventual activation

A later reviewed PR may promote individual features to `status=accepted`
only after:

1. invariants pass on the candidate source, not on a boolean;
2. every required test executes and binds its test path, `candidate_commit`,
   `exit_code`, and `output_sha256`; the candidate commit must match the
   composition being evaluated;
3. `restore_authority` is true only for that accepted SHA;
4. Release Locks and Deployment Guard remain unchanged in role;
5. a separate enforcement PR flips `evaluate_only` / `enforcement` after
   GitHub required-check review.

This README does not authorize that activation.
