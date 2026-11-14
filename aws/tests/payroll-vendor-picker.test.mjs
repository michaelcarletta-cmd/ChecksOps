/**
 * Payroll → "New Payroll Payment": vendor payees must be visible in the Payee picker
 * (owner, staging 2026-11-14: "Vendor doesn't show up on payroll"; the same vendor shows in
 * Settings → Vendors and in a check's Funds tab "Pay a vendor" picker).
 *
 * Before: the vendors were a "Vendors (ChecksOps wallet)" group appended after every active
 * stakeholder (bank-pending ones included) inside one Radix Select whose viewport is capped at
 * 300px and whose scrollbar Radix hides. With a handful of stakeholders the group was below the
 * fold with no visible scrollbar. Now the dialog asks "Pay a: Stakeholder / Vendor" first and the
 * list shows one kind at a time, so a vendor is the first option of its list.
 *
 * Renders the real PayrollTab → RunPayrollDialog in jsdom with the real useVendorPayees and
 * useActiveStakeholders hooks and React Query; only the Supabase client, tenant, toast, step-up,
 * eligibility, membership, history table and the send call are fixtures. No network.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const VENDOR = { vendor_tenant_id: '11111111-2222-4333-8444-555555555555', vendor_name: 'Acme Roofing Supply', vendor_active: true };
const stakeholders = (n) => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`,
  nickname: `Stakeholder ${i}`,
  account_type: 'stakeholder',
  verification_status: i % 3 === 2 ? 'pending' : 'verified',
  is_active: true,
  provider: 'moov',
  provider_account_id: `acct-${i}`,
  custname: null,
  is_primary: false,
}));

const FIXTURES = {
  '@/contexts/TenantContext': 'export const useTenant = () => ({ tenant: { id: "t1" } });',
  '@/hooks/use-toast': 'export const useToast = () => ({ toast: (t) => globalThis.__payroll.toasts.push(t) });',
  '@/hooks/usePaymentProviderEligibility': 'export const usePaymentProviderEligibility = () => ({ enabled: true });',
  '@/hooks/useStepUp': 'export const useStepUp = () => ({ requireStepUp: async () => true });',
  '@/hooks/useCurrentTenantMembership': 'export const useCurrentTenantMembership = () => ({ isMember: true });',
  '@/components/payroll/PayrollHistoryTable': 'export const PayrollHistoryTable = () => null;',
  '@/lib/payments/sends': `
    export class SendPaymentError extends Error {}
    export const sendPayrollPayment = async (input) => { globalThis.__payroll.sends.push(input); return { ok: true }; };
  `,
  // Read at call time: each test installs its own fake.
  '@/integrations/supabase/client': `export const supabase = {
    from: (...args) => globalThis.__payroll.supabase.from(...args),
    rpc: (...args) => globalThis.__payroll.supabase.rpc(...args),
  };`,
};

let bundle = null;
async function loadBundle() {
  if (bundle) return bundle;
  const esbuild = require('esbuild');
  const { JSDOM } = require('jsdom');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'payroll-vendor-picker-'));
  try {
    const out = path.join(dir, 'bundle.cjs');
    await esbuild.build({
      stdin: {
        contents: `
          import React, { act } from "react";
          import { createRoot } from "react-dom/client";
          import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
          import { PayrollTab } from "@/pages/payments/PayrollTab";
          export { React, act, createRoot, QueryClient, QueryClientProvider, PayrollTab };
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
      define: { 'import.meta.env': '{"MODE":"test"}' },
      plugins: [{
        name: 'payroll-fixtures',
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) => {
            if (FIXTURES[args.path]) return { path: args.path, namespace: 'fixture' };
            const base = path.join(root, 'src', args.path.slice(2));
            const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((file) => existsSync(file));
            return { path: hit ?? base };
          });
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: FIXTURES[args.path], loader: 'js' }));
        },
      }],
    });

    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (!(key in globalThis) || ['window', 'document', 'navigator'].includes(key) || /Event(Target)?$/.test(key)) {
        try { Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true }); } catch { /* read-only */ }
      }
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // Bundled React's act() queues each task on a new MessageChannel; close it once delivered, or
    // the open ports keep this test process alive after the last test.
    const NodeMessageChannel = globalThis.MessageChannel;
    globalThis.MessageChannel = class {
      constructor() {
        const channel = new NodeMessageChannel();
        const port1 = channel.port1;
        this.port2 = channel.port2;
        this.port1 = { set onmessage(fn) { port1.onmessage = (event) => { port1.close(); fn(event); }; } };
      }
    };
    // jsdom has no layout: what Radix Select needs to open.
    globalThis.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    dom.window.Element.prototype.hasPointerCapture = () => false;
    dom.window.Element.prototype.releasePointerCapture = () => {};
    dom.window.Element.prototype.scrollIntoView = () => {};
    globalThis.__payroll = { toasts: [], sends: [], calls: [], supabase: null };

    bundle = { ...require(out), dom };
    return bundle;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// jsdom keeps timers alive; close it once every test has run.
