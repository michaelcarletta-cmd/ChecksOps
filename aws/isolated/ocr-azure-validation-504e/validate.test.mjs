import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  handler,
  buildRedactedResponse,
  __test__,
} from './src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const api = path.join(repo, 'aws/functions/api');
const templatePath = path.join(here, 'template.yaml');
const template = readFileSync(templatePath, 'utf8');

const MODULES = [
  'azure-check-ocr.mjs',
  'check-ocr-provider.mjs',
  'ocr-normalize-azure.mjs',
  'textract-check-ocr.mjs',
  'ocr-parse.mjs',
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
};

test('1) template syntax and isolated resource names', () => {
  assert.match(template, /AWSTemplateFormatVersion: '2010-09-09'/);
  assert.match(template, /Transform: AWS::Serverless-2016-10-31/);
  assert.match(template, /FunctionName: checksops-ocr-azure-validation-504e/);
  assert.match(template, /RoleName: checksops-ocr-azure-validation-504e-role/);
  assert.match(template, /LogGroupName: \/aws\/lambda\/checksops-ocr-azure-validation-504e/);
  assert.match(template, /Runtime: nodejs22\.x/);
  assert.match(template, /- arm64/);
  assert.match(template, /MemorySize: 1024/);
  assert.match(template, /Timeout: 45/);
  assert.match(template, /RetentionInDays: 1/);
  assert.match(template, /CodeUri: pack\//);
  assert.match(template, /AZURE_DI_SECRET_ID: checksops\/isolated\/azure-document-intelligence-504e/);
  assert.match(template, /MAX_INPUT_BYTES: '4194304'/);
  assert.match(template, /Outputs:/);
  assert.match(template, /AzureDiSecretId:/);
  assert.doesNotMatch(template, /SecretString/);
  assert.doesNotMatch(template, /AWS::SecretsManager::Secret/);
});

test('2) IAM is least privilege and has no broad/shared grants', () => {
  assert.match(template, /textract:AnalyzeDocument/);
  assert.match(template, /textract:DetectDocumentText/);
  assert.match(template, /secretsmanager:GetSecretValue/);
  assert.match(template, /secret:checksops\/isolated\/azure-document-intelligence-504e-\*/);
  assert.match(template, /log-group:\/aws\/lambda\/checksops-ocr-azure-validation-504e:\*/);
  assert.equal((template.match(/secretsmanager:GetSecretValue/g) || []).length, 1);
  assert.equal((template.match(/Action:\n\s+- secretsmanager:GetSecretValue/g) || []).length, 1);
  assert.doesNotMatch(template, /checksops\/staging\/providers/);
  assert.doesNotMatch(template, /checksops\/\$\{.*\}\/providers/);
  assert.doesNotMatch(template, /s3:[A-Za-z]/i);
  assert.doesNotMatch(template, /rds:[A-Za-z]/i);
  assert.doesNotMatch(template, /cognito-idp:|AWS::Cognito/i);
  assert.doesNotMatch(template, /checkalt/i);
  assert.doesNotMatch(template, /moov/i);
  assert.doesNotMatch(template, /kms:[A-Za-z]/i);
  assert.doesNotMatch(template, /iam:Create|iam:Put|iam:PassRole/);
});

test('3) no VPC, Function URL, API Gateway, or event source', () => {
  assert.doesNotMatch(template, /VpcConfig/);
  assert.doesNotMatch(template, /SubnetIds/);
  assert.doesNotMatch(template, /SecurityGroup/);
  assert.doesNotMatch(template, /FunctionUrlConfig/);
  assert.doesNotMatch(template, /AuthType:/);
  assert.doesNotMatch(template, /Events:/);
  assert.doesNotMatch(template, /HttpApi|Api:/);
  assert.doesNotMatch(template, /FunctionUrl/);
});

test('4) no secret value or Azure endpoint embedded in package sources', () => {
  const files = [
    templatePath,
    path.join(here, 'src/index.mjs'),
    path.join(here, 'pack.sh'),
    path.join(here, 'package.json'),
    path.join(here, 'validate.test.mjs'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /cognitiveservices\.azure\.com/);
    assert.doesNotMatch(text, /Ocp-Apim-Subscription-Key\s*[:=]\s*['\"][^'\"]+/);
    assert.doesNotMatch(text, /"api_key"\s*:\s*"[^"]{8,}"/);
  }
});

test('5) package builds and copies HEAD implementation modules', () => {
  const packed = spawnSync('bash', ['pack.sh'], { cwd: here, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packDir = path.join(here, 'pack');
  for (const name of MODULES) {
    const src = path.join(api, name);
    const dest = path.join(packDir, name);
    assert.equal(existsSync(dest), true, `missing packed ${name}`);
    assert.equal(sha256(dest), sha256(src), `${name} is not the live API module`);
  }
  assert.equal(existsSync(path.join(packDir, 'index.mjs')), true);
  assert.equal(existsSync(path.join(packDir, 'node_modules/@aws-sdk/client-textract')), true);
  assert.equal(existsSync(path.join(packDir, 'node_modules/@aws-sdk/client-secrets-manager')), true);
  const zip = path.join(here, 'dist/checksops-ocr-azure-validation-504e.zip');
  assert.equal(existsSync(zip), true);
  assert.match(packed.stdout, /[0-9a-f]{64}\s+/);
});

test('6) packaged parser is not the stale isolated Textract tester copy path', () => {
  const packedParse = path.join(here, 'pack/ocr-parse.mjs');
  const liveParse = path.join(api, 'ocr-parse.mjs');
  const staleParse = path.join(repo, 'aws/isolated/textract-parser-test-504e/src/ocr-parse.mjs');
  assert.equal(sha256(packedParse), sha256(liveParse));
  assert.ok(
    __test__.resolveImplModule('ocr-parse.mjs').includes('functions/api/ocr-parse.mjs')
      || __test__.resolveImplModule('ocr-parse.mjs').includes('/pack/')
      || existsSync(path.join(here, 'src/ocr-parse.mjs')) === false,
  );
  // Wrapper must not import the isolated tester tree.
  const wrapper = readFileSync(path.join(here, 'src/index.mjs'), 'utf8');
  assert.doesNotMatch(wrapper, /textract-parser-test-504e/);
  assert.doesNotMatch(readFileSync(path.join(here, 'pack/index.mjs'), 'utf8'), /textract-parser-test-504e/);
  if (existsSync(staleParse) && sha256(staleParse) !== sha256(liveParse)) {
    assert.notEqual(sha256(packedParse), sha256(staleParse));
  }
});

test('7) packed tree has no S3/RDS/Cognito grants or embedded secrets', () => {
  const packedTemplate = template;
  assert.doesNotMatch(packedTemplate, /s3:Get|s3:Put|s3:List/i);
  const packDir = path.join(here, 'pack');
  for (const file of walkFiles(packDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.yaml'))) {
    if (file.includes('node_modules')) continue;
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /"api_key"\s*:\s*"(?!.*\|)[A-Za-z0-9]{16,}"/);
  }
});

test('8) returnMode must equal redacted', async () => {
  const logs = [];
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('x').toString('base64'),
    returnMode: 'full',
  }, {}, { log: (row) => logs.push(row) });
  assert.equal(out.statusCode, 400);
  assert.equal(out.code, 'bad_return_mode');
});

test('9) JPEG and PNG only; max input 4 MB', async () => {
  const logs = [];
  const gif = await handler({
    contentType: 'image/gif',
    imageB64: Buffer.from('x').toString('base64'),
    returnMode: 'redacted',
  }, {}, { log: (row) => logs.push(row) });
  assert.equal(gif.statusCode, 415);
  assert.equal(gif.code, 'unsupported_content_type');

  const bad = await handler({
    contentType: 'image/jpeg',
    imageB64: '%%%not-base64%%%',
    returnMode: 'redacted',
  }, {}, { log: (row) => logs.push(row) });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.code, 'invalid_base64');

  assert.equal(__test__.DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(__test__.maxInputBytes(), 4 * 1024 * 1024);

  const huge = Buffer.alloc((4 * 1024 * 1024) + 1, 1);
  const over = await handler({
    contentType: 'image/png',
    imageB64: huge.toString('base64'),
    returnMode: 'redacted',
  }, {}, { log: (row) => logs.push(row) });
  assert.equal(over.statusCode, 413);
  assert.equal(over.code, 'payload_too_large');
  assert.equal(over.maxBytes, 4 * 1024 * 1024);
});

test('10) response redaction omits MICR values, payees, raw provider payloads', async () => {
  const ROUTING = '111000025';
  const ACCOUNT = '000111222333';
  const CHECK = '778899';
  const PAYEE = 'Staging Uat Homeowner';
  const logs = [];
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
  }, {}, {
    log: (row) => logs.push(row),
    secretLoader: async () => ({ endpoint: 'https://di-test.example.test', api_key: 'test-azure-key-not-real' }),
    fetchImpl: async () => ({ status: 500, headers: { get: () => null }, text: async () => '' }),
    extractCheck: async () => ({
      canonical: {
        carrier_name: 'Textract Carrier Mutual',
        check_number: CHECK,
        amount: '1234.56',
        payee_line: PAYEE,
        payees: [{ name: PAYEE, type: 'unknown' }],
        claim_number: 'CLM-STAGING-7788',
        routing_number: ROUTING,
        account_number: ACCOUNT,
        micr_check_number: CHECK,
        descriptive_engine: 'aws_textract_analyze',
        micr_engine: 'azure_prebuilt_check_us',
        micr_routing_state: 'VERIFIED',
        micr_account_state: 'VERIFIED',
        micr_check_state: 'VERIFIED',
        filled_from_azure: ['payee_line', 'payees'],
        descriptive_sources: {
          amount: 'aws_textract_analyze',
          payee_line: 'azure_prebuilt_check_us',
          payees: 'azure_prebuilt_check_us',
          check_number: 'aws_textract_analyze',
        },
        textract_descriptive: {
          amount: '1234.56',
          payee_line: PAYEE,
          payees: [{ name: PAYEE, type: 'unknown' }],
          check_number: CHECK,
        },
        needs_manual_review: false,
        field_confidence: {
          routing_number: 0.008,
          account_number: 0,
          micr_check_number: 0.168,
          amount: 94,
        },
        diagnostic: { textract_micr_heuristic: { routing_number: ROUTING } },
        azure_descriptive: { payee_line: PAYEE, payees: [{ name: PAYEE }] },
      },
      azure_delete_confirmed: true,
      textract_error: null,
      azure_error: null,
    }),
  });

  assert.equal(out.statusCode, 200);
  assert.equal(out.azure_result_delete, 'CONFIRMED');
  assert.equal(out.descriptive.amount.present, true);
  assert.equal(out.descriptive.amount.canonical_source, 'aws_textract_analyze');
  assert.equal(out.descriptive.amount.textract_present, true);
  assert.equal(out.descriptive.amount.azure_present, false);
  assert.equal(out.descriptive.payees.present, true);
  assert.equal(out.descriptive.payees.count, 1);
  assert.equal(out.descriptive.payees.azure_present, true);
  assert.equal(out.descriptive.payees.canonical_source, 'azure_prebuilt_check_us');
  assert.equal(out.descriptive.printed_check_number.azure_present, false);
  assert.equal(out.descriptive.printed_check_number.textract_present, true);
  assert.equal(out.micr.routing.state, 'VERIFIED');
  assert.equal(out.micr.routing.aba_valid, true);
  assert.equal(out.micr.routing.confidence, 0.008);
  assert.equal(out.micr.account.state, 'VERIFIED');
  assert.equal(out.micr.micr_check.matches_printed_check, true);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(ROUTING));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
  assert.ok(!blob.includes(PAYEE));
  assert.ok(!blob.includes('resultId'));
  assert.ok(!blob.includes('operation-location'));
  assert.ok(!('routing_number' in out));
  assert.ok(!('account_number' in out));
  assert.ok(!('payee_line' in (out.descriptive || {})) || !out.descriptive.payee_line.value);
});

