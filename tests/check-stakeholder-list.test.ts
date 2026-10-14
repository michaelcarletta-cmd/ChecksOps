import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCheckStakeholderRows,
  formatUsdCents,
  mergeDisbursementPayees,
  partnerKey,
  releasedCentsByKey,
  releasedForRow,
  removedPartnerIds,
} from "../src/lib/payments/checkStakeholderList.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const ACCT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("a partner shared on the check shows up as a stakeholder automatically", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [],
    sharedPartners: [{ partner_tenant_id: P1, partner_name: "Roof Partners" }],
    removals: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, `partner:${P1}`);
  assert.equal(rows[0].kind, "partner");
  assert.equal(rows[0].name, "Roof Partners");
  assert.equal(rows[0].sharedLive, true);
  assert.equal(rows[0].status, "active");
});

test("saved stakeholders show even when their account cannot be read", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [
      { id: "cs1", added_via: "manual", stakeholder_account_id: ACCT, stakeholder_accounts: { id: ACCT, custname: "Jane Vendor", is_active: true } },
      { id: "cs2", added_via: "manual", stakeholder_account_id: ACCT2, stakeholder_accounts: null },
      { id: "cs3", added_via: "manual", stakeholder_account_id: "cccccccc-0000-4000-8000-000000000000", stakeholder_accounts: { id: "x", is_active: false } },
    ],
    sharedPartners: [],
    removals: [],
  });
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.checkStakeholderId]), [
    [ACCT, "Jane Vendor", "cs1"],
    [ACCT2, "Saved stakeholder", "cs2"],
  ]);
});

test("partner rows from check_stakeholders, shares and the picker appear once", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [
      // The partner's own account is hidden from us; the row is still listed.
      { id: "cs-p1", added_via: "partner_share", partner_tenant_id: P1, stakeholder_account_id: ACCT2, stakeholder_accounts: null, partner: null },
    ],
    sharedPartners: [
      { partner_tenant_id: P1, partner_name: "Roof Partners" },
      { partner_tenant_id: P2, partner_name: "Gutter Co" },
    ],
    removals: [],
    selectedPartners: [
      { partner_tenant_id: P2, partner_name: "Gutter Co" },
      { partner_tenant_id: P3, partner_name: "Siding LLC" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.key, r.source, r.name, r.sharedLive, r.selected]), [
    [`partner:${P1}`, "partner_share", "Roof Partners", true, false],
    [`partner:${P2}`, "shared", "Gutter Co", true, true],
    [`partner:${P3}`, "selected", "Siding LLC", false, true],
  ]);
  assert.equal(rows[0].checkStakeholderId, "cs-p1");
  assert.equal(rows[0].account, null);
});

test("de-duplication ignores the case of partner ids", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [{ id: "cs", partner_tenant_id: P1.toUpperCase(), partner: { name: "Roof Partners" } }],
    sharedPartners: [{ partner_tenant_id: P1, partner_name: "Roof Partners" }],
    removals: [{ id: "r1", partner_tenant_id: P1.toUpperCase() }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "removed");
});

test("a removal marks a shared partner removed, and only while the share is live", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [],
    sharedPartners: [
      { partner_tenant_id: P1, partner_name: "Roof Partners" },
      { partner_tenant_id: P2, partner_name: "Gutter Co" },
    ],
    removals: [
      { id: "r1", partner_tenant_id: P1 },
      // Share revoked: the stale removal does not hide a picker-selected partner.
      { id: "r3", partner_tenant_id: P3 },
    ],
    selectedPartners: [{ partner_tenant_id: P3, partner_name: "Siding LLC" }],
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey[`partner:${P1}`].status, "removed");
  assert.equal(byKey[`partner:${P1}`].removalId, "r1");
  assert.equal(byKey[`partner:${P2}`].status, "active");
  assert.equal(byKey[`partner:${P3}`].status, "active");
  assert.equal(byKey[`partner:${P3}`].removalId, null);

  assert.deepEqual(
    [...removedPartnerIds([{ partner_tenant_id: P1, partner_name: "" }], [{ id: "r1", partner_tenant_id: P1 }, { id: "r3", partner_tenant_id: P3 }])],
    [P1],
  );
});

