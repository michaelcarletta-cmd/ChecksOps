Keep the reviewed M7.5B.7 money-test SPA live until the existing held $0.01
intent (`257b6033-eac0-4555-877e-a8cb4f801c8f`) is dark-continued.

Do not deploy another workstream SPA to s3://checksops-production-frontend-806168576068.
Do not CheckAlt SPA deploy. Do not raw `aws s3 sync`. Do not restore the
`index-DjRdsF7Y.js` / RELEASE_CUTOVER_LOCK fingerprint.

The CheckAlt #332 deploy at 2026-09-15T18:46:37Z overwrote index-Cn8LRzLU.js with index-DjRdsF7Y.js by setting CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK. That token is no longer accepted. A later overwrite at 2026-09-16T11:47:34Z put index-DjRdsF7Y.js back; M7.5B.7 restores the money-test SPA.

Required apply path (role ChecksOpsProductionSpaDeploy only):

  CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE \
    node scripts/deploy-production-spa.mjs --apply

Emergency restore of the last known-good Cognito SPA already in the
production bucket (`index-C_NPDCdc.js`). Does not rebuild. Uploads only
the matching `index.html`. Do not raw-sync unrelated files.

  CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE \
    node scripts/deploy-production-spa.mjs --rollback-known-good --apply

New production builds must also pass the hardened auth/API gate before apply:
Cognito mode, production pool/client, `/prep`, no blank Supabase `createClient`, and a bootable `/freedom/login` marker. The deploy script writes a gitignored `.env.aws.local` and injects those Vite values for `vite build --mode aws`. `vite.config.ts` awsMode `define` bakes non-empty values from `process.env` (no hardcoded production pool/client defaults). Known-good rollback does not rebuild.

The compiled dist must contain wallet.fund / moov-wallet-fund / wallet.disburse / moov-disburse / Authorize held $0.01 fund and zero moov-transfer-create.
