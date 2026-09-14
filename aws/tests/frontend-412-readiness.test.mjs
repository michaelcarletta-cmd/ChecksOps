import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  isPublicTokenRoute,
  PUBLIC_TOKEN_PATH_PREFIXES,
} from '../../src/lib/publicTokenRoutes.ts';
import {
  isReservedTenantSlug,
  resolveTenantByRouteSlug,
} from '../../src/lib/tenantRoute.ts';
import {
  fetchFundsReleasedPopulation,
  fundsReleasedDisplayCount,
  FUNDS_RELEASED_STATUS,
} from '../../src/lib/fundsReleasedQuery.ts';
import {
  tenantBrandingFromRow,
  tenantBrandingWritePayload,
  TENANT_BRANDING_WRITE_COLUMNS,
} from '../../src/lib/tenantBranding.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const FREEDOM = {
  id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
  name: 'Freedom Claims Adjusting',
  slug: 'freedom',
  partner_code: 'FREEDOM_CZM',
  subscription_status: 'active',
};
const C1C = {
  id: '4f172140-f57a-4744-8050-95f4f07b13b4',
  name: 'Condition One Commercial',
  slug: 'c1c',
  partner_code: 'C1C',
  subscription_status: 'active',
};

test('public token routes include /h/ledger and keep /ledger and /start-claim', () => {
  assert.equal(isPublicTokenRoute('/h/ledger/abc'), true);
  assert.equal(isPublicTokenRoute('/ledger/abc'), true);
  assert.equal(isPublicTokenRoute('/start-claim/abc'), true);
  assert.equal(isPublicTokenRoute('/h/claim/abc'), true);
  assert.equal(isPublicTokenRoute('/h/upload'), true);
  assert.equal(isPublicTokenRoute('/freedom/checks'), false);
  assert.equal(isPublicTokenRoute('/c1c/settings'), false);
  assert.equal(isPublicTokenRoute('/this-path-does-not-exist-412audit'), false);
  assert.ok(PUBLIC_TOKEN_PATH_PREFIXES.includes('/h/ledger/'));
});

test('App.tsx mounts /h/ledger/:token on HomeownerLedger before slug catch-all', () => {
  const app = sourceOf('src/App.tsx');
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(app, /path="\/ledger\/:token"/);
  assert.match(app, /path="\/start-claim\/:token"/);
  assert.match(app, /from "\.\/lib\/publicTokenRoutes"/);
  const hLedger = app.indexOf('path="/h/ledger/:token"');
  const slug = app.indexOf('path="/:slug/*"');
  assert.ok(hLedger > 0 && slug > hLedger);
});

test('unknown and reserved slugs are not treated as organizations', () => {
  assert.equal(isReservedTenantSlug('h'), true);
  assert.equal(isReservedTenantSlug('admin'), true);
  assert.equal(isReservedTenantSlug('freedom'), false);
  assert.equal(isReservedTenantSlug('c1c'), false);
  const whiteLabel = sourceOf('src/pages/WhiteLabelApp.tsx');
  assert.match(whiteLabel, /isReservedTenantSlug/);
  assert.match(whiteLabel, /<NotFound/);
  assert.doesNotMatch(whiteLabel, /Organization Not Found/);
});

test('tenant route resolver uses canonical slug then partner code, never a hardcoded map', () => {
  const src = sourceOf('src/lib/tenantRoute.ts');
  assert.doesNotMatch(src, /freedom_czm/);
  assert.match(src, /lookup_tenant_by_partner_code/);
  assert.match(src, /tenants_public/);
});

test('resolveTenantByRouteSlug prefers tenants_public slug and maps partner codes', async () => {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push(['from', table]);
      const self = {
        select() { return self; },
        eq(column, value) { self._eq = { table, column, value }; return self; },
        async maybeSingle() {
          if (self._eq.table === 'tenants_public' && self._eq.column === 'slug' && self._eq.value === 'freedom') {
            return { data: FREEDOM, error: null };
          }
          if (self._eq.table === 'tenants_public' && self._eq.column === 'slug' && self._eq.value === 'c1c') {
            return { data: C1C, error: null };
          }
          if (self._eq.table === 'tenants' && self._eq.column === 'id' && self._eq.value === FREEDOM.id) {
            return { data: FREEDOM, error: null };
          }
          return { data: null, error: null };
        },
      };
      return self;
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      if (name === 'lookup_tenant_by_partner_code' && /freedom/i.test(args._code)) {
        return { data: [{ id: FREEDOM.id, name: FREEDOM.name }], error: null };
      }
      return { data: [], error: null };
    },
  };

  const freedom = await resolveTenantByRouteSlug(supabase, 'freedom');
  assert.equal(freedom.source, 'tenants_public.slug');
  assert.equal(freedom.tenant.slug, 'freedom');
  assert.equal(freedom.tenant.id, FREEDOM.id);

  const c1c = await resolveTenantByRouteSlug(supabase, 'c1c');
  assert.equal(c1c.source, 'tenants_public.slug');
  assert.equal(c1c.tenant.slug, 'c1c');

  const byCode = await resolveTenantByRouteSlug(supabase, 'FREEDOM_CZM');
  assert.equal(byCode.source, 'partner_code');
  assert.equal(byCode.tenant.id, FREEDOM.id);
  assert.equal(byCode.tenant.slug, 'freedom');

  const missing = await resolveTenantByRouteSlug(supabase, 'this-path-does-not-exist-412audit');
  assert.equal(missing.tenant, null);
  assert.equal(missing.source, 'not_found');

  const reserved = await resolveTenantByRouteSlug(supabase, 'h');
  assert.equal(reserved.source, 'reserved');
  assert.equal(reserved.tenant, null);
});

