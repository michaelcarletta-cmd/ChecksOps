/**
 * Stakeholder Resend targeting tests — pure logic, no network, no database.
 *
 * Run: bun scripts/test-stakeholder-resend-target.mjs
 */
import assert from "node:assert/strict";
import {
  canResendSetupLink,
  linkedRecipients,
  resendConfirmCopy,
  setupLinkEmail,
  shouldListStakeholder,
} from "../src/lib/stakeholderResendTarget.ts";

const TARGET = {
  id: "724952c9-eb56-4c52-b28e-06907198c406",
  account_type: "subcontractor",
  origin: "tenant_owned",
  is_active: false,
  verification_status: "pending",
  verification_recipient_email: "carlettacrew@gmail.com",
  nickname: "Michael Carletta",
  custname: "Michael Carletta",
  homeowner_name: null,
  external_payment_recipients: {
    id: "62a858ff-ee6a-49d7-9898-1c8e4a44227b",
    email: "carlettacrew@gmail.com",
    environment: "production",
    provider_last_four: "1506",
    provider_bank_name: "JPMORGAN CHASE BANK, NA",
    onboarding_status: "awaiting_bank",
  },
};

const SANDBOX_HOMEOWNER = {
  id: "2ad87468-15cd-437c-ba9c-c4a896dc5365",
  account_type: "homeowner",
  origin: "tenant_owned",
  is_active: true,
  verification_status: "unverified",
  verification_recipient_email: "runvs626@gmail.com",
  nickname: "Michael",
  custname: "Michael Carletta",
  homeowner_name: null,
  external_payment_recipients: {
    id: "3269bd10-4504-4a8f-a4ea-e41f41d32562",
    email: "runvs626@gmail.com",
    environment: "sandbox",
    provider_last_four: null,
    provider_bank_name: null,
    onboarding_status: "awaiting_bank",
  },
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("legacy is_active filter hides the production target", () => {
  assert.equal(TARGET.is_active, false);
  assert.equal(SANDBOX_HOMEOWNER.is_active, true);
});

test("list helper still shows the active sandbox homeowner", () => {
  assert.equal(shouldListStakeholder(SANDBOX_HOMEOWNER), true);
});

test("list helper now shows the inactive production recipient", () => {
  assert.equal(shouldListStakeholder(TARGET), true);
});

test("operating and provider_connected rows stay excluded", () => {
  assert.equal(shouldListStakeholder({ ...TARGET, account_type: "operating", is_active: true }), false);
  assert.equal(shouldListStakeholder({ ...TARGET, origin: "provider_connected", is_active: true }), false);
});

test("inactive rows without a linked recipient stay hidden", () => {
  assert.equal(shouldListStakeholder({ ...TARGET, external_payment_recipients: null }), false);
});

test("resend is allowed for pending/unverified when an email exists", () => {
  assert.equal(canResendSetupLink(TARGET), true);
  assert.equal(canResendSetupLink(SANDBOX_HOMEOWNER), true);
  assert.equal(canResendSetupLink({ ...TARGET, verification_status: "verified" }), false);
});

test("confirm copy binds by stakeholder id and shows email + env + last4", () => {
  const copy = resendConfirmCopy(TARGET);
  assert.equal(copy.stakeholderId, "724952c9-eb56-4c52-b28e-06907198c406");
  assert.equal(copy.recipientId, "62a858ff-ee6a-49d7-9898-1c8e4a44227b");
  assert.equal(copy.email, "carlettacrew@gmail.com");
  assert.equal(copy.accountType, "subcontractor");
  assert.equal(copy.environment, "production");
  assert.equal(copy.bankLast4, "1506");
  assert.notEqual(copy.email, setupLinkEmail(SANDBOX_HOMEOWNER));
  assert.notEqual(copy.stakeholderId, SANDBOX_HOMEOWNER.id);
});

test("sandbox confirm copy is distinguishable from the production target", () => {
  const copy = resendConfirmCopy(SANDBOX_HOMEOWNER);
  assert.equal(copy.email, "runvs626@gmail.com");
  assert.equal(copy.accountType, "homeowner");
  assert.equal(copy.environment, "sandbox");
  assert.equal(copy.bankLast4, null);
});

test("linkedRecipients accepts a single object or an array", () => {
  assert.equal(linkedRecipients(TARGET).length, 1);
  assert.equal(linkedRecipients({ ...TARGET, external_payment_recipients: [TARGET.external_payment_recipients] }).length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok  ${name}`);
    console.error(err);
  }
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log(`${tests.length} passed`);