test('11) logs are redacted and whitelist-only', async () => {
  const logs = [];
  await handler({
    contentType: 'image/png',
    imageB64: Buffer.from('png').toString('base64'),
    returnMode: 'redacted',
  }, {}, {
    log: (row) => logs.push(row),
    extractCheck: async () => ({
      canonical: {
        routing_number: '111000025',
        account_number: '000111222333',
        payee_line: 'Staging Uat Homeowner',
        micr_routing_state: 'VERIFIED',
        micr_account_state: 'VERIFIED',
        micr_check_state: 'MISSING',
        descriptive_engine: 'aws_textract_analyze',
        micr_engine: 'azure_prebuilt_check_us',
        filled_from_azure: [],
        field_confidence: {},
      },
      azure_delete_confirmed: false,
    }),
  });
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes('111000025'));
  assert.ok(!blob.includes('000111222333'));
  assert.ok(!blob.includes('Staging Uat Homeowner'));
  assert.ok(!blob.includes('test-azure-key-not-real'));
  assert.ok(logs.every((row) => !('routing_number' in row)));
  assert.ok(logs.every((row) => !('imageB64' in row)));
  assert.ok(logs.every((row) => !('api_key' in row)));
});

test('12) JPEG and PNG happy-path accept with injected extractCheck', async () => {
  for (const contentType of ['image/jpeg', 'image/png']) {
    const out = await handler({
      contentType,
      imageB64: Buffer.from(contentType).toString('base64'),
      returnMode: 'redacted',
    }, {}, {
      log: () => {},
      extractCheck: async () => ({
        canonical: {
          descriptive_engine: 'aws_textract_analyze',
          micr_engine: 'none',
          micr_routing_state: 'MISSING',
          micr_account_state: 'MISSING',
          micr_check_state: 'MISSING',
          filled_from_azure: [],
          field_confidence: {},
        },
        azure_delete_confirmed: false,
      }),
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.ok, true);
    assert.equal(out.azure_result_delete, 'NOT_CONFIRMED');
    assert.ok(out.input_bytes > 0);
  }
});

test('14) mocked Secrets Manager { api_key, endpoint } configures Azure', async () => {
  const FAKE_ENDPOINT = 'https://di-test.example.test';
  const FAKE_KEY = 'test-azure-key-not-real';
  const RESULT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const logs = [];
  let azurePosts = 0;
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
  }, {}, {
    log: (row) => logs.push(row),
    secretsClient: {
      send: async () => ({
        SecretString: JSON.stringify({ api_key: FAKE_KEY, endpoint: FAKE_ENDPOINT }),
      }),
    },
    textractSend: async () => ({
      Blocks: [{
        BlockType: 'LINE',
        Text: 'PAY TO THE ORDER OF',
        Confidence: 95,
        Geometry: { BoundingBox: { Left: 0.08, Top: 0.28, Width: 0.3, Height: 0.03 } },
      }],
    }),
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        azurePosts += 1;
        return {
          status: 202,
          headers: {
            get: (name) => (String(name).toLowerCase() === 'operation-location'
              ? `${FAKE_ENDPOINT}/documentintelligence/documentModels/prebuilt-check.us/analyzeResults/${RESULT}`
              : null),
          },
          text: async () => '',
        };
      }
      if (init.method === 'DELETE') {
        return { status: 204, headers: { get: () => null }, text: async () => '' };
      }
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          status: 'succeeded',
          analyzeResult: {
            documents: [{
              fields: {
                MICR: {
                  valueObject: {
                    RoutingNumber: { valueString: '111000025', confidence: 0 },
                    AccountNumber: { valueString: '000111222333', confidence: 0.008 },
                    CheckNumber: { valueString: '778899', confidence: 0.168 },
                  },
                },
              },
            }],
          },
        }),
      };
    },
    sleep: async () => {},
    now: () => 0,
  });
  assert.notEqual(out.azure_error, 'azure_not_configured');
  assert.equal(out.statusCode, 200);
  assert.equal(out.micr.provider, 'azure_prebuilt_check_us');
  assert.equal(out.micr.routing.state, 'VERIFIED');
  assert.equal(out.azure_result_delete, 'CONFIRMED');
  assert.equal(azurePosts, 1);

  const binaryOut = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
  }, {}, {
    log: (row) => logs.push(row),
    secretsClient: {
      send: async () => ({
        SecretBinary: Buffer.from(JSON.stringify({ api_key: FAKE_KEY, endpoint: 'di-test.example.test' })),
      }),
    },
    textractSend: async () => ({ Blocks: [] }),
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        azurePosts += 1;
        return {
          status: 400,
          headers: { get: () => null },
          text: async () => '',
        };
      }
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    },
    sleep: async () => {},
    now: () => 1,
  });
  assert.notEqual(binaryOut.azure_error, 'azure_not_configured');
  assert.equal(binaryOut.statusCode, 200);
  assert.ok(azurePosts >= 2);

  const blob = JSON.stringify({ out, binaryOut, logs });
  assert.ok(!blob.includes(FAKE_KEY));
  assert.ok(!blob.includes('111000025'));
  assert.ok(!blob.includes('000111222333'));
  assert.ok(!blob.includes('778899'));
});

