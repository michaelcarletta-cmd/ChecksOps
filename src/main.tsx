import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { isCheckOpsHost } from "./lib/checkopsHost";
import "./index.css";

// Set document title + meta based on host (ChecksOps white-label vs Freedom CRM)
if (typeof window !== "undefined" && isCheckOpsHost()) {
  document.title = "ChecksOps";
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute("content", "ChecksOps");
  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.setAttribute("content", "ChecksOps");
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
