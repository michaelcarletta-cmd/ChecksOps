import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AWS_READ_METHODS,
  AWS_WRITE_METHODS,
  assertNoLiveAwsCalls,
  createForbiddenAwsAdapter,
  createLiveAwsAdapter,
  createRecordingAwsAdapter,
} from '../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';

test('forbidden adapter remains the evaluate default and throws GUARD_NO_AWS', () => {
  const adapter = createForbiddenAwsAdapter();
  assert.equal(adapter.kind, 'forbidden');
  for (const method of [...AWS_READ_METHODS, ...AWS_WRITE_METHODS]) {
    assert.throws(() => adapter[method](), (error) => error.code === CODES.GUARD_NO_AWS);
  }
  assert.equal(assertNoLiveAwsCalls(createForbiddenAwsAdapter()), true);
});

test('recording adapter is unchanged and only calls injected impls', async () => {
  const calls = [];
  const adapter = createRecordingAwsAdapter({
    getFunction: (input) => {
      calls.push(input);
      return { ok: true, details: { codeSha256: 'abc' } };
    },
  });
  assert.equal(adapter.kind, 'recording');
  const result = await adapter.getFunction({ functionName: 'checksops-staging-api' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].functionName, 'checksops-staging-api');
  assert.throws(() => adapter.updateFunctionCode({}), (error) => error.code === CODES.GUARD_NO_AWS);
});

test('importing the adapter module does not construct clients or call AWS', () => {
  let loads = 0;
  createLiveAwsAdapter({
    loadSdkImpl: async () => {
      loads += 1;
      throw new Error('SDK must not load on import or construction');
    },
  });
  assert.equal(loads, 0);
});

test('live adapter can be mocked and refuses writes until authorizeWrites', async () => {
  const sent = [];
  const lambda = {
    async send(command) {
      sent.push(command);
      if (command.operation === 'GetFunction') {
        return {
          Configuration: { CodeSha256: 'live-sha', RevisionId: 'rev-1' },
          Code: { Location: 'https://example.test/live.zip' },
        };
      }
      if (command.operation === 'UpdateFunctionCode') {
        return { CodeSha256: 'new-sha', RevisionId: 'rev-2' };
      }
      throw new Error(`unexpected ${command.operation}`);
    },
  };
  const adapter = createLiveAwsAdapter({
    clients: { lambda },
    loadSdkImpl: async () => {
      throw new Error('mocked live adapter must not load the AWS SDK');
    },
  });
  assert.equal(adapter.kind, 'live');
  const live = await adapter.getFunction({ functionName: 'checksops-staging-api' });
  assert.equal(live.ok, true);
  assert.equal(live.details.codeSha256, 'live-sha');
  const blocked = await adapter.updateFunctionCode({
    functionName: 'checksops-staging-api',
    zip: Buffer.from('zip'),
    revisionId: 'rev-1',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(sent.some((row) => row.operation === 'UpdateFunctionCode'), false);
  adapter.authorizeWrites({ receipt_mac: 'abc' });
  const written = await adapter.updateFunctionCode({
    functionName: 'checksops-staging-api',
    zip: Buffer.from('zip'),
    revisionId: 'rev-1',
  });
  assert.equal(written.ok, true, written.message);
  assert.equal(written.details.revisionId, 'rev-2');
  assert.equal(sent.filter((row) => row.operation === 'UpdateFunctionCode').length, 1);
});

test('live adapter UpdateFunctionCode requires RevisionId CAS', async () => {
  const adapter = createLiveAwsAdapter({
    authorized: true,
    clients: {
      lambda: {
        async send() { throw new Error('should not send without RevisionId'); },
      },
    },
  });
  const result = await adapter.updateFunctionCode({
    functionName: 'checksops-staging-api',
    zip: Buffer.from('zip'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});
