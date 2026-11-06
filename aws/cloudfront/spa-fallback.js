// Public marketing pages that have their own S3 object of the same name,
// built with the page's own head: every MARKETING_PAGES path but "/" in
// src/pages/marketing/marketingPages.ts (the test
// aws/tests/github-production-spa-fallback.test.mjs keeps the two equal).
var MARKETING_PAGES = {
  "/pricing": true,
  "/vs/checksops-vs-iink-payments": true,
  "/vs/checksops-vs-snapsheet": true,
  "/vs/checksops-vs-guidewire-claimcenter": true,
  "/claim-check-tracking": true
};

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Attached only to the S3 default behavior. Still refuse to rewrite
  // /prep so an accidental association cannot HTML-ify the API.
  if (uri === "/prep" || uri.indexOf("/prep/") === 0) {
    return request;
  }

  // Exact match only: "/pricing/" still falls through to /index.html.
  if (MARKETING_PAGES[uri] === true) {
    return request;
  }

  var slash = uri.lastIndexOf("/");
  var last = slash === -1 ? uri : uri.substring(slash + 1);
  if (last.indexOf(".") !== -1) {
    return request;
  }

  request.uri = "/index.html";
  return request;
}
