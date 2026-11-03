// Test harness for the origin-verify Node 22 check (ops/security/NODE_RUNTIME_PLAN_2026_11.md, step 2).
// Usage: node ops/security/origin-verify-node22-harness.mjs <path to an unpacked authorizer.mjs>
// Drives the LIVE origin-verify handler (path in argv[2]) against a local fake Secrets Manager.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const livePath = process.argv[2];
let mode = 'ok'; let calls = 0;
const CURRENT = 'test-current-value-0123456789abcdef', NEXT = 'test-next-value-fedcba9876543210';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    calls += 1;
    const target = req.headers['x-amz-target'];
    const signed = /^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization || ''));
    if (mode === 'fail') { res.writeHead(500, { 'content-type': 'application/x-amz-json-1.1' }); return res.end('{"__type":"InternalServiceError","message":"x"}'); }
    if (target !== 'secretsmanager.GetSecretValue' || !signed || JSON.parse(body).SecretId !== 'checksops/production/cloudfront-origin-verify') {
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' }); return res.end('{"__type":"ValidationException","message":"unexpected request"}');
    }
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify({ ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:x', Name: 'x', SecretString: JSON.stringify({ current: CURRENT, next: NEXT }) }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = `http://127.0.0.1:${server.address().port}`;
process.env.AWS_REGION = 'us-east-1'; process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEEXAMPLE00'; process.env.AWS_SECRET_ACCESS_KEY = 'dummydummydummydummydummydummydummydummy';
const mod = await import(pathToFileURL(livePath).href);
const quiet = console.log; const logs = []; console.log = (s) => logs.push(s);
const ev = (headers) => ({ headers, requestContext: { requestId: 'r1', http: { requestId: 'r1' } } });
const cases = [
  ['current header', { 'x-checksops-origin-verify': CURRENT }],
  ['next header', { 'x-checksops-origin-verify': NEXT }],
  ['mixed-case name', { 'X-Checksops-Origin-Verify': CURRENT }],
  ['wrong header', { 'x-checksops-origin-verify': 'nope' }],
  ['missing header', {}],
];
const out = {};
for (const req of ['true', 'false']) {
  process.env.ORIGIN_VERIFY_REQUIRE = req; mod.resetSecretCacheForTests(); mode = 'ok'; calls = 0;
  for (const [name, h] of cases) out[`require=${req} ${name}`] = await mod.handler(ev(h));
  out[`require=${req} secret fetches for 5 calls (30s cache)`] = calls;
  mod.resetSecretCacheForTests(); mode = 'fail';
  out[`require=${req} secrets endpoint 500`] = await mod.handler(ev({ 'x-checksops-origin-verify': CURRENT }));
}
console.log = quiet;
out['log lines never contain the header values'] = logs.every((l) => !l.includes(CURRENT) && !l.includes(NEXT));
console.log(JSON.stringify({ node: process.version, out }, null, 1));
server.close();
