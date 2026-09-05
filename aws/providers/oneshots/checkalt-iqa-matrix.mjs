#!/usr/bin/env node
/**
 * Controlled CheckAlt UAT IQA diagnostic matrix (synthetic / non-negotiable only).
 * Never prints credentials, fiKey, ssoKey, or account numbers.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '../../functions/api');
const requireFromApi = createRequire(join(apiRoot, 'package.json'));
const jpeg = requireFromApi('jpeg-js');

const imageMod = await import(pathToFileURL(join(apiRoot, 'providers/parity/checkalt-image.mjs')).href);
const sandboxMod = await import(pathToFileURL(join(apiRoot, 'providers/checkalt-sandbox.mjs')).href);
const credsMod = await import(pathToFileURL(join(apiRoot, 'sandbox-credentials.mjs')).href);

const {
  TARGET_MAX_DIM,
  TARGET_JPEG_QUALITY,
  MIN_DIM,
  PER_IMAGE_BYTES_BUDGET,
  prepareSyntheticUatDepositImages,
  buildSyntheticUatCheckSource,
  browserCapToDepositTarget,
  normalizeToBudget,
  inspectImage,
} = imageMod;
const {
  assertCheckAltSandboxCredentials,
  checkAltSandboxAuthenticate,
  checkAltSandboxFetch,
  collectCheckAltAccountNumbers,
  extractCheckAltSsoAndAccount,
  extractCheckAltReference,
  extractCheckAltStatus,
  extractCheckAltAmountEcho,
  redactAccountNumber,
  fingerprintAccountNumber,
} = sandboxMod;
const { merchantHeaderForCheckAltUat } = credsMod;
const OUT_DIR = '/opt/cursor/artifacts/checkalt-iqa-matrix';
const REPO_OUT = 'aws/providers/results/checkalt_iqa_diagnostic_matrix.json';

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
    looksDoubleEncoded,
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
  };
}

function buildSimplifiedRearPreparedB64() {
  const source = buildSyntheticUatCheckSource({ side: 'rear', amountCents: 1 });
  const decoded = jpeg.decode(source, { maxMemoryUsageInMB: 128 });
  const { width, height, data } = decoded;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const keep = y < 320 || y > height - 40 || x < 20 || x > width - 20;
      if (!keep) {
        data[i] = 236;
        data[i + 1] = 238;
        data[i + 2] = 242;
        data[i + 3] = 255;
      }
    }
  }
  const simplifiedSource = Buffer.from(jpeg.encode({ data, width, height }, 92).data);
  const capped = browserCapToDepositTarget(simplifiedSource);
  const prepared = normalizeToBudget(capped, 'rear-simplified');
  return {
    rearImage: prepared.toString('base64'),
    rearKind: 'simplified_endorsement_band',
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

  const ssoUserId = `aws-uat-iqa-${Date.now().toString(36)}`;
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
      lastName: 'IqaMatrix',
      emailAddress: 'uat-iqa-matrix@checksops.invalid',
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
      ssoUserIdPrefix: ssoUserId.slice(0, 14),
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
    status: extractCheckAltStatus(submitted.data),
    amountEcho: extractCheckAltAmountEcho(submitted.data),
  };
}

function lovableParityNotes() {
  return {
    processPath: {
      lovable: '/fincapture/deposit/process',
      aws: '/fincapture/deposit/process',
      match: true,
    },
    processCoreFields: {
      lovable: [
        'fiKey', 'ssoKey', 'depositAccountNumber', 'captureDateTime',
        'userAmount', 'frontImage', 'rearImage', 'performRiskAssessment',
      ],
      aws: [
        'fiKey', 'ssoKey', 'depositAccountNumber', 'captureDateTime',
        'userAmount', 'frontImage', 'rearImage', 'performRiskAssessment',
      ],
      match: true,
    },
    optionalPostmanSampleFields: {
      fields: ['firstName', 'lastName', 'emailAddress', 'dailyDepositLimit'],
      lovableSends: false,
      awsSends: false,
      match: true,
      note: 'Both omit optional Postman sample fields. No client-side field gap to flip first.',
    },
    imagePrepareConstants: {
      lovablePrepareImageEdge: {
        targetMaxDim: 1600,
        jpegQuality: '78→35',
        minDim: 1300,
        perImageBudget: 450000,
        encoder: 'ImageScript',
      },
      awsNormalizeToBudget: {
        targetMaxDim: TARGET_MAX_DIM,
        jpegQuality: `${TARGET_JPEG_QUALITY}→35`,
        minDim: MIN_DIM,
        perImageBudget: PER_IMAGE_BYTES_BUDGET,
        encoder: 'jpeg-js',
      },
      constantsMatch: TARGET_MAX_DIM === 1600
        && TARGET_JPEG_QUALITY === 78
        && MIN_DIM === 1300
        && PER_IMAGE_BYTES_BUDGET === 450000,
      encoderDifference:
        'Lovable prepare-image uses ImageScript; AWS Node uses jpeg-js. Numeric resize/quality loop matches.',
    },
    lovableSubmitFallbackNormalize: {
      note: 'Only when image exceeds 450KB and was not pre-prepared',
      targetMaxDim: 1200,
      jpegQuality: 68,
      minDim: 600,
      differsFromPreparePath: true,
    },
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const credentials = credentialsFromEnv();
  const gate = assertCheckAltSandboxCredentials(credentials);
  if (!gate.ok) {
    writeFileSync(REPO_OUT, JSON.stringify({ ok: false, stage: 'gate', error: gate.error }, null, 2));
    console.log(JSON.stringify({ ok: false, stage: 'gate', error: gate.error }));
    process.exit(1);
  }

  const prepared = prepareSyntheticUatDepositImages({ amountCents: 1 });
  writeFileSync(`${OUT_DIR}/outbound-front.jpg`, Buffer.from(prepared.frontImage, 'base64'));
  writeFileSync(`${OUT_DIR}/outbound-rear.jpg`, Buffer.from(prepared.rearImage, 'base64'));

  const frontInspect = inspectOutboundB64(prepared.frontImage, 'front-improved');
  const rearInspect = inspectOutboundB64(prepared.rearImage, 'rear-improved');

  const simplified = buildSimplifiedRearPreparedB64();
  writeFileSync(`${OUT_DIR}/outbound-rear-simplified.jpg`, Buffer.from(simplified.rearImage, 'base64'));
  const rearSimpleInspect = inspectOutboundB64(simplified.rearImage, 'rear-simplified');

  const auth = await checkAltSandboxAuthenticate({ credentials });
  if (!auth.ok) {
    const out = {
      ok: false,
      stage: 'auth',
      httpStatus: auth.httpStatus,
      error: auth.error,
      authPath: auth.authPath || null,
    };
    writeFileSync(REPO_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  const depositor = await discoverDepositor(credentials, auth.rawToken);
  if (!depositor.ok) {
    const out = {
      ok: false,
      stage: 'depositor',
      meta: depositor.meta,
      note: 'Auth passed; depositor discovery/register failed before process matrix',
    };
    writeFileSync(REPO_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const common = {
    credentials,
    token: auth.rawToken,
    ssoKey: depositor.ssoKey,
    depositAccountNumber: depositor.depositAccountNumber,
    frontImage: prepared.frontImage,
  };

  const tests = [];
  tests.push(await submitProcess({
    ...common,
    rearImage: prepared.rearImage,
    performRiskAssessment: true,
    label: 'A_improved_pair_risk_true',
  }));
  tests.push(await submitProcess({
    ...common,
    rearImage: prepared.rearImage,
    performRiskAssessment: false,
    label: 'B_same_pair_risk_false',
  }));
  tests.push(await submitProcess({
    ...common,
    rearImage: simplified.rearImage,
    performRiskAssessment: true,
    label: 'C_same_front_simplified_rear_risk_true',
  }));

  const identical500 = tests.every((t) => Number(t.httpStatus) === 500);
  const messages = [...new Set(tests.map((t) => t.message).filter(Boolean))];
  const riskChanged = tests[0].httpStatus !== tests[1].httpStatus
    || tests[0].message !== tests[1].message
    || tests[0].ok !== tests[1].ok;

  const report = {
    verdict: identical500 ? 'CLIENT_DIAGNOSTICS_EXHAUSTED' : 'RESPONSE_VARIED',
    date: new Date().toISOString(),
    productionUntouched: true,
    negotiableCheckSubmitted: false,
    auth: {
      ok: true,
      authPath: auth.authPath,
      httpStatus: auth.httpStatus,
    },
    depositor: depositor.meta,
    outboundImageInspection: {
      front: frontInspect,
      rear: rearInspect,
      rearSimplified: rearSimpleInspect,
      imageKind: prepared.imageKind,
      pipeline: prepared.pipeline,
      amountCents: prepared.amountCents,
      targetMaxDim: TARGET_MAX_DIM,
      minDim: MIN_DIM,
      targetJpegQuality: TARGET_JPEG_QUALITY,
      perImageBytesBudget: PER_IMAGE_BYTES_BUDGET,
    },
    base64RoundTrip: {
      frontOk: frontInspect.roundTripB64Matches && frontInspect.isJpeg && !frontInspect.hasDataUriPrefix,
      rearOk: rearInspect.roundTripB64Matches && rearInspect.isJpeg && !rearInspect.hasDataUriPrefix,
      noDataUri: !frontInspect.hasDataUriPrefix && !rearInspect.hasDataUriPrefix,
      noDoubleEncoding: !frontInspect.looksDoubleEncoded && !rearInspect.looksDoubleEncoded,
    },
    matrix: tests,
    analysis: {
      performRiskAssessmentChangedOutcome: riskChanged,
      allIdenticalHttp500: identical500,
      distinctMessages: messages,
      sameFrontHashAcrossABC: tests[0].frontSha256 === tests[1].frontSha256
        && tests[0].frontSha256 === tests[2].frontSha256,
      rearHashAEqualsB: tests[0].rearSha256 === tests[1].rearSha256,
      rearHashAEqualsC: tests[0].rearSha256 === tests[2].rearSha256,
    },
    lovableParity: lovableParityNotes(),
    escalationPackage: identical500 ? {
      endpoint: 'POST /fincapture/deposit/process',
      host: 'uatapi.checkalt.com',
      timestamps: tests.map((t) => ({ label: t.label, startedAt: t.startedAt, endedAt: t.endedAt })),
      httpStatus: 500,
      sanitizedResponses: tests.map((t) => ({
        label: t.label,
        httpStatus: t.httpStatus,
        message: t.message,
        sanitizedProviderBody: t.sanitizedProviderBody,
        providerResponseKeys: t.providerResponseKeys,
        referencePresent: t.referencePresent,
        performRiskAssessment: t.performRiskAssessment,
      })),
      imageDimensionsFormat: {
        front: {
          width: frontInspect.width,
          height: frontInspect.height,
          format: 'JPEG',
          bytes: frontInspect.bytes,
        },
        rear: {
          width: rearInspect.width,
          height: rearInspect.height,
          format: 'JPEG',
          bytes: rearInspect.bytes,
        },
        rearSimplified: {
          width: rearSimpleInspect.width,
          height: rearSimpleInspect.height,
          format: 'JPEG',
          bytes: rearSimpleInspect.bytes,
        },
      },
      requestFieldNames: tests[0].requestFieldNames,
      performRiskAssessmentResults: {
        true: { httpStatus: tests[0].httpStatus, message: tests[0].message },
        false: { httpStatus: tests[1].httpStatus, message: tests[1].message },
        changedOutcome: riskChanged,
      },
      nonSensitiveIds: {
        referencePresent: tests.some((t) => t.referencePresent),
        providerResponseKeysUnion: [...new Set(tests.flatMap((t) => t.providerResponseKeys || []))],
      },
      priorPassingStages: {
        authentication: true,
        register: depositor.meta.registerOk,
        accountBinding: Boolean(depositor.meta.depositAccountFingerprint),
      },
      note: 'Credentials, fiKey, ssoKey, and account numbers intentionally omitted.',
    } : null,
  };

  writeFileSync(REPO_OUT, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verdict: report.verdict,
    riskChanged,
    identical500,
    tests: tests.map((t) => ({
      label: t.label,
      httpStatus: t.httpStatus,
      message: t.message,
      performRiskAssessment: t.performRiskAssessment,
      rearSha: t.rearSha256.slice(0, 12),
    })),
    base64RoundTrip: report.base64RoundTrip,
    outbound: {
      front: `${frontInspect.width}x${frontInspect.height}/${frontInspect.bytes}`,
      rear: `${rearInspect.width}x${rearInspect.height}/${rearInspect.bytes}`,
      rearSimplified: `${rearSimpleInspect.width}x${rearSimpleInspect.height}/${rearSimpleInspect.bytes}`,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
