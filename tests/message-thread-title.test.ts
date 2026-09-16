import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMessageThreadTitle } from "../src/lib/messageThreadTitle.ts";

const FULL_PAYEE_LINE =
  "John Smith & Jane Smith & Freedom Adjustment & Wells Fargo Bank, N.A.";

test("uses insured check payees and formats a shared last name", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "John Smith", payee_type: "insured" },
      { payee_name: "Jane Smith", payee_type: "insured" },
      { payee_name: "Freedom Adjustment", payee_type: "public_adjuster" },
      { payee_name: "Wells Fargo Bank, N.A.", payee_type: "mortgage_company" },
    ],
    policyholderName: "Should not win",
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, "John & Jane Smith");
});

test("treats homeowner and policyholder payee types as insured", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "John Smith", payee_type: "homeowner" },
      { payee_name: "Jane Smith", payee_type: "policyholder" },
    ],
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, "John & Jane Smith");
});

test("falls back to claim named insured when no insured payees exist", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "Freedom Adjustment", payee_type: "public_adjuster" },
      { payee_name: "Wells Fargo Bank, N.A.", payee_type: "mortgage_company" },
    ],
    policyholderName: "John Smith & Jane Smith",
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, "John & Jane Smith");
});

test("does not strip companies out of the payee line when no structured insured exists", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "Freedom Adjustment", payee_type: "public_adjuster" },
      { payee_name: "Wells Fargo Bank, N.A.", payee_type: "mortgage_company" },
    ],
    policyholderName: null,
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, FULL_PAYEE_LINE);
});

test("never returns Unknown", () => {
  assert.equal(
    resolveMessageThreadTitle({
      payees: [],
      policyholderName: "Unknown",
      fallbackTitle: "Unknown.",
    }),
    null,
  );
  assert.equal(
    resolveMessageThreadTitle({
      payees: [{ payee_name: "Unknown", payee_type: "insured" }],
      fallbackTitle: FULL_PAYEE_LINE,
    }),
    FULL_PAYEE_LINE,
  );
});

test("keeps distinct last names joined without inventing a shared surname", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "John Smith", payee_type: "insured" },
      { payee_name: "Maria Garcia", payee_type: "insured" },
    ],
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, "John Smith & Maria Garcia");
});

test("ignores blank insured names and prefers remaining structured insured", () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: "  ", payee_type: "insured" },
      { payee_name: "Jane Smith", payee_type: "insured" },
    ],
    fallbackTitle: FULL_PAYEE_LINE,
  });
  assert.equal(title, "Jane Smith");
});
