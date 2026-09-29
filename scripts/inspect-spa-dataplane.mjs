#!/usr/bin/env node
import fs from 'node:fs';

const inspect = (label, file) => {
  const text = fs.readFileSync(file, 'utf8');
  const apiFn = text.match(/function Nn\(\)\{const e="([^"]+)"/);
  const appUrl = text.match(/QA\("([^"]+)"\)/);
  return {
    label,
    file,
    awsApiBaseUrl_token: apiFn?.[1] || null,
    vite_app_url: appUrl?.[1] || null,
    isAwsStaging_cognito: /function pr\(\)\{return"cognito"\.toLowerCase\(\)==="cognito"\}/.test(text),
    staging_execute_api: text.includes('psr19uhop4'),
    staging_execute_api_url: text.includes('https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging'),
    production_raw_execute_api: text.includes('kiqojucc02'),
    staging_cognito_pool: text.includes('us-east-1_vPmQ7cL1F'),
    production_cognito_pool: text.includes('us-east-1_h00WorYMT'),
    staging_cognito_client: text.includes('71bb7a192cbl6o6s8m259tl589'),
    production_cognito_client: text.includes('3ja9fqaq2fjkv3i6up2varcqpe'),
    staging_app_url_baked: text.includes('QA("https://staging.checksops.com")'),
    production_app_url_baked: text.includes('QA("https://checksops.com")'),
    prep_resolver_present: text.includes('r==="/prep"||r==="same-origin"||r==="same-origin:/prep"'),
  };
};

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: inspect-spa-dataplane.mjs <js> [js...]');
  process.exit(2);
}
const rows = files.map((file, i) => inspect(`file${i}`, file));
console.log(JSON.stringify(rows, null, 2));
