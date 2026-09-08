import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const design = fs.readFileSync(
  path.join(ROOT, 'aws/cutover/API_BEHIND_CLOUDFRONT_DESIGN.md'),
  'utf8',
);

test('API-behind-CloudFront design is review-only and does not deploy', () => {
  assert.match(design, /DO NOT DEPLOY FROM THIS DOCUMENT/);
  assert.match(design, /STOP FOR REVIEW/);
  assert.match(design, /DisableExecuteApiEndpoint/);
  assert.match(design, /Do \*\*not\*\* set `DisableExecuteApiEndpoint=true`/);
  assert.doesNotMatch(design, /aws cloudfront update-distribution/);
  assert.doesNotMatch(design, /aws apigatewayv2 update-api/);
  assert.match(design, /kiqojucc02/);
  assert.match(design, /E1B0ZWWO5559U5/);
  assert.match(design, /AllViewerExceptHostHeader/);
  assert.match(design, /CachingDisabled/);
  assert.match(design, /\/prep\/\*/);
  assert.match(design, /\*\*Do not\*\* map `\/auth\*`, `\/storage\*`, or `\/public\*`/);
  assert.match(design, /CustomErrorResponses|custom errors/);
  assert.match(design, /x-checksops-origin-verify/);
  assert.match(design, /never `VITE_\*`/);
  assert.match(design, /64_financial_activation_grants\.sql/);
  assert.match(design, /NOT_APPLIED/);
  assert.match(design, /ChecksOpsCursorCloudStaging/);
  assert.match(design, /Do not add this work to `ChecksOpsCursorCloudStaging`/);
  assert.match(design, /Do \*\*not\*\* convert HTTP API `kiqojucc02` to REST/);
  assert.match(design, /productionExecution=false/);
});
