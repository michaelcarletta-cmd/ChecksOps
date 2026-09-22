// Build bump: refresh published bundle with production backend config
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { apexCanonicalRedirectUrl } from "./lib/awsHost";
import { isCheckOpsHost, isMortgageOpsHost } from "./lib/checkopsHost";
import "./index.css";

if (typeof window !== "undefined") {
  const apex = apexCanonicalRedirectUrl({
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
  if (apex) {
    window.location.replace(apex);
  }
}

if (typeof window !== "undefined" && apexCanonicalRedirectUrl({
  hostname: window.location.hostname,
  protocol: window.location.protocol,
  pathname: window.location.pathname,
})) {
  // Redirect in progress; skip hydrating the www origin.
} else {

// Set document title + meta based on host
if (typeof window !== "undefined") {
  if (isMortgageOpsHost()) {
    document.title = "ChecksOps Mortgage Desk";
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", "ChecksOps employee portal for handling mortgage company tasks.");
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", "ChecksOps Mortgage Desk");
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    if (twitterTitle) twitterTitle.setAttribute("content", "ChecksOps Mortgage Desk");
  } else if (isCheckOpsHost()) {
    document.title = "ChecksOps";
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", "ChecksOps");
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    if (twitterTitle) twitterTitle.setAttribute("content", "ChecksOps");
  }
}

const skipWwwHydrate = typeof window !== "undefined" && Boolean(apexCanonicalRedirectUrl({
  hostname: window.location.hostname,
  protocol: window.location.protocol,
  pathname: window.location.pathname,
}));
if (!skipWwwHydrate) {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}