test("released sums skip failed sends and match partners by destination tenant", () => {
  const released = releasedCentsByKey({
    transfers: [
      { amount_cents: 10000, status: "completed", destination_tenant_id: P1, provider_metadata: { recipient_kind: "partner", recipient_id: P1 } },
      { amount_cents: 2500, status: "pending", destination_tenant_id: P1, provider_metadata: { recipient_kind: "partner", recipient_id: P1 } },
      { amount_cents: 9999, status: "failed", destination_tenant_id: P1, provider_metadata: { recipient_kind: "partner", recipient_id: P1 } },
      { amount_cents: 7777, status: "canceled", destination_tenant_id: P1 },
      { amount_cents: 5555, status: "returned", destination_tenant_id: P1 },
      // Stakeholder send: matched by the recipient id recorded on the transfer.
      { amount_cents: "4000", status: "submitted", destination_tenant_id: null, provider_metadata: { recipient_kind: "stakeholder", recipient_id: ACCT } },
      { amount_cents: 300, status: "failed", destination_tenant_id: null, provider_metadata: { recipient_kind: "stakeholder", recipient_id: ACCT } },
    ],
    batches: [],
  });
  assert.equal(released.get(partnerKey(P1)), 12500);
  assert.equal(released.get(ACCT), 4000);
  assert.equal(released.get(partnerKey(P2)), undefined);
});

test("released sums add live disbursement splits for the stakeholder account", () => {
  const released = releasedCentsByKey({
    transfers: [{ amount_cents: 1000, status: "completed", provider_metadata: { recipient_kind: "stakeholder", recipient_id: ACCT } }],
    batches: [
      {
        status: "completed",
        disbursement_splits: [
          { amount: 12.34, status: "settled", stakeholder_account_id: ACCT },
          { amount: "5.00", status: "pending", stakeholder_account_id: ACCT },
          { amount: 50, status: "returned", stakeholder_account_id: ACCT },
          { amount: 60, status: "failed", stakeholder_account_id: ACCT },
          { amount: 7, status: "settled", stakeholder_account_id: ACCT2 },
        ],
      },
      { status: "failed", disbursement_splits: [{ amount: 100, status: "settled", stakeholder_account_id: ACCT }] },
      { status: "cancelled", disbursement_splits: [{ amount: 100, status: "pending", stakeholder_account_id: ACCT }] },
    ],
  });
  assert.equal(released.get(ACCT), 1000 + 1234 + 500);
  assert.equal(released.get(ACCT2), 700);
});

test("rows with nothing sent read $0.00", () => {
  const released = releasedCentsByKey({ transfers: [], batches: [] });
  assert.equal(releasedForRow(released, { key: `partner:${P1}` }), 0);
  assert.equal(formatUsdCents(0), "$0.00");
  assert.equal(formatUsdCents(123456), "$1,234.56");
  // Stakeholder keys are compared without regard to case.
  const r2 = releasedCentsByKey({ transfers: [{ amount_cents: 50, status: "completed", provider_metadata: { recipient_id: ACCT } }], batches: [] });
  assert.equal(releasedForRow(r2, { key: ACCT.toUpperCase() }), 50);
});

test("a partner row also counts external payments recorded on its stakeholder account", () => {
  const released = releasedCentsByKey({
    transfers: [{ amount_cents: 2500, status: "completed", destination_tenant_id: P1 }],
    batches: [{ status: "completed", disbursement_splits: [{ amount: 10, status: "settled", stakeholder_account_id: ACCT2 }] }],
  });
  assert.equal(releasedForRow(released, { key: `partner:${P1}`, stakeholderAccountId: ACCT2 }), 2500 + 1000);
  assert.equal(releasedForRow(released, { key: `partner:${P1}`, stakeholderAccountId: null }), 2500);
  // A stakeholder row whose key is its own account is not counted twice.
  assert.equal(releasedForRow(released, { key: ACCT2, stakeholderAccountId: ACCT2 }), 1000);
});

const makePartner = (p: { partner_tenant_id: string; partner_name: string; added_via: string }) => ({
  id: `partner:${p.partner_tenant_id}`,
  partner_tenant_id: p.partner_tenant_id,
  nickname: p.partner_name,
  added_via: p.added_via,
});

test("removed partners are left out of the payees, from every source", () => {
  const payees = mergeDisbursementPayees({
    ownAccounts: [
      { id: ACCT, partner_tenant_id: null, nickname: "Jane Vendor", added_via: "manual" },
      { id: `partner:${P1}`, partner_tenant_id: P1, nickname: "Roof Partners", added_via: "partner_share" },
    ],
    sharedPartners: [
      { partner_tenant_id: P1, partner_name: "Roof Partners" },
      { partner_tenant_id: P2, partner_name: "Gutter Co" },
      { partner_tenant_id: P3, partner_name: "Siding LLC" },
    ],
    selectedPartners: [{ partner_tenant_id: P2, partner_name: "Gutter Co" }],
    removedPartnerIds: new Set([P1, P2]),
    makePartner,
  });
  assert.deepEqual(payees.map((p) => p.id), [ACCT, `partner:${P3}`]);
});

