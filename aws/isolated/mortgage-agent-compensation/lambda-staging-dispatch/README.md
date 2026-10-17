# Staging Mortgage Agent Compensation dispatcher repair

Surgical guarded overlay against the current live staging Lambda
`checksops-staging-api`.

Starting authority:

* CodeSha256 `aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=`
* RevisionId `99a9dd03-e001-448f-8c18-7ba9f0e823e5`

The live ZIP already contains `mortgage-agent-compensation.mjs`. This workstream
registers that existing member in `app-services.mjs` only:

1. required import
2. `CLASS_A_FUNCTIONS` registration
3. switch/dispatcher case

It does not copy production `app-services.mjs` and does not replace the complete
staging ZIP. Official apply starts from the CURRENT live ZIP and replaces only
`app-services.mjs`.

The patched dispatcher is stored as a fixture derived from the live extract.
`apply-overlay.mjs` materializes it to `aws/functions/api/app-services.mjs` only
for the official writer confinement, then restores origin/main.
