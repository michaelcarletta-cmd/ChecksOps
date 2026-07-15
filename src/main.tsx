// Build bump: refresh published bundle with production backend config
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { isCheckOpsHost, isMortgageOpsHost } from "./lib/checkopsHost";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
