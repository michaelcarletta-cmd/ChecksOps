import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __private as endorsementPrivates } from '../../src/lib/endorsementDepositRender.ts';

test('renderDepositImage source loader retries with refreshed signed URL when initial fetch fails', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  const originalUrl = globalThis.URL;

  try {
    // Minimal stubs for browser globals used by loadImage().
    globalThis.URL = {
      ...originalUrl,
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    };

    globalThis.Image = class FakeImage {
      constructor() {
        this.onload = null;
        this.onerror = null;
        this.naturalWidth = 1600;
        this.naturalHeight = 900;
      }
      set src(value) {
        this._src = value;
        queueMicrotask(() => this.onload && this.onload());
      }
      get src() {
        return this._src;
      }
    };

    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        throw new Error('network_fail');
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['ok'], { type: 'image/jpeg' }),
      };
    };

    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls += 1;
      return 'https://signed.example/fresh';
    };

    const img = await endorsementPrivates.loadImage('https://signed.example/expired', refresh);

    assert.equal(refreshCalls, 1);
    assert.deepEqual(calls, ['https://signed.example/expired', 'https://signed.example/fresh']);
    assert.equal(String(img.src), 'blob:mock');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = originalImage;
    globalThis.URL = originalUrl;
  }
});