test("without removals, partners merge once next to the check's stakeholders", () => {
  const payees = mergeDisbursementPayees({
    ownAccounts: [{ id: `partner:${P1}`, partner_tenant_id: P1, nickname: "Roof Partners", added_via: "partner_share" }],
    sharedPartners: [{ partner_tenant_id: P1, partner_name: "Roof Partners" }, { partner_tenant_id: P2, partner_name: "Gutter Co" }],
    selectedPartners: [{ partner_tenant_id: P2, partner_name: "Gutter Co" }, { partner_tenant_id: P3, partner_name: "Siding LLC" }],
    removedPartnerIds: new Set(),
    makePartner,
  });
  assert.deepEqual(payees.map((p) => [p.id, p.added_via]), [
    [`partner:${P1}`, "partner_share"],
    [`partner:${P2}`, "partner_share"],
    [`partner:${P3}`, "partner_selected"],
  ]);
});

test("a partner added by sharing leaves the list once the check is unshared", () => {
  const checkStakeholders = [
    { id: "cs-p1", added_via: "partner_share", partner_tenant_id: P1, stakeholder_account_id: ACCT2, stakeholder_accounts: null, partner: null },
    { id: "cs-p2", added_via: "partner_selected", partner_tenant_id: P2, stakeholder_account_id: ACCT, stakeholder_accounts: null, partner: null },
  ];
  const shared = buildCheckStakeholderRows({
    checkStakeholders,
    sharedPartners: [{ partner_tenant_id: P1, partner_name: "Roof Partners" }],
    removals: [],
  });
  assert.deepEqual(shared.map((r) => [r.key, r.sharedLive]), [
    [`partner:${P1}`, true],
    [`partner:${P2}`, false],
  ]);
  const unshared = buildCheckStakeholderRows({ checkStakeholders, sharedPartners: [], removals: [] });
  // The partner chosen in the picker stays; the shared one is gone.
  assert.deepEqual(unshared.map((r) => r.key), [`partner:${P2}`]);
});

test("unshared partners drop out of the payees; chosen partners stay", () => {
  const ownAccounts = [
    { id: "a1", partner_tenant_id: P1, added_via: "partner_share" },
    { id: "a2", partner_tenant_id: P2, added_via: "partner_selected" },
    { id: "a3", partner_tenant_id: null, added_via: "manual" },
  ];
  const kept = mergeDisbursementPayees({
    ownAccounts,
    sharedPartners: [],
    selectedPartners: [],
    removedPartnerIds: new Set<string>(),
    makePartner: (p) => ({ id: `partner:${p.partner_tenant_id}`, partner_tenant_id: p.partner_tenant_id, added_via: p.added_via }),
  });
  assert.deepEqual(kept.map((a) => a.id), ["a2", "a3"]);
  const stillShared = mergeDisbursementPayees({
    ownAccounts,
    sharedPartners: [{ partner_tenant_id: P1.toUpperCase(), partner_name: "Roof Partners" }],
    selectedPartners: [],
    removedPartnerIds: new Set<string>(),
    makePartner: (p) => ({ id: `partner:${p.partner_tenant_id}`, partner_tenant_id: p.partner_tenant_id, added_via: p.added_via }),
  });
  assert.deepEqual(stillShared.map((a) => a.id), ["a1", "a2", "a3"]);
});

test("while the check's shares are unknown, no partner row is hidden", () => {
  const rows = buildCheckStakeholderRows({
    checkStakeholders: [
      { id: "cs-p1", added_via: "partner_share", partner_tenant_id: P1, stakeholder_account_id: ACCT2, stakeholder_accounts: null, partner: null },
    ],
    sharedPartners: [],
    removals: [],
    sharesKnown: false,
  });
  assert.deepEqual(rows.map((r) => r.key), [`partner:${P1}`]);
  const payees = mergeDisbursementPayees({
    ownAccounts: [{ id: "a1", partner_tenant_id: P1, added_via: "partner_share" }],
    sharedPartners: [],
    selectedPartners: [],
    removedPartnerIds: new Set<string>(),
    sharesKnown: false,
    makePartner: (p) => ({ id: `partner:${p.partner_tenant_id}`, partner_tenant_id: p.partner_tenant_id, added_via: p.added_via }),
  });
  assert.deepEqual(payees.map((a) => a.id), ["a1"]);
});
