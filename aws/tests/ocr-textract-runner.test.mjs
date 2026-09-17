import assert from 'node:assert/strict';
import { test } from 'node:test';

// These tests validate the Textract fallback/error plumbing deterministically
// without calling AWS. They exercise the exported __test__ helper.
import { __test__ } from '../functions/api/ocr.mjs';

test('10) Textract fallback: analyze fails -> detect succeeds', async () => {
  const calls = [];
  const deps = {
    textractSend: async (cmd) => {
      calls.push(cmd?.constructor?.name || 'unknown');
      if (calls.length === 1) {
        const e = new Error('AnalyzeDocument failed');
        e.name = 'AccessDeniedException';
        throw e;
      }
      return { Blocks: [{ BlockType: 'LINE', Text: 'PAY TO THE ORDER OF', Confidence: 90, Geometry: { BoundingBox: { Left: 0.1, Top: 0.3, Width: 0.2, Height: 0.03 } } }] };
    },
  };

  const out = await __test__.runTextract(Buffer.from('x'), deps);
  assert.equal(out.engine, 'aws_textract_detect');
  assert.equal(out.error, null);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.lines[0], 'PAY TO THE ORDER OF');
});

test('11) Textract failure: analyze + detect both fail -> error returned', async () => {
  const deps = {
    textractSend: async () => {
      const e = new Error('SubscriptionRequiredException');
      e.name = 'SubscriptionRequiredException';
      throw e;
    },
  };
  const out = await __test__.runTextract(Buffer.from('x'), deps);
  assert.equal(out.engine, 'aws_textract');
  assert.ok(out.error);
  assert.deepEqual(out.lines, []);
  assert.deepEqual(out.blocks, []);
});

test('12) tenant isolation behavior: missing row returns check_not_found', async () => {
  const fakeClient = {
    query: async () => ({ rows: [] }),
  };
  const loaded = await __test__.loadCheckImageBytes(fakeClient, '00000000-0000-0000-0000-000000000000');
  assert.equal(loaded.error, 'check_not_found');
});