test('Funds Released badge uses the settled-split total, not a 100 cap or check-stage count', () => {
  assert.equal(
    fundsReleasedDisplayCount({ total: 109, filteredLength: 100, hasSearch: false }),
    109,
  );
  assert.equal(
    fundsReleasedDisplayCount({ total: 109, filteredLength: 3, hasSearch: true }),
    3,
  );
  assert.equal(FUNDS_RELEASED_STATUS, 'settled');
  const cmd = sourceOf('src/pages/CheckCommandCenter.tsx');
  assert.match(cmd, /fetchFundsReleasedPopulation/);
  assert.match(cmd, /fundsReleasedDisplayCount/);
  assert.doesNotMatch(cmd, /label: "Funds Released".*\.limit\(100\)/);
  const fundsBlock = cmd.slice(cmd.indexOf('Funds released'), cmd.indexOf('Funds received'));
  assert.doesNotMatch(fundsBlock, /\.limit\(100\)/);
  assert.doesNotMatch(fundsBlock, /stageTotals/);
});

test('fetchFundsReleasedPopulation pages the full settled population', async () => {
  const rows = Array.from({ length: 109 }, (_, i) => ({ id: `split-${i + 1}` }));
  let countCalls = 0;
  let pageCalls = 0;
  const fromTable = () => {
    const state = { mode: 'count', from: 0, to: 0 };
    const builder = {
      select(columns, options) {
        state.mode = options?.head ? 'count' : 'page';
        return builder;
      },
      eq() { return builder; },
      order() { return builder; },
      range(from, to) {
        pageCalls += 1;
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: 109 });
      },
      then(onFulfilled) {
        countCalls += 1;
        return Promise.resolve(onFulfilled({ data: null, error: null, count: 109 }));
      },
    };
    return builder;
  };
  const result = await fetchFundsReleasedPopulation(fromTable, FREEDOM.id, 100);
  assert.equal(result.total, 109);
  assert.equal(result.rows.length, 109);
  assert.equal(result.rows[0].id, 'split-1');
  assert.equal(result.rows[108].id, 'split-109');
  assert.equal(countCalls, 1);
  assert.equal(pageCalls, 2);
});

test('C1C branding form reads tenants.name, never the global company_branding row', () => {
  const c1c = tenantBrandingFromRow({
    id: C1C.id,
    name: 'Condition One Commercial',
    business_address: 'C1C HQ',
    email_reply_to: 'payments@condition1commercial.com',
    logo_url: 'https://cdn.example/c1c.png',
  });
  const freedom = tenantBrandingFromRow({
    id: FREEDOM.id,
    name: 'Freedom Claims Adjusting',
    email_reply_to: 'claims@freedomadj.com',
  });
  assert.equal(c1c.companyName, 'Condition One Commercial');
  assert.equal(freedom.companyName, 'Freedom Claims Adjusting');
  assert.notEqual(c1c.companyName, freedom.companyName);
  const write = tenantBrandingWritePayload(c1c);
  assert.equal(write.name, 'Condition One Commercial');
  assert.deepEqual([...TENANT_BRANDING_WRITE_COLUMNS].sort(), Object.keys(write).sort());
  assert.ok(!('company_name' in write));
  assert.ok(!('email_from_name' in write));
  const settings = sourceOf('src/components/settings/CompanyBrandingSettings.tsx');
  assert.match(settings, /tenantBrandingFromRow/);
  assert.match(settings, /useTenant/);
  assert.doesNotMatch(settings, /company_branding/);
  const email = sourceOf('aws/functions/api/email-branding.mjs');
  assert.match(email, /FROM public\.tenants WHERE id = \$1/);
  assert.doesNotMatch(email, /company_branding/);
});

test('internal Mortgage Ops admin deny UX matches other platform-only admin routes', () => {
  const mortgage = sourceOf('src/pages/admin/AdminMortgageOps.tsx');
  const tenants = sourceOf('src/pages/admin/AdminTenants.tsx');
  const financial = sourceOf('src/pages/admin/AdminFinancialModel.tsx');
  assert.match(mortgage, /Access Restricted/);
  assert.match(tenants, /Access Restricted/);
  assert.match(financial, /Access Restricted/);
  assert.match(mortgage, /isPlatformOwner/);
  assert.doesNotMatch(mortgage, /toast\.error\("Not authorized"\)/);
  assert.doesNotMatch(mortgage, /navigate\("\/"\)/);
  assert.match(mortgage, /onAuthStateChange/);
  assert.match(mortgage, /Organization users submit and track mortgage-handling requests from Check Center/);
});

test('Mortgage Desk staff gate is mortgage_agent only, not tenant admin', async () => {
  const { isMortgageDeskStaff } = await import('../../src/lib/mortgageDeskAuth.ts');
  assert.equal(isMortgageDeskStaff(['mortgage_agent']), true);
  assert.equal(isMortgageDeskStaff(['admin', 'mortgage_agent']), true);
  assert.equal(isMortgageDeskStaff(['admin']), false);
  assert.equal(isMortgageDeskStaff(['staff']), false);
  assert.equal(isMortgageDeskStaff([]), false);
  const login = sourceOf('src/pages/mortgage-ops/MortgageOpsLogin.tsx');
  const queue = sourceOf('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  assert.match(login, /isMortgageDeskStaff/);
  assert.match(queue, /isMortgageDeskStaff/);
  assert.doesNotMatch(login, /userRole === "mortgage_agent" \|\| userRole === "admin"/);
  assert.doesNotMatch(queue, /userRole !== "mortgage_agent" && userRole !== "admin"/);
});