test('13) redaction helper never copies raw MICR or payee fields', () => {
  const redacted = buildRedactedResponse({
    canonical: {
      routing_number: '111000025',
      account_number: '000111222333',
      micr_check_number: '778899',
      payee_line: 'Someone',
      payees: [{ name: 'Someone' }],
      check_number: '778899',
      amount: '1234.56',
      carrier_name: 'Someone Carrier',
      micr_routing_state: 'REVIEW_REQUIRED',
      micr_account_state: 'MISSING',
      micr_check_state: 'REVIEW_REQUIRED',
      descriptive_engine: 'aws_textract_detect',
      micr_engine: 'azure_prebuilt_check_us',
      filled_from_azure: ['payee_line', 'payees', 'carrier_name'],
      descriptive_sources: {
        payee_line: 'azure_prebuilt_check_us',
        payees: 'azure_prebuilt_check_us',
        carrier_name: 'azure_prebuilt_check_us',
        amount: 'aws_textract_detect',
        check_number: 'aws_textract_detect',
      },
      textract_descriptive: {
        payee_line: 'Someone',
        amount: '1234.56',
        check_number: '778899',
      },
      azure_descriptive: {
        payee_line: 'Someone',
        payees: [{ name: 'Someone' }],
        carrier_name: 'Someone Carrier',
      },
      field_confidence: { routing_number: 0 },
    },
    azure_delete_confirmed: false,
  });
  assert.equal(redacted.micr.routing.aba_valid, false);
  assert.equal(redacted.micr.micr_check.matches_printed_check, false);
  assert.equal(redacted.azure_result_delete, 'NOT_CONFIRMED');
  assert.equal(redacted.descriptive.payee_line.azure_present, true);
  assert.equal(redacted.descriptive.payee_line.textract_present, true);
  assert.equal(redacted.descriptive.payee_line.canonical_source, 'azure_prebuilt_check_us');
  assert.equal(redacted.descriptive.amount.canonical_source, 'aws_textract_detect');
  assert.equal(JSON.stringify(redacted).includes('111000025'), false);
  assert.equal(JSON.stringify(redacted).includes('Someone'), false);
  assert.equal(JSON.stringify(redacted).includes('1234.56'), false);
  assert.ok(!('value' in redacted.descriptive.payee_line));
  assert.ok(!('azure_descriptive' in redacted));
  assert.ok(!('textract_descriptive' in redacted));
});

