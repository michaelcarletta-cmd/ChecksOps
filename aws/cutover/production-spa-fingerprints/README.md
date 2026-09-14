# Production SPA fingerprints

`node scripts/deploy-production-spa.mjs` records:

Git commit → SPA bundle hashes → Cognito pool/client → API target → timestamp

`latest.json` is written locally by that script and is not a deploy. S3/CloudFront
apply remains refused until the final cutover gate.
