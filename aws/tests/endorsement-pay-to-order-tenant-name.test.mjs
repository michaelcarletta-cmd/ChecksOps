// Owner request 2026-11-09: the name after "Pay to the order of" is the
// tenant's Company Name from Company Profile (public.tenants.name) of the tenant
// that owns the check. Never "Freedom Adjustment" for another tenant; a blank
// name leaves the pay-to-order name lines out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_COMPANY_SIGNER_TENANT_ID,
  compositeEndorsementSignatures,
  makeInkSignatureDataUrl,
  renderDepositJpeg,
  resolveEndorsementCompanyName,
  selectVisibleSignatures,
} from '../functions/api/endorsement-composite.mjs';
import { FREEDOM_TENANT_ID } from '../functions/api/authorization.mjs';
import { embedRelationTable, parseSelect, relatedFk } from '../functions/api/data.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import {
  endorsementCompanyNameForCheck,
  isCompanyEndorsementName,
  resolveEndorsementCompanyName as resolveClientCompanyName,
} from '../../src/lib/endorsementCompanyName.ts';
import { FREEDOM_ADJUSTMENT_TENANT_ID } from '../../src/lib/vendorOps.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const PARTNER_TENANT = '22222222-2222-4222-8222-222222222222';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_BACK = `checks/${CHECK_ID}/back-original.jpg`;

const signedRow = (id, payeeName, mark) => ({
  id,
  payee_name: payeeName,
  payee_type: 'insured',
  status: 'signed',
  signed_at: '2026-11-09T00:00:00.000Z',
  signature_image_url: makeInkSignatureDataUrl({ mark }),
  signature_method: 'portal',
});