test('15) absent ground-truth field leaves isolated response unchanged', async () => {
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
  }, {}, {
    log: () => {},
    extractCheck: async () => ({
      canonical: {
        check_number: '778899',
        micr_check_number: '112233',
        descriptive_engine: 'aws_textract_analyze',
        micr_engine: 'azure_prebuilt_check_us',
        filled_from_azure: [],
        field_confidence: {},
        textract_descriptive: { check_number: '778899' },
      },
      azure_delete_confirmed: true,
    }),
  });
  assert.equal(out.statusCode, 200);
  assert.equal('ground_truth_check_present' in out, false);
  assert.equal('azure_micr_vs_ground_truth' in out, false);
  assert.equal('textract_printed_vs_ground_truth' in out, false);
});

test('16) ground-truth compare MATCH/NO_MATCH/UNAVAILABLE without leaking digits', async () => {
  const GT = '778899';
  const AZURE_MICR = '112233';
  const TX_PRINTED = '778899';
  const logs = [];
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
    groundTruthPrintedCheck: GT,
  }, {}, {
    log: (row) => logs.push(row),
    extractCheck: async () => ({
      canonical: {
        check_number: TX_PRINTED,
        micr_check_number: AZURE_MICR,
        micr_check_state: 'REVIEW_REQUIRED',
        descriptive_engine: 'aws_textract_analyze',
        micr_engine: 'azure_prebuilt_check_us',
        filled_from_azure: [],
        field_confidence: {},
        textract_descriptive: { check_number: TX_PRINTED },
      },
      azure_delete_confirmed: true,
    }),
  });
  assert.equal(out.statusCode, 200);
  assert.equal(out.ground_truth_check_present, true);
  assert.equal(out.azure_micr_vs_ground_truth, 'NO_MATCH');
  assert.equal(out.textract_printed_vs_ground_truth, 'MATCH');
  const blob = JSON.stringify({ out, logs });
  assert.ok(!blob.includes(GT));
  assert.ok(!blob.includes(AZURE_MICR));
  assert.ok(!blob.includes(TX_PRINTED));
  assert.ok(!blob.includes('groundTruthPrintedCheck'));
  assert.ok(logs.every((row) => !('groundTruthPrintedCheck' in row)));
  assert.ok(!('check_number' in out));
  assert.ok(!('micr_check_number' in out));
});

