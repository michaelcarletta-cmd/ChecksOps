/**
 * Staging-only string transform: stop AppErrorBoundary from sticking on
 * transient removeChild / NotFoundError, and drop the reload-once loop.
 */
export const OLD_BOUNDARY = 'static getDerivedStateFromError(n){return{hasError:!0,error:n}}componentDidCatch(n,r){console.error("AppErrorBoundary caught:",n,r);try{const k="checksops-error-boundary-reload";if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,"1");window.location.reload()}}catch(e){}}';

export const OLD_BOUNDARY_ORIGINAL = 'static getDerivedStateFromError(n){return{hasError:!0,error:n}}componentDidCatch(n,r){console.error("AppErrorBoundary caught:",n,r)}';

export const NEW_BOUNDARY = 'static getDerivedStateFromError(n){var e=String(n&&n.message||""),t=String(n&&n.name||"");return t==="NotFoundError"||e.indexOf("removeChild")>=0||e.indexOf("The object can not be found here")>=0||e.indexOf("The node to be removed is not a child")>=0?{hasError:!1,error:null}:{hasError:!0,error:n}}componentDidCatch(n,r){console.error("AppErrorBoundary caught:",n,r)}';

export const OLD_TRY_AGAIN = 'onClick:()=>this.setState({hasError:!1,error:null})';
export const NEW_TRY_AGAIN = 'onClick:()=>window.location.reload()';

export function patchStagingEntry(indexJs, { fromQueue, toQueue }) {
  if (!indexJs.includes(OLD_BOUNDARY)) {
    throw new Error("live entry missing expected sticky error-boundary");
  }
  if (indexJs.includes("checksops-error-boundary-reload") === false) {
    throw new Error("live entry missing auto-reload that must be removed");
  }
  let next = indexJs.replace(OLD_BOUNDARY, NEW_BOUNDARY);
  next = next.replaceAll(fromQueue, toQueue);
  if (next.includes(OLD_BOUNDARY)) {
    throw new Error("error-boundary replace did not apply");
  }
  if (next.includes("checksops-error-boundary-reload")) {
    throw new Error("auto-reload still present");
  }
  if (next.includes(fromQueue)) {
    throw new Error("queue chunk name still points at old file");
  }
  if (!next.includes(toQueue)) {
    throw new Error("queue chunk was not retargeted");
  }
  if (!next.includes("hasError:!1,error:null")) {
    throw new Error("transient DOM ignore missing");
  }
  return next;
}

export function patchStagingQueue(queueJs, { fromEntry, toEntry }) {
  if ((queueJs.match(new RegExp(fromEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length < 1) {
    throw new Error("queue does not import the current React entry");
  }
  const next = queueJs.replaceAll(fromEntry, toEntry);
  if (next.includes(fromEntry)) {
    throw new Error("queue still imports old React entry");
  }
  if (!next.includes(toEntry)) {
    throw new Error("queue was not retargeted to new React entry");
  }
  return next;
}

export function patchOriginalStagingEntry(indexJs, { fromQueue, toQueue }) {
  if (!indexJs.includes(OLD_BOUNDARY_ORIGINAL)) {
    throw new Error("original entry missing expected error-boundary");
  }
  if (indexJs.includes("checksops-error-boundary-reload")) {
    throw new Error("original entry unexpectedly has auto-reload");
  }
  if (!indexJs.includes(OLD_TRY_AGAIN)) {
    throw new Error("original entry missing Try-again remount");
  }
  let next = indexJs.replace(OLD_BOUNDARY_ORIGINAL, NEW_BOUNDARY);
  next = next.replace(OLD_TRY_AGAIN, NEW_TRY_AGAIN);
  next = next.replaceAll(fromQueue, toQueue);
  if (next.includes(OLD_BOUNDARY_ORIGINAL) || next.includes(OLD_TRY_AGAIN)) {
    throw new Error("original entry patch did not apply");
  }
  if (next.includes(fromQueue)) {
    throw new Error("original entry still lazy-loads old queue");
  }
  if (!next.includes(toQueue) || !next.includes("hasError:!1,error:null")) {
    throw new Error("original entry missing patched queue or DOM ignore");
  }
  return next;
}

export function patchStagingIndexHtml(html, { fromEntry, toEntry }) {
  if (!html.includes(`/assets/${fromEntry}`)) {
    throw new Error("index.html does not point at current entry");
  }
  const next = html.replaceAll(`/assets/${fromEntry}`, `/assets/${toEntry}`);
  if (next.includes(fromEntry) || !next.includes(`/assets/${toEntry}`)) {
    throw new Error("index.html rewrite failed");
  }
  return next;
}