const compositeWith = async ({ tenantId = OTHER_TENANT, tenantRow, endorsements }) => {
  const tenantQueries = [];
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (compact.includes('FROM public.check_intake_items') && compact.includes('SELECT')) {
        return {
          rows: [{
            id: CHECK_ID,
            tenant_id: tenantId,
            back_image_path: ORIGINAL_BACK,
            back_image_original_path: ORIGINAL_BACK,
            back_image_deposit_path: null,
            endorsement_override: null,
            endorsement_render_meta: {},
            status: 'endorsements_in_progress',
            check_stage: 'endorsing',
            deposited_at: null,
          }],
        };
      }
      if (compact.includes('FROM public.check_endorsements e')) return { rows: endorsements };
      if (compact.includes('FROM public.tenants')) {
        tenantQueries.push({ sql: compact, params });
        return { rows: tenantRow ? [tenantRow] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  let renderInput = null;
  const result = await compositeEndorsementSignatures({
    client,
    checkId: CHECK_ID,
    deps: {
      loadDeposits: async () => [],
      downloadClaimFile: async () => syntheticCompliantCheckAltJpeg({ seed: 5, quality: 78 }),
      uploadClaimFile: async (rel) => ({ path: rel }),
      renderDepositJpeg: (bytes, input) => {
        renderInput = input;
        return renderDepositJpeg(bytes, input);
      },
      stampFingerprint: false,
    },
  });
  return { result, renderInput, tenantQueries };
};

test('server stamp: a non-Freedom tenant gets its own tenants.name, never Freedom Adjustment', async () => {
  const { result, renderInput, tenantQueries } = await compositeWith({
    tenantRow: { name: 'Condition One Commercial' },
    endorsements: [signedRow('e1', 'Jane Doe', 'J')],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(renderInput.companyName, 'Condition One Commercial');
  assert.notEqual(renderInput.companyName, 'Freedom Adjustment');
  // The name is read for the tenant that owns the check.
  assert.equal(tenantQueries.length, 1);
  assert.deepEqual(tenantQueries[0].params, [OTHER_TENANT]);
  assert.match(tenantQueries[0].sql, /SELECT name FROM public\.tenants WHERE id = \$1::uuid/);
});

test('server stamp: the drawn name changes the deposit image (the name is on the stamp)', () => {
  const back = syntheticCompliantCheckAltJpeg({ seed: 9, quality: 78 });
  const base = {
    override: { xPct: 0.38, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: true },
    clientSignatures: [{ payee_name: 'Jane Doe', signature_image_url: makeInkSignatureDataUrl({ mark: 'J' }) }],
    companySignature: null,
  };
  const conditionOne = renderDepositJpeg(back, { ...base, companyName: 'Condition One Commercial' });
  const freedom = renderDepositJpeg(back, { ...base, companyName: 'Freedom Adjustment' });
  assert.equal(conditionOne.ok, true);
  assert.equal(freedom.ok, true);
  assert.notEqual(conditionOne.sha256, freedom.sha256);
});

test('server stamp: the module has no hardcoded Freedom Adjustment fallback', () => {
  const src = read('aws/functions/api/endorsement-composite.mjs');
  assert.doesNotMatch(src, /'Freedom Adjustment'/);
  assert.doesNotMatch(src, /let companyName = 'Freedom/);
});

test('empty-name fallback: blank tenants.name gives "" and the pay-to-order name lines are left out', async () => {
  assert.equal(resolveEndorsementCompanyName({ name: '   ' }), '');
  assert.equal(resolveEndorsementCompanyName({ name: null }), '');
  assert.equal(resolveEndorsementCompanyName(undefined), '');
  assert.equal(resolveEndorsementCompanyName({ name: '  Acme Roofing ' }), 'Acme Roofing');

  for (const tenantRow of [{ name: '  ' }, null]) {
    const { result, renderInput } = await compositeWith({
      tenantRow,
      endorsements: [signedRow('e1', 'Jane Doe', 'J')],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(renderInput.companyName, '');
    // A blank name never classifies every payee as the company signer.
    assert.equal(renderInput.clientSignatures.length, 1);
    assert.equal(renderInput.companySignature, null);
  }

  const back = syntheticCompliantCheckAltJpeg({ seed: 13, quality: 78 });
  const base = {
    override: { xPct: 0.38, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: true },
    clientSignatures: [{ payee_name: 'Jane Doe', signature_image_url: makeInkSignatureDataUrl({ mark: 'J' }) }],
    companySignature: null,
  };
  const blank = renderDepositJpeg(back, { ...base, companyName: '' });
  const spaces = renderDepositJpeg(back, { ...base, companyName: '   ' });
  const named = renderDepositJpeg(back, { ...base, companyName: 'Acme Roofing' });
  assert.equal(blank.ok, true);
  assert.equal(blank.sha256, spaces.sha256);
  assert.notEqual(blank.sha256, named.sha256);
});

test('company signature row: matched by the real tenant name; Freedom/Carletta aliases only for the Freedom tenant', () => {
  assert.equal(LEGACY_COMPANY_SIGNER_TENANT_ID, FREEDOM_TENANT_ID);
  const rows = [
    signedRow('e1', 'Jane Doe', 'J'),
    signedRow('e2', 'Freedom Mortgage', 'F'),
    signedRow('e3', 'Condition One Commercial LLC', 'C'),
  ];
  const other = selectVisibleSignatures(rows, 'Condition One Commercial', OTHER_TENANT);
  assert.equal(other.companySignature?.payee_name, 'Condition One Commercial LLC');
  assert.deepEqual(other.clientSignatures.map((r) => r.payee_name), ['Jane Doe', 'Freedom Mortgage']);

  const blank = selectVisibleSignatures(rows, '', OTHER_TENANT);
  assert.equal(blank.companySignature, null);
  assert.equal(blank.clientSignatures.length, 3);

  // Freedom Adjustment keeps its existing company signer rows.
  const freedomRows = [signedRow('e1', 'Jane Doe', 'J'), signedRow('e4', 'Michael Carletta', 'M')];
  const freedom = selectVisibleSignatures(freedomRows, 'Freedom Adjustment', FREEDOM_TENANT_ID);
  assert.equal(freedom.companySignature?.payee_name, 'Michael Carletta');
  assert.deepEqual(freedom.clientSignatures.map((r) => r.payee_name), ['Jane Doe']);
});

test('preview: the check owner tenant name is what the adjuster receives', () => {
  assert.equal(FREEDOM_ADJUSTMENT_TENANT_ID, FREEDOM_TENANT_ID);
  // Owner viewing its own check: the tenants(name) embed.
  assert.equal(
    endorsementCompanyNameForCheck(
      { tenant_id: OTHER_TENANT, tenants: { name: 'Condition One Commercial' } },
      { id: OTHER_TENANT, name: 'Condition One Commercial' },
    ),
    'Condition One Commercial',
  );
  // Owner, embed not loaded yet: the signed-in tenant (it is the owner).
  assert.equal(
    endorsementCompanyNameForCheck({ tenant_id: OTHER_TENANT }, { id: OTHER_TENANT, name: ' Acme Roofing ' }),
    'Acme Roofing',
  );
  // Partner viewing a shared check: the OWNER's name, as the server stamps it.
  assert.equal(
    endorsementCompanyNameForCheck(
      { tenant_id: OTHER_TENANT, tenants: { name: 'Condition One Commercial' } },
      { id: PARTNER_TENANT, name: 'Partner Co' },
    ),
    'Condition One Commercial',
  );
  // Partner without the owner's name: blank, never the partner's own name.
  assert.equal(
    endorsementCompanyNameForCheck({ tenant_id: OTHER_TENANT, tenants: null }, { id: PARTNER_TENANT, name: 'Partner Co' }),
    '',
  );
  // Empty-name fallback on the client too.
  assert.equal(
    endorsementCompanyNameForCheck({ tenant_id: OTHER_TENANT, tenants: { name: '  ' } }, { id: OTHER_TENANT, name: '  ' }),
    '',
  );
  assert.equal(resolveClientCompanyName({ name: '  ' }), '');
  assert.equal(endorsementCompanyNameForCheck(null, null), '');

  // Client company-signer match mirrors the server.
  assert.equal(isCompanyEndorsementName('Freedom Mortgage', 'Condition One Commercial', OTHER_TENANT), false);
  assert.equal(isCompanyEndorsementName('Condition One Commercial LLC', 'Condition One Commercial', OTHER_TENANT), true);
  assert.equal(isCompanyEndorsementName('Jane Doe', '', OTHER_TENANT), false);
  assert.equal(isCompanyEndorsementName('Michael Carletta', 'Freedom Adjustment', FREEDOM_ADJUSTMENT_TENANT_ID), true);
});

test('preview: CheckCommandCenter passes the owner tenant Company Name, not external_origin or Freedom Adjustment', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /companyName=\{endorsementCompanyName\}/);
  assert.match(src, /companyTenantId=\{checkOwnerTenantId \?\? null\}/);
  assert.match(src, /endorsementCompanyNameForCheck\(check, currentTenant\)/);
  assert.doesNotMatch(src, /external_origin\?\.tenant_name/);
  assert.doesNotMatch(src, /"Freedom Adjustment"/);
  const select = src.match(/const CHECK_DETAIL_SELECT =\s*"([^"]+)"/)?.[1];
  assert.ok(select, 'CHECK_DETAIL_SELECT');
  assert.match(select, /tenants\(name\)/);
  // Both the detail query and its prefetch use the same select.
  assert.equal(src.match(/\.select\(CHECK_DETAIL_SELECT\)/g)?.length, 2);

  // On AWS the tenants(name) embed is served from tenants_public by tenant_id,
  // so a partner viewing a shared check reads the owner's name.
  const embed = parseSelect(select).embeds.find((e) => e.table === 'tenants');
  assert.deepEqual(embed.columns, ['name']);
  assert.equal(embedRelationTable('tenants', embed.columns), 'tenants_public');
  assert.equal(relatedFk('check_intake_items', 'tenants_public'), 'tenant_id');
});

test('client renderers and the deposit packet carry no other tenant name', () => {
  for (const rel of [
    'src/components/checks/EndorsementAdjuster.tsx',
    'src/lib/endorsementDepositRender.ts',
    'src/utils/endorsementLayout.ts',
    'src/components/check-review/DepositPacketGenerator.tsx',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /Freedom Adjustment/, rel);
    assert.doesNotMatch(src, /includes\("freedom"\)/, rel);
  }
  const adjuster = read('src/components/checks/EndorsementAdjuster.tsx');
  assert.match(adjuster, /isCompanyEndorsementName\(name, companyName, companyTenantId\)/);
  assert.match(adjuster, /\{companyName && \(/);
  const render = read('src/lib/endorsementDepositRender.ts');
  assert.match(render, /if \(companyName\) \{\s*ctx\.font = `600 \$\{fontSize\}px Arial, sans-serif`;\s*ctx\.fillText\("Pay to the order of"/);
  const layout = read('src/utils/endorsementLayout.ts');
  assert.match(layout, /if \(companyName\) \{\s*\/\/ Pay to the order of/);
});
