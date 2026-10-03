import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEW_BOUNDARY,
  OLD_BOUNDARY,
  patchStagingEntry,
  patchStagingIndexHtml,
  patchStagingQueue,
} from "./staging-spa-dom-notfound-patch.mjs";

test("entry ignores transient DOM errors and drops auto-reload", () => {
  const input = `prefix${OLD_BOUNDARY}import("./MortgageOpsQueue-mopsRprB.js")suffix`;
  const next = patchStagingEntry(input, {
    fromQueue: "MortgageOpsQueue-mopsRprB.js",
    toQueue: "MortgageOpsQueue-mopsRprC.js",
  });
  assert.equal(next.includes(NEW_BOUNDARY), true);
  assert.equal(next.includes("checksops-error-boundary-reload"), false);
  assert.equal(next.includes("MortgageOpsQueue-mopsRprC.js"), true);
  assert.equal(next.includes("window.location.reload()"), false);
});

test("queue keeps a single React entry", () => {
  const input = 'from"./index-moprRprB.js";from"./index-moprRprB.js"';
  const next = patchStagingQueue(input, {
    fromEntry: "index-moprRprB.js",
    toEntry: "index-moprRprC.js",
  });
  assert.equal(next, 'from"./index-moprRprC.js";from"./index-moprRprC.js"');
});

test("index.html cache-busts to the new entry", () => {
  const next = patchStagingIndexHtml(
    '<script type="module" crossorigin src="/assets/index-moprRprB.js"></script>',
    { fromEntry: "index-moprRprB.js", toEntry: "index-moprRprC.js" },
  );
  assert.equal(next.includes("index-moprRprC.js"), true);
  assert.equal(next.includes("index-moprRprB.js"), false);
});
