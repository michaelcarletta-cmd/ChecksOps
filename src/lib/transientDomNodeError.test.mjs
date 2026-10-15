import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientDomNodeError } from "./transientDomNodeError.ts";

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
