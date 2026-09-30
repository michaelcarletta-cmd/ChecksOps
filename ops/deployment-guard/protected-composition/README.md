# Protected accepted composition

Repository + CI + deployment-gate protection for accepted production work.

Chat instructions are not the protection. A later Cursor chat with a stale
worktree, its own passing feature tests, or an old dist must not overwrite
accepted production behavior.

## Rule

Every production SPA promote must prove:

```
CURRENT LIVE PRODUCTION BASELINE
+ CANDIDATE DELTA
+ EVERY ENABLED PROTECTED COMPOSITION
```

Candidate branch HEAD is not equivalent to whole production source.

Absence from a candidate worktree does not authorize removal.

Hashed SPA filenames (`index-….js`) are acceptance evidence only.

## Registering a workstream

Add one JSON file here and list it in `registry.json`.

Do not fabricate a manifest unless that workstream has a known final accepted
contract. Signature, claim-number, OCR, billing, and Mortgage Ops can be
registered later the same way.

## Supersession

A future intentional change must:

1. name the `composition_id` being superseded
2. provide new acceptance evidence
3. pass replacement tests
4. update this manifest

A later deploy does not implicitly supersede accepted behavior.

## Official path

```
preflight (evaluateDeployment)
  → accepted-contracts
  → evaluateSpaPromote
      → restore/reclaim check (STALE_PACKAGE)
      → protected-composition
      → TOCTOU
  → signed receipt
production-spa-apply
  → re-read live fingerprint
  → PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED if changed
  → per-object put
```

Hashed SPA filenames are never a deploy identity.
