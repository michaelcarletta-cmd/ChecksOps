export const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
export const PROBE_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';
export const PROBE_EMAIL = 'staging-identity-probe-c48b@checksops.invalid';
export const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
export const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';

export const LIFECYCLE_EMAILS = {
  freedom: 'checksops-tester@freedomadj.com',
  c1c: 'payments@condition1commercial.com',
};

export const COGNITO_POOLS = {
  staging: 'us-east-1_vPmQ7cL1F',
  production: 'us-east-1_h00WorYMT',
};

// Live dual-environment mappings for fixture/tests only. Runtime resolution
// does not import these values. claims@ remains a separate application user
// and is intentionally omitted from this dual-env list.
export const EXPECTED_DUAL_ENV_IDENTITIES = [
  {
    email: 'mcarletta@freedomadj.com',
    applicationUserId: '7dbb3009-f059-4767-b5dc-1c5c72379330',
    stagingCognitoSub: 'c4386408-60e1-70e2-abb6-e6194e8e635f',
    productionCognitoSub: 'a45884b8-d051-70b3-b19d-ca704964c6e8',
  },
];

// Historical onboard snapshot used by cutover/onboard scripts. Live dual-env
// mappings (staging vs production Cognito) live in EXPECTED_DUAL_ENV_IDENTITIES.
export const EXPECTED_EIGHT = [
  {
    email: 'asukanick@condition1commercial.com',
    applicationUserId: '3af0234c-de1b-4819-938d-fa4f9390811b',
    cognitoSub: '84185468-a041-70e7-6f61-c6c63f4aff19',
    appRole: 'admin',
    tenantSlug: 'c1c',
  },
  {
    email: 'barzziniconstructiongroup@gmail.com',
    applicationUserId: 'e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd',
    cognitoSub: '34a8e428-6071-70b2-92de-fc7e3fd74f14',
    appRole: 'admin',
    tenantSlug: 'barzziniconstruction',
  },
  {
    email: 'checksops-tester@freedomadj.com',
    applicationUserId: TESTER_ID,
    cognitoSub: '04d85458-1041-7017-a8e8-b2f3f0a5b75b',
    appRole: 'staff',
    tenantSlug: 'freedom',
  },
  {
    email: 'claims@freedomadj.com',
    applicationUserId: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
    cognitoSub: '2498c4b8-f0a1-701b-da4b-a1f5c79f675a',
    appRole: 'mortgage_agent',
    tenantSlug: null,
  },
  {
    email: 'lhogan@condition1commercial.com',
    applicationUserId: '0160a5f3-30a4-4aba-8e54-6529f1ceb0d4',
    cognitoSub: '5458c4f8-1081-701d-10cf-02a993311263',
    appRole: 'admin',
    tenantSlug: 'c1c',
  },
  {
    email: 'mcarletta@freedomadj.com',
    applicationUserId: '7dbb3009-f059-4767-b5dc-1c5c72379330',
    cognitoSub: 'c4386408-60e1-70e2-abb6-e6194e8e635f',
    appRole: 'admin',
    tenantSlug: 'freedom',
  },
  {
    email: 'payments@condition1commercial.com',
    applicationUserId: C1C_ADMIN_ID,
    cognitoSub: 'e418f488-4011-7046-5a09-3f8b51140899',
    appRole: 'admin',
    tenantSlug: 'c1c',
  },
  {
    email: 'support@homeheropros.com',
    applicationUserId: '30d0505c-bcfa-4732-81fd-869dc46da5dd',
    cognitoSub: '14187428-90d1-70f2-95f3-10844b186461',
    appRole: 'admin',
    tenantSlug: 'homehero',
  },
];

export const redactSecrets = (value) => {
  const secretKeys = /^(password|newpassword|oldpassword|temporarypassword|confirmationcode|code|accessToken|idToken|refreshToken|token|authorization|secret|secretstring)$/i;
  const jwtLike = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const walk = (input) => {
    if (typeof input === 'string') {
      if (jwtLike.test(input)) return '[redacted-jwt]';
      return input;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(input)) {
        out[key] = secretKeys.test(key) ? '[redacted]' : walk(val);
      }
      return out;
    }
    return input;
  };
  return walk(value);
};

export const jwtClaimsSafe = (token) => {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return { error: 'malformed' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      sub: payload.sub || null,
      aud: payload.aud || null,
      iss: payload.iss || null,
      tokenUse: payload.token_use || payload.tokenUse || null,
      clientId: payload.client_id || payload.aud || null,
      exp: payload.exp || null,
      iat: payload.iat || null,
      email: payload.email || null,
    };
  } catch {
    return { error: 'malformed' };
  }
};
