import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionErrorMessage } from "../src/lib/edgeFunctionError.ts";

test("AWS adapter FunctionsHttpError objects expose the server error", async () => {
  const message = await getFunctionErrorMessage({
    name: "FunctionsHttpError",
    message: "FunctionsHttpError:send-signature-request",
    context: {
      status: 403,
      body: { ok: false, error: "forbidden" },
    },
  }, "Could not send signature request");
  assert.equal(message, "forbidden");
});

test("AWS adapter falls back to HTTP status when the body has no public error", async () => {
  const message = await getFunctionErrorMessage({
    name: "FunctionsHttpError",
    message: "FunctionsHttpError:send-signature-request",
    context: { status: 503, body: { ok: false } },
  }, "Could not send signature request");
  assert.equal(message, "FunctionsHttpError:send-signature-request");
});

test("does not leak tokens or stack traces from adapter errors", async () => {
  const tokenMessage = await getFunctionErrorMessage({
    name: "FunctionsHttpError",
    message: "access_token=abc",
    context: {
      status: 500,
      body: { error: "token_hash=deadbeef" },
    },
  }, "Could not send signature request");
  assert.equal(tokenMessage, "Could not send signature request (HTTP 500)");

  const stackMessage = await getFunctionErrorMessage({
    name: "FunctionsHttpError",
    message: "boom",
    context: {
      status: 500,
      body: { error: "failed\n    at runSendSignatureRequest (esign.mjs:1:1)" },
    },
  }, "Could not send signature request");
  assert.equal(stackMessage, "boom");
});