after(() => { bundle?.dom.window.close(); });

const tick = (m, ms = 20) => m.act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function renderPayroll(t, { stakeholderCount = 0, vendors = [VENDOR], vendorError = null } = {}) {
  let m;
  try {
    m = await loadBundle();
  } catch (error) {
    if (/Cannot find (module|package) '(esbuild|jsdom)'|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(String(error))) {
      t.skip('esbuild/jsdom/react-dom not installed (run bun install)');
      return null;
    }
    throw error;
  }
  const state = globalThis.__payroll;
  state.toasts = []; state.sends = []; state.calls = [];
  const rows = stakeholders(stakeholderCount);
  state.supabase = {
    from(table) {
      const q = {
        select: () => q, eq: () => q, order: () => q,
        then: (resolve, reject) => { state.calls.push(`from:${table}`); return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
      };
      return q;
    },
    async rpc(name, args) {
      state.calls.push(`rpc:${name}:${args?.tenant_id}`);
      if (vendorError) return { data: null, error: { message: vendorError } };
      return { data: vendors, error: null };
    },
  };
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = new m.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const rootNode = m.createRoot(host);
  await m.act(async () => {
    rootNode.render(m.React.createElement(m.QueryClientProvider, { client }, m.React.createElement(m.PayrollTab)));
  });
  t.after(async () => { await m.act(async () => rootNode.unmount()); client.clear(); });

  const ui = {
    m,
    state,
    async openDialog() {
      const button = [...document.querySelectorAll('button')].find((b) => /New Payroll Payment/.test(b.textContent));
      assert.ok(button, 'the "New Payroll Payment" button');
      await m.act(async () => { button.click(); });
      await tick(m);
    },
    async click(el) {
      await m.act(async () => { el.click(); });
      await tick(m);
    },
    payeeTrigger: () => document.querySelector('[role="dialog"] [role="combobox"]'),
    async openPicker() {
      const trigger = ui.payeeTrigger();
      assert.ok(trigger, 'the Payee picker');
      await m.act(async () => { trigger.dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      await tick(m);
      return document.querySelector('[role="listbox"]');
    },
    options: () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent),
    async choose(text) {
      const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes(text));
      assert.ok(option, `option ${text}`);
      await m.act(async () => { option.dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      await tick(m);
    },
  };
  return ui;
}

test('the vendor list is loaded when the dialog opens, not before', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 2 });
  if (!ui) return;
  assert.deepEqual(ui.state.calls, [], 'nothing is read while the dialog is closed');
  await ui.openDialog();
  assert.ok(ui.state.calls.includes('rpc:vendor_payees_list:t1'), JSON.stringify(ui.state.calls));
  assert.ok(ui.state.calls.includes('from:stakeholder_accounts'));
});

test('a "Pay a: Stakeholder / Vendor" choice is shown above the Payee picker, with the vendor count', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 12 });
  if (!ui) return;
  await ui.openDialog();
  const kind = document.querySelector('[data-testid="payroll-payee-kind"]');
  assert.ok(kind, 'the Stakeholder / Vendor choice is visible without opening the picker');
  assert.equal(kind.getAttribute('role'), 'radiogroup');
  const vendor = document.querySelector('[data-testid="payroll-payee-kind-vendor"]');
  assert.match(vendor.textContent, /^Vendor \(1\)ChecksOps wallet$/);
  assert.equal(document.querySelector('[data-testid="payroll-payee-kind-stakeholder"]').getAttribute('aria-checked'), 'true');
});

test('with 12 stakeholders, choosing Vendor lists the vendor first, under "Vendors (ChecksOps wallet)"', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 12 });
  if (!ui) return;
  await ui.openDialog();
  await ui.click(document.querySelector('[data-testid="payroll-payee-kind-vendor"]'));
  assert.match(ui.payeeTrigger().textContent, /Choose a vendor/);
  const listbox = await ui.openPicker();
  assert.ok(listbox, 'the vendor picker opens');
  assert.match(listbox.textContent, /Vendors \(ChecksOps wallet\)/);
  assert.deepEqual(ui.options(), ['Acme Roofing Supply · Vendor'], 'only vendors, the vendor is the first option');
});

