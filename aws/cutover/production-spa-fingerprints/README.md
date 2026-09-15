Keep the reviewed M7.5A SPA live until the authenticated 1-cent dark wallet.fund test finishes.

Do not deploy another workstream SPA to s3://checksops-production-frontend-806168576068.

The CheckAlt #332 deploy at 2026-09-15T18:46:37Z overwrote index-Cn8LRzLU.js with index-DjRdsF7Y.js by setting CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK. That token is no longer accepted.

Required apply path:

  CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE \
  node scripts/deploy-production-spa.mjs --apply

The compiled dist must contain wallet.fund / moov-wallet-fund / wallet.disburse / moov-disburse and zero moov-transfer-create.
