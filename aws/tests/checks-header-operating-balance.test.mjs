/**
 * Checks page header, white-label tenants (owner's "Option A", 2026-11-09): the
 * WalletOps "Available operating balance" replaces the subtitle
 * "Manage checks, endorsements & deposits" when the wallet is available, with
 * the same hook, query and format as WalletOps. Anyone else, and while the
 * wallet loads, on error, with no wallet or a failed sync, keeps the subtitle.
 * The non-white-label subtitle is unchanged. Fixtures only; no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import {
  checksHeaderOperatingBalance,
  formatWalletMoney,
  operatingBalanceLabel,
} from '../../src/lib/payments/operatingBalance.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const SUBTITLE = 'Manage checks, endorsements &amp; deposits';
const wallet = { available_cents: 1248035, status: 'active' };

test('the header balance uses the WalletOps format', () => {
  assert.equal(formatWalletMoney(1248035), '$12,480.35');
  assert.equal(formatWalletMoney(0), '$0.00');
  assert.equal(
    checksHeaderOperatingBalance({ enabled: true, isLoading: false, error: null, wallet }),
    '$12,480.35',
  );
  // Same number as the WalletOps hero for the same wallet.
  assert.equal(
    checksHeaderOperatingBalance({ enabled: true, isLoading: false, error: null, wallet }),
    operatingBalanceLabel({ wallet, setupRequired: false }),
  );
});

test('the header falls back (null) whenever WalletOps would not show a number', () => {
  const base = { enabled: true, isLoading: false, error: null, wallet };
  assert.equal(checksHeaderOperatingBalance({ ...base, enabled: false }), null, 'payments not enabled for the tenant');
  assert.equal(checksHeaderOperatingBalance({ ...base, isLoading: true }), null, 'loading');
  assert.equal(checksHeaderOperatingBalance({ ...base, error: new Error('boom') }), null, 'error');
  assert.equal(checksHeaderOperatingBalance({ ...base, wallet: null }), null, 'no wallet');
  assert.equal(
    checksHeaderOperatingBalance({ ...base, wallet: { ...wallet, status: 'sync_failed' } }),
    null,
    'failed sync (WalletOps shows "Balance unavailable")',
  );
});

test('WalletOps labels are unchanged by the extraction', () => {
  assert.equal(operatingBalanceLabel({ wallet: { ...wallet, status: 'sync_failed' }, setupRequired: false }), 'Balance unavailable');
  assert.equal(operatingBalanceLabel({ wallet: null, setupRequired: true }), 'Pending setup');
  assert.equal(operatingBalanceLabel({ wallet: null, setupRequired: false }), 'Pending sync');
});

test('WalletOps and the Checks header share one formatter and one data source', () => {
  const walletOps = read('src/pages/WalletOps.tsx');
  assert.match(walletOps, /^import \{ formatWalletMoney, operatingBalanceLabel \} from "@\/lib\/payments\/operatingBalance";$/m);
  assert.match(walletOps, /^const money = formatWalletMoney;$/m);
  assert.match(walletOps, /const balanceLabel = operatingBalanceLabel\(\{ wallet, setupRequired \}\);/);
  assert.doesNotMatch(walletOps, /toLocaleString\("en-US", \{\s*style: "currency"/);
  assert.match(walletOps, /useWallet\("operating"\)/);

  const header = read('src/components/checks/ChecksHeaderOperatingBalance.tsx');
  assert.match(header, /useWallet\("operating"\)/);
  assert.match(header, /checksHeaderOperatingBalance\(\{ enabled, isLoading, error, wallet \}\)/);
  // No other data source: no direct API or Supabase call in the header.
  assert.doesNotMatch(header, /supabase|fetch\(|useQuery|awsApi/);
});

test('only the white-label subtitle is replaced; the other subtitle is unchanged', () => {
  const page = read('src/pages/CheckCommandCenter.tsx');
  const head = page.slice(page.indexOf('<h1 className="text-xl md:text-2xl font-bold tracking-tight">ChecksOps</h1>'));
  const block = head.slice(0, head.indexOf('</div>'));
  assert.match(block, /\{isWhiteLabel \? \(\s*<ChecksHeaderOperatingBalance \/>\s*\) : \(/);
  assert.match(block, /<p className="text-sm text-muted-foreground">\{"Insurance check intake, review & deposit readiness"\}<\/p>/);
  assert.doesNotMatch(page, /"Manage checks, endorsements & deposits"/, 'the subtitle text lives in the header component');
});

// Render the real component with react-dom/server, useWallet replaced by a fixture.
async function renderHeader(walletState) {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'checks-header-balance-'));
  try {
    const out = path.join(dir, 'bundle.cjs');
    await esbuild.build({
      stdin: {
        contents: `
          import React from "react";
          import { renderToStaticMarkup } from "react-dom/server";
          import { ChecksHeaderOperatingBalance } from "@/components/checks/ChecksHeaderOperatingBalance";
          export const render = () => renderToStaticMarkup(React.createElement(ChecksHeaderOperatingBalance));
        `,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      outfile: out,
      logLevel: 'silent',
      plugins: [{
        name: 'fixture-wallet',
        setup(build) {
          build.onResolve({ filter: /^@\/hooks\/useWallet$/ }, () => ({ path: 'useWallet', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const useWallet = () => globalThis.__checksHeaderWallet;`,
            loader: 'js',
          }));
          build.onResolve({ filter: /^@\// }, (args) => {
            const base = path.join(root, 'src', args.path.slice(2));
            const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((file) => existsSync(file));
            return { path: hit ?? base };
          });
        },
      }],
    });
    globalThis.__checksHeaderWallet = walletState;
    const { render } = createRequire(import.meta.url)(out);
    return render();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ready = { enabled: true, isLoading: false, error: null, wallet };

test('renders "Available operating balance $12,480.35" as one readable sentence', async (t) => {
  let html;
  try {
    html = await renderHeader(ready);
  } catch (error) {
    if (/Cannot find (module|package) 'esbuild'|ERR_MODULE_NOT_FOUND/.test(String(error))) {
      t.skip('esbuild/react-dom not installed (run bun install)');
      return;
    }
    throw error;
  }
  assert.match(html, /^<p class="text-sm" data-testid="checks-header-operating-balance">/);
  assert.match(html, /<span class="text-muted-foreground">Available operating balance<\/span> <span class="ml-1\.5 text-base font-bold tabular-nums text-foreground">\$12,480\.35<\/span>/);
  assert.doesNotMatch(html, /Manage checks/);
  // Text a screen reader announces: the label, a space, the amount.
  assert.equal(html.split(/<[^>]*>/).join(''), 'Available operating balance $12,480.35');
});

test('renders the existing subtitle when not permitted, loading, on error, with no wallet or a failed sync', async (t) => {
  const cases = {
    'payments not enabled': { ...ready, enabled: false, wallet: null },
    loading: { ...ready, isLoading: true, wallet: null },
    error: { ...ready, error: new Error('wallet read failed'), wallet: null },
    'no wallet': { ...ready, wallet: null },
    'failed sync': { ...ready, wallet: { ...wallet, status: 'sync_failed' } },
  };
  for (const [name, state] of Object.entries(cases)) {
    let html;
    try {
      html = await renderHeader(state);
    } catch (error) {
      if (/Cannot find (module|package) 'esbuild'|ERR_MODULE_NOT_FOUND/.test(String(error))) {
        t.skip('esbuild/react-dom not installed (run bun install)');
        return;
      }
      throw error;
    }
    assert.equal(html, `<p class="text-sm text-muted-foreground">${SUBTITLE}</p>`, name);
    assert.doesNotMatch(html, /\$|…|Available operating balance/, name);
  }
});
