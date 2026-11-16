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

// www.checksops.com is sent to the same path on checksops.com: one address, so
// passkeys (bound to checksops.com) and saved sign-ins work whichever is typed.
var CANONICAL_ORIGIN = "https://checksops.com";
var REDIRECT_HOSTS = { "www.checksops.com": true };

function queryString(querystring) {
  var parts = [];
  var keys = Object.keys(querystring || {});
  for (var i = 0; i < keys.length; i++) {
    var entry = querystring[keys[i]];
    var values = entry && entry.multiValue ? entry.multiValue : [entry];
    for (var j = 0; j < values.length; j++) {
      var value = values[j] && values[j].value;
      parts.push(value === undefined || value === "" ? keys[i] : keys[i] + "=" + value);
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = request.headers && request.headers.host ? String(request.headers.host.value).toLowerCase() : "";

  // Attached only to the S3 default behavior. Still refuse to rewrite
  // /prep so an accidental association cannot HTML-ify the API. /prep is
  // never redirected either: a POST would lose its body on a 301.
  if (uri === "/prep" || uri.indexOf("/prep/") === 0) {
    return request;
  }

  if (REDIRECT_HOSTS[host] === true) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: { value: CANONICAL_ORIGIN + uri + queryString(request.querystring) },
        "cache-control": { value: "max-age=3600" }
      }
    };
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