test('the stakeholder list still lists every active stakeholder and no vendor', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 3 });
  if (!ui) return;
  await ui.openDialog();
  await ui.openPicker();
  assert.deepEqual(ui.options(), ['Stakeholder 0', 'Stakeholder 1', 'Stakeholder 2 · Bank setup pending']);
});

test('paying a vendor from payroll: wallet note, confirm screen, one send with vendorTenantId', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 5 });
  if (!ui) return;
  await ui.openDialog();
  await ui.click(document.querySelector('[data-testid="payroll-payee-kind-vendor"]'));
  await ui.openPicker();
  await ui.choose('Acme Roofing Supply');
  assert.match(ui.payeeTrigger().textContent, /Acme Roofing Supply/);
  assert.match(document.body.textContent, /Vendors are paid to their ChecksOps wallet only\. The normal send fee applies\./);

  const amount = document.querySelector('[role="dialog"] input[type="number"]');
  const setValue = Object.getOwnPropertyDescriptor(ui.m.dom.window.HTMLInputElement.prototype, 'value').set;
  await ui.m.act(async () => {
    setValue.call(amount, '25');
    amount.dispatchEvent(new ui.m.dom.window.Event('input', { bubbles: true }));
  });
  const button = (label) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim().startsWith(label));
  assert.equal(button('Continue').disabled, false);
  await ui.click(button('Continue'));
  assert.match(document.body.textContent, /Vendor · ChecksOps wallet/);
  await ui.click(button('Yes, send'));
  assert.equal(ui.state.sends.length, 1);
  assert.equal(ui.state.sends[0].vendorTenantId, VENDOR.vendor_tenant_id);
  assert.equal(ui.state.sends[0].stakeholderAccountId, null);
  assert.equal(ui.state.sends[0].amountCents, 2500);
});

test('switching back to Stakeholder clears a chosen vendor', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 2 });
  if (!ui) return;
  await ui.openDialog();
  await ui.click(document.querySelector('[data-testid="payroll-payee-kind-vendor"]'));
  await ui.openPicker();
  await ui.choose('Acme Roofing Supply');
  await ui.click(document.querySelector('[data-testid="payroll-payee-kind-stakeholder"]'));
  assert.match(ui.payeeTrigger().textContent, /Choose a stakeholder/);
  assert.doesNotMatch(document.body.textContent, /Vendors are paid to their ChecksOps wallet only/);
});

test('no vendors: the Vendor choice says where to add one', async (t) => {
  const empty = await renderPayroll(t, { stakeholderCount: 1, vendors: [] });
  if (!empty) return;
  await empty.openDialog();
  await empty.click(document.querySelector('[data-testid="payroll-payee-kind-vendor"]'));
  assert.match(empty.payeeTrigger().textContent, /No vendors yet/);
  assert.match(document.body.textContent, /Add a vendor by its Partner Code in Settings → Bank Account\/Stakeholders → Vendors\./);
});

test('a failed vendor read is shown in the Vendor list', async (t) => {
  const ui = await renderPayroll(t, { stakeholderCount: 1, vendorError: 'forbidden' });
  if (!ui) return;
  await ui.openDialog();
  await ui.click(document.querySelector('[data-testid="payroll-payee-kind-vendor"]'));
  const alert = document.querySelector('[data-testid="payroll-vendors-error"]');
  assert.ok(alert, 'the error is shown');
  assert.match(alert.textContent, /You are not a member of this organization\./);
});

test('why vendors were out of sight: the Payee list is capped at 300px and Radix hides its scrollbar', async (t) => {
  const select = read('src/components/ui/select.tsx');
  assert.match(select, /max-h-\[min\(var\(--radix-select-content-available-height,300px\),300px\)\]/);
  const ui = await renderPayroll(t, { stakeholderCount: 12 });
  if (!ui) return;
  await ui.openDialog();
  const listbox = await ui.openPicker();
  assert.match(listbox.textContent, /\[data-radix-select-viewport\]\{scrollbar-width:none/);
  // So the stakeholder list holds stakeholders only; vendors have their own list (above).
  assert.equal(ui.options().length, 12);
  assert.doesNotMatch(listbox.textContent, /Vendors \(ChecksOps wallet\)|Acme Roofing Supply/);
});
