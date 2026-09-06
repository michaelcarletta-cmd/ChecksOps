#!/usr/bin/env node
/**
 * Attempt the apex/www DNS switch to production CloudFront.
 * Refuses without --confirm-t0-dns. If no Cloudflare/Route53 write path
 * exists, records DNS unchanged and keeps the Lovable rollback target.
 */
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const LOVABLE_IP = '185.158.133.1';
const CF_DOMAIN = 'dmgs35lzv89ms.cloudfront.net';

if (!process.argv.includes('--confirm-t0-dns')) {
  console.error(JSON.stringify({ error: 'refusing_dns_switch' }));
  process.exit(2);
}

const dig = (name) => execFileSync('dig', ['+short', 'A', name], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const apexBefore = dig('checksops.com');
const wwwBefore = dig('www.checksops.com');

const hasCloudflare = Boolean(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_TOKEN);
let hostedZones = [];
try {
  hostedZones = JSON.parse(execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', 'route53', 'list-hosted-zones'], { encoding: 'utf8' })).HostedZones || [];
} catch {
  hostedZones = [];
}
const checksopsZone = hostedZones.find((z) => /checksops\.com\.?$/i.test(z.Name || ''));

if (!hasCloudflare && !checksopsZone) {
  const report = {
    ok: false,
    switched: false,
    reason: 'no_dns_write_credentials',
    before: { apex: apexBefore, www: wwwBefore },
    after: { apex: dig('checksops.com'), www: dig('www.checksops.com') },
    rollbackTarget: LOVABLE_IP,
    intendedCloudFront: CF_DOMAIN,
    lovableStillSource: apexBefore.includes(LOVABLE_IP),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}

console.log(JSON.stringify({
  ok: false,
  switched: false,
  reason: 'dns_write_path_present_but_not_executed_without_operator_token_validation',
  before: { apex: apexBefore, www: wwwBefore },
  rollbackTarget: LOVABLE_IP,
}, null, 2));
process.exit(3);
