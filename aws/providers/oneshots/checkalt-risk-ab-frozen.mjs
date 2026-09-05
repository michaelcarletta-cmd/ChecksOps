#!/usr/bin/env node
/**
 * Frozen-byte CheckAlt UAT risk A/B diagnostic.
 * Uses EXACT improved outbound JPEGs already on disk (no regenerate/alter).
 * Runs performRiskAssessment true then false with identical Base64 strings.
 * Never prints credentials, fiKey, ssoKey, or account numbers.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '../../functions/api');
const requireFromApi = createRequire(join(apiRoot, 'package.json'));
const jpeg = requireFromApi('jpeg-js');

const imageMod = await import(pathToFileURL(join(apiRoot, 'providers/parity/checkalt-image.mjs')).href);
const sandboxMod = await import(pathToFileURL(join(apiRoot, 'providers/checkalt-sandbox.mjs')).href);
const credsMod = await import(pathToFileURL(join(apiRoot, 'sandbox-credentials.mjs')).href);

const { inspectImage } = imageMod;
const {
  assertCheckAltSandboxCredentials,
  checkAltSandboxAuthenticate,
  checkAltSandboxFetch,
  collectCheckAltAccountNumbers,
  extractCheckAltSsoAndAccount,
  extractCheckAltReference,
  redactAccountNumber,
  fingerprintAccountNumber,
} = sandboxMod;
const { merchantHeaderForCheckAltUat } = credsMod;

const FROZEN_FRONT = '/opt/cursor/artifacts/checkalt-iqa-matrix/outbound-front.jpg';
const FROZEN_REAR = '/opt/cursor/artifacts/checkalt-iqa-matrix/outbound-rear.jpg';
const EXPECTED_FRONT_SHA = '2c46627eb7d729fbd01737079600bcc6f8b32d38b7a2964deee11e1b81418036';
const EXPECTED_REAR_SHA = '025d4b5c2b6dc1b3c27c6035ea1cf93ff1c9c84202d554b92062db3416c4c109';

const OUT_DIR = '/opt/cursor/artifacts/checkalt-risk-ab-frozen';
const REPO_OUT = 'aws/providers/results/checkalt_risk_ab_frozen.json';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sanitizeMessage = (msg) => String(msg || '')
  .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted-b64]')
  .replace(/\b\d{6,}\b/g, '[redacted-num]')
  .slice(0, 400);

function inspectOutboundB64(b64, label) {
  const str = String(b64 || '');
  const hasDataUriPrefix = str.startsWith('data:');
  const commaIdx = str.indexOf(',');
  const looksDoubleEncoded = hasDataUriPrefix
    || (commaIdx > 0 && /base64/i.test(str.slice(0, commaIdx + 1)));
  const raw = Buffer.from(str, 'base64');
  const asUtf8 = raw.toString('utf8');
  const innerLooksLikeB64Jpeg = raw[0] !== 0xff
    && (/^\/9j\//.test(asUtf8) || asUtf8.startsWith('data:image'));
  const roundTrip = raw.toString('base64');
  const info = inspectImage(raw);
  let jpegDecodeOk = true;
  let decodeError = null;
  try {
    jpeg.decode(raw, { maxMemoryUsageInMB: 64 });
  } catch (error) {
    jpegDecodeOk = false;
    decodeError = String(error?.message || error).slice(0, 120);
  }
  return {
    label,
    hasDataUriPrefix,
    looksDoubleEncoded: looksDoubleEncoded || innerLooksLikeB64Jpeg,
    innerLooksLikeB64Jpeg,
    jpegMagicHex: raw.slice(0, 3).toString('hex'),
    isJpeg: raw[0] === 0xff && raw[1] === 0xd8,
    bytes: raw.length,
    b64Chars: str.length,
    sha256: sha256(raw),
    roundTripB64Matches: roundTrip === str,
    width: info.width,
    height: info.height,
    landscape: info.landscape,
    jpegDecodeOk,
    decodeError,
    b64Prefix24: str.slice(0, 24),
  };
}

function credentialsFromEnv() {
  return {
    environment: 'uat',
    baseUrl: process.env.CHECKALT_UAT_BASE_URL || 'https://uatapi.checkalt.com',
    username: process.env.CHECKALT_UAT_USER_ID,
    userId: process.env.CHECKALT_UAT_USER_ID,
    password: process.env.CHECKALT_UAT_PASSWORD,
    fiKey: process.env.CHECKALT_UAT_FI_KEY,
    merchant: merchantHeaderForCheckAltUat(process.env.CHECKALT_UAT_MERCHANT),
  };
}

async function discoverDepositor(credentials, token) {
  const user = await checkAltSandboxFetch({
    credentials,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: credentials.fiKey, userId: credentials.userId },
    token,
  });
  const listed = collectCheckAltAccountNumbers(user.data || {});
  let depositAccountNumber = null;
  for (const accountNumber of listed) {
    if (accountNumber === '123456789') continue;
    const deposit = await checkAltSandboxFetch({
      credentials,
      path: '/fincapture/useraccount/getDepositAccountInformation',
      body: { fiKey: credentials.fiKey, userId: credentials.userId, accountNumber },
      token,
    });
    if (deposit.ok) {
      depositAccountNumber = accountNumber;
      break;
    }
  }
  if (!depositAccountNumber) {
    depositAccountNumber = listed.find((n) => n !== '123456789') || null;
  }

  const ssoUserId = `aws-uat-riskab-${Date.now().toString(36)}`;
  const registered = await checkAltSandboxFetch({
    credentials,
    path: '/fincapture/useraccount/register',
    body: {
      fiKey: credentials.fiKey,
      ssorequest: true,
      SSORequest: true,
      isSSORequest: true,
      userID: ssoUserId,
      userId: ssoUserId,
      firstName: 'UAT',
      lastName: 'RiskAb',
      emailAddress: 'uat-risk-ab@checksops.invalid',
      accountDataList: [{ accountNumber: depositAccountNumber }],
    },
    token,
  });

  const depositorInfo = await checkAltSandboxFetch({
    credentials,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: credentials.fiKey, userId: ssoUserId },
    token,
  });
  const extracted = extractCheckAltSsoAndAccount(depositorInfo.data, {});
  let ssoKey = extracted.ssoKey;
  if (!ssoKey && depositorInfo.ok) ssoKey = ssoUserId;

  return {
    ok: Boolean(registered.ok && ssoKey && depositAccountNumber),
    ssoKey,
    depositAccountNumber,
    meta: {
      listedCount: listed.length,
      depositAccountRedacted: redactAccountNumber(depositAccountNumber),
      depositAccountFingerprint: fingerprintAccountNumber(depositAccountNumber),
      registerOk: registered.ok === true,
      registerHttp: registered.httpStatus || registered.statusCode || null,
      depositorInfoOk: depositorInfo.ok === true,
      hasSsoKey: Boolean(ssoKey),
      ssoUserIdPrefix: ssoUserId.slice(0, 16),
    },
  };
}

async function submitProcess({
  credentials,
  token,
  ssoKey,
  depositAccountNumber,
  frontImage,
  rearImage,
  performRiskAssessment,
  label,
}) {
  const body = {
    fiKey: credentials.fiKey,
    ssoKey,
    depositAccountNumber,
    captureDateTime: new Date().toISOString(),
    userAmount: 1,
    frontImage,
    rearImage,
    performRiskAssessment,
  };
  const serialized = JSON.stringify(body);
  const fieldNames = Object.keys(JSON.parse(serialized));
  const startedAt = new Date().toISOString();
  const submitted = await checkAltSandboxFetch({
    credentials,
    path: '/fincapture/deposit/process',
    body,
    token,
  });
  const endedAt = new Date().toISOString();
  const reference = extractCheckAltReference(submitted.data);
  const providerKeys = submitted.providerResponseKeys
    || (submitted.data && typeof submitted.data === 'object' ? Object.keys(submitted.data).sort() : []);
  const data = submitted.data && typeof submitted.data === 'object' ? submitted.data : {};
  return {
    label,
    startedAt,
    endedAt,
    path: '/fincapture/deposit/process',
    performRiskAssessment,
    requestFieldNames: fieldNames,
    optionalFieldsPresent: {
      firstName: false,
      lastName: false,
      emailAddress: false,
      dailyDepositLimit: false,
    },
    serializedBytes: Buffer.byteLength(serialized),
    frontB64Chars: frontImage.length,
    rearB64Chars: rearImage.length,
    frontSha256: sha256(Buffer.from(frontImage, 'base64')),
    rearSha256: sha256(Buffer.from(rearImage, 'base64')),
    ok: submitted.ok === true,
    httpStatus: submitted.httpStatus || submitted.statusCode || null,
    message: sanitizeMessage(submitted.message),
    sanitizedProviderBody: {
      status: data.status != null ? data.status : null,
      error: data.error != null ? sanitizeMessage(data.error) : null,
      timestamp: data.timestamp != null ? String(data.timestamp) : null,
      message: sanitizeMessage(data.message || submitted.message),
    },
    providerResponseKeys: providerKeys,
    referencePresent: Boolean(reference),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(FROZEN_FRONT) || !existsSync(FROZEN_REAR)) {
    throw new Error('Frozen outbound JPEGs missing — refuse to regenerate');
  }

  const frontBytes = readFileSync(FROZEN_FRONT);
  const rearBytes = readFileSync(FROZEN_REAR);
  const frontSha = sha256(frontBytes);
  const rearSha = sha256(rearBytes);
  if (frontSha !== EXPECTED_FRONT_SHA || rearSha !== EXPECTED_REAR_SHA) {
    throw new Error(`Frozen image hash mismatch — refusing to proceed (front=${frontSha} rear=${rearSha})`);
  }

  const frontImage = frontBytes.toString('base64');
  const rearImage = rearBytes.toString('base64');

  const frontDecoded = Buffer.from(frontImage, 'base64');
  const rearDecoded = Buffer.from(rearImage, 'base64');
  writeFileSync(`${OUT_DIR}/transmitted-front-decoded.jpg`, frontDecoded);
  writeFileSync(`${OUT_DIR}/transmitted-rear-decoded.jpg`, rearDecoded);

  const frontInspect = inspectOutboundB64(frontImage, 'front-frozen-transmitted');
  const rearInspect = inspectOutboundB64(rearImage, 'rear-frozen-transmitted');

  const credentials = credentialsFromEnv();
  const gate = assertCheckAltSandboxCredentials(credentials);
  if (!gate.ok) {
    const out = { ok: false, stage: 'gate', error: gate.error };
    writeFileSync(REPO_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  const auth = await checkAltSandboxAuthenticate({ credentials });
  if (!auth.ok) {
    const out = { ok: false, stage: 'auth', httpStatus: auth.httpStatus, error: auth.error };
    writeFileSync(REPO_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  const depositor = await discoverDepositor(credentials, auth.rawToken);
  if (!depositor.ok) {
    const out = { ok: false, stage: 'depositor', meta: depositor.meta };
    writeFileSync(REPO_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const common = {
    credentials,
    token: auth.rawToken,
    ssoKey: depositor.ssoKey,
    depositAccountNumber: depositor.depositAccountNumber,
    frontImage,
    rearImage,
  };

  const riskTrue = await submitProcess({
    ...common,
    performRiskAssessment: true,
    label: 'RISK_TRUE_frozen_improved_pair',
  });
  const riskFalse = await submitProcess({
    ...common,
    performRiskAssessment: false,
    label: 'RISK_FALSE_same_exact_bytes',
  });

  const bodySansTs = (body) => {
    const { timestamp, ...rest } = body || {};
    return rest;
  };
  const identicalOutcome = riskTrue.httpStatus === riskFalse.httpStatus
    && riskTrue.message === riskFalse.message
    && riskTrue.ok === riskFalse.ok
    && JSON.stringify(bodySansTs(riskTrue.sanitizedProviderBody))
      === JSON.stringify(bodySansTs(riskFalse.sanitizedProviderBody));
  const identical500 = Number(riskTrue.httpStatus) === 500 && Number(riskFalse.httpStatus) === 500
    && riskTrue.message === riskFalse.message;
  const riskChanged = !identicalOutcome;

  const report = {
    verdict: riskChanged
      ? 'RISK_FLAG_CHANGED_OUTCOME'
      : (identical500 ? 'IDENTICAL_500_CLIENT_DIAGNOSTICS_EXHAUSTED' : 'OUTCOME_UNEXPECTED'),
    date: new Date().toISOString(),
    productionUntouched: true,
    negotiableCheckSubmitted: false,
    imagesRegenerated: false,
    frozenSource: {
      frontPath: FROZEN_FRONT,
      rearPath: FROZEN_REAR,
      frontSha256: frontSha,
      rearSha256: rearSha,
      expectedFrontSha256: EXPECTED_FRONT_SHA,
      expectedRearSha256: EXPECTED_REAR_SHA,
      hashMatch: true,
    },
    auth: {
      ok: true,
      authPath: auth.authPath,
      httpStatus: auth.httpStatus,
    },
    depositor: depositor.meta,
    transmittedBase64Inspection: {
      front: frontInspect,
      rear: rearInspect,
      decodedFilesWritten: {
        front: `${OUT_DIR}/transmitted-front-decoded.jpg`,
        rear: `${OUT_DIR}/transmitted-rear-decoded.jpg`,
      },
      decodedMatchesFrozenBytes: {
        front: sha256(frontDecoded) === frontSha,
        rear: sha256(rearDecoded) === rearSha,
      },
    },
    base64Guarantees: {
      noDataUri: !frontInspect.hasDataUriPrefix && !rearInspect.hasDataUriPrefix,
      noDoubleEncoding: !frontInspect.looksDoubleEncoded && !rearInspect.looksDoubleEncoded,
      roundTripOk: frontInspect.roundTripB64Matches && rearInspect.roundTripB64Matches,
      jpegValid: frontInspect.jpegDecodeOk && rearInspect.jpegDecodeOk,
      sameFrontHashInBothTests: riskTrue.frontSha256 === riskFalse.frontSha256
        && riskTrue.frontSha256 === frontSha,
      sameRearHashInBothTests: riskTrue.rearSha256 === riskFalse.rearSha256
        && riskTrue.rearSha256 === rearSha,
    },
    comparison: {
      riskTrue: {
        httpStatus: riskTrue.httpStatus,
        message: riskTrue.message,
        sanitizedProviderBody: riskTrue.sanitizedProviderBody,
        providerResponseKeys: riskTrue.providerResponseKeys,
        startedAt: riskTrue.startedAt,
        endedAt: riskTrue.endedAt,
        performRiskAssessment: true,
      },
      riskFalse: {
        httpStatus: riskFalse.httpStatus,
        message: riskFalse.message,
        sanitizedProviderBody: riskFalse.sanitizedProviderBody,
        providerResponseKeys: riskFalse.providerResponseKeys,
        startedAt: riskFalse.startedAt,
        endedAt: riskFalse.endedAt,
        performRiskAssessment: false,
      },
      performRiskAssessmentChangedOutcome: riskChanged,
      identicalHttp500: identical500,
      onlyPayloadDifference: 'performRiskAssessment boolean',
    },
    tests: [riskTrue, riskFalse],
  };

  writeFileSync(REPO_OUT, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verdict: report.verdict,
    riskChanged,
    identical500,
    riskTrue: report.comparison.riskTrue,
    riskFalse: report.comparison.riskFalse,
    base64Guarantees: report.base64Guarantees,
    dims: {
      front: `${frontInspect.width}x${frontInspect.height}/${frontInspect.bytes}`,
      rear: `${rearInspect.width}x${rearInspect.height}/${rearInspect.bytes}`,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
