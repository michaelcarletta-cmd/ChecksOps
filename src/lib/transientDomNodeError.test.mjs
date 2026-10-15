import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransientRecoveryGate, isTransientDomNodeError } from "./transientDomNodeError.ts";

test("ignores WebKit NotFoundError after a focused node unmounts", () => {
  const error = new Error("The object can not be found here.");
  error.name = "NotFoundError";
  assert.equal(isTransientDomNodeError(error), true);
});

test("ignores Chromium removeChild NotFoundError", () => {
  const error = new Error(
    "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
  );
  error.name = "NotFoundError";
  assert.equal(isTransientDomNodeError(error), true);
});

test("does not swallow React invalid-hook or application errors", () => {
  assert.equal(isTransientDomNodeError(new Error("Minified React error #321")), false);
  assert.equal(isTransientDomNodeError(new Error("Write transaction did not commit")), false);
  assert.equal(isTransientDomNodeError(null), false);
});

test("a bare NotFoundError name is a real error, not a DOM glitch", () => {
  const idb = new Error("No database found");
  idb.name = "NotFoundError";
  assert.equal(isTransientDomNodeError(idb), false);
  const media = new Error("Requested device not found");
  media.name = "NotFoundError";
  assert.equal(isTransientDomNodeError(media), false);
});

test("repeated transient DOM errors stop recovering after the limit", () => {
  const gate = createTransientRecoveryGate(2, 10_000);
  const error = new Error("The node to be removed is not a child of this node.");
  assert.equal(gate(error, 1_000), true);
  assert.equal(gate(error, 1_100), true);
  assert.equal(gate(error, 1_200), false);
  assert.equal(gate(error, 12_000), true);
  assert.equal(gate(new Error("Write transaction did not commit"), 20_000), false);
});