test('17) ground-truth compare is UNAVAILABLE when a side has no digits', async () => {
  const GT = '778899';
  const logs = [];
  const out = await handler({
    contentType: 'image/png',
    imageB64: Buffer.from('png').toString('base64'),
    returnMode: 'redacted',
    groundTruthPrintedCheck: `No. ${GT}`,
  }, {}, {
    log: (row) => logs.push(row),
    extractCheck: async () => ({
      canonical: {
        check_number: null,
        micr_check_number: null,
        micr_check_state: 'MISSING',
        descriptive_engine: 'aws_textract_analyze',
        micr_engine: 'azure_prebuilt_check_us',
        filled_from_azure: [],
        field_confidence: {},
        textract_descriptive: { check_number: null },
      },
      azure_delete_confirmed: false,
    }),
  });
  assert.equal(out.ground_truth_check_present, true);
  assert.equal(out.azure_micr_vs_ground_truth, 'UNAVAILABLE');
  assert.equal(out.textract_printed_vs_ground_truth, 'UNAVAILABLE');
  const blob = JSON.stringify({ out, logs });
  assert.ok(!blob.includes(GT));
  assert.ok(!blob.includes('No. '));
});

test('18) non-digit ground-truth is treated as absent', async () => {
  const out = await handler({
    contentType: 'image/jpeg',
    imageB64: Buffer.from('tiny-jpeg').toString('base64'),
    returnMode: 'redacted',
    groundTruthPrintedCheck: 'not-a-check',
  }, {}, {
    log: () => {},
    extractCheck: async () => ({
      canonical: {
        check_number: '778899',
        micr_check_number: '778899',
        filled_from_azure: [],
        field_confidence: {},
      },
      azure_delete_confirmed: true,
    }),
  });
  assert.equal('ground_truth_check_present' in out, false);
  assert.equal('azure_micr_vs_ground_truth' in out, false);
});

test('19) compare helper never returns digits', () => {
  assert.equal(__test__.compareDigitsOnly('778899', '778899'), 'MATCH');
  assert.equal(__test__.compareDigitsOnly('112233', '778899'), 'NO_MATCH');
  assert.equal(__test__.compareDigitsOnly(null, '778899'), 'UNAVAILABLE');
  assert.equal(__test__.readGroundTruthDigits({}), null);
  assert.equal(__test__.readGroundTruthDigits({ groundTruthPrintedCheck: '  77-8899  ' }), '778899');
  const attached = __test__.attachGroundTruthComparison(
    { ok: true },
    { canonical: { check_number: '778899', micr_check_number: '778899' } },
    '778899',
  );
  assert.equal(attached.ground_truth_check_present, true);
  assert.equal(attached.azure_micr_vs_ground_truth, 'MATCH');
  assert.equal(JSON.stringify(attached).includes('778899'), false);
});
