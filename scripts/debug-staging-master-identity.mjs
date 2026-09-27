import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole, masterToken } from './cognito-staging-token.mjs';

const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';

const claimsOf = (token) => {
  const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  return {
    sub: payload.sub || null,
    email: payload.email || null,
    token_use: payload.token_use || null,
    cognito_username: payload['cognito:username'] || null,
    aud: payload.aud || null,
  };
};

const main = async () => {
  await assumeCursorRole('moov-billing-identity-debug');
  const minted = await masterToken();
  const token = minted.authentication?.IdToken;
  const claims = token ? claimsOf(token) : null;
  const res = await fetch(`${API}/identity/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  const report = {
    minted: minted.ok,
    source: minted.source || null,
    claims,
    identityHttp: res.status,
    identity: {
      ok: data.ok,
      error: data.error || null,
      applicationUserId: data.applicationUserId || null,
      isMasterOwner: data.isMasterOwner ?? null,
      profileEmail: data.profile?.email || null,
      mappingStatus: data.mappingStatus || null,
    },
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/staging-master-identity.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
