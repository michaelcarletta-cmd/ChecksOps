/**
 * Live updates without a page refresh (owner, 2026-10-26): when a check is uploaded, moved to
 * another status, or anything else is saved, every screen showing that data updates on its own.
 *
 * The AWS backend has no realtime channel, so the app signals changes itself: every successful
 * write through the data client (table insert/update/upsert/delete, a mutating RPC, an action
 * function) emits a "data changed" signal. The signal refreshes the queries on screen at once and
 * marks the rest stale, in this tab and, through BroadcastChannel, in the user's other tabs.
 * Changes made by other people still arrive through the polling in useAwsPollingFallback.
 *
 * Reads never signal: a query that signalled would refresh itself in a loop. Bookkeeping writes
 * made while a screen renders (audit rows, read receipts, sessions) do not signal either, for the
 * same reason. The refresh scheduler also caps bursts, so a missed case cannot loop quickly.
 *
 * Pure module (no "@/" imports) so aws/tests can import it directly.
 */

export type DataChangeSource = "table" | "rpc" | "function";
export type DataChange = { source: DataChangeSource; name: string };
export type DataChangeListener = (change: DataChange) => void;

const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);

/** Tables written as a side effect of viewing a screen; they change nothing anyone sees. */
export const QUIET_TABLES: ReadonlySet<string> = new Set([
  "audit_logs",
  "check_audit_log",
  "check_endorsement_events",
  "check_message_reads",
  "loss_draft_audit_log",
  "notification_preferences",
  "privacy_notice_acknowledgments",
  "user_sessions",
]);

/** RPCs that change nothing on screen (logging, session bookkeeping). */
const QUIET_RPCS = new Set([
  "log_audit",
  "register_session",
  "invalidate_session",
  "validate_session",
  "contractor_verification_status",
]);

/** Read-only RPC name shapes (get_, list_, is_, has_ …). */
const READ_RPC = /^(get|list|is|has|can|count|search|fetch|lookup|validate)_/;

/** True when a table write should refresh the screen. */
export function tableWriteSignals(table: string, op: string): boolean {
  return WRITE_OPS.has(op) && !QUIET_TABLES.has(table);
}

/** True when an RPC changes data (anything that is not a read or bookkeeping). */
export function rpcSignals(name: string): boolean {
  return !QUIET_RPCS.has(name) && !READ_RPC.test(name);
}

/**
 * Functions that change data. An allowlist, not a denylist: several functions both read and
 * write depending on the body, and a read that signalled from inside a query would loop.
 */
export const SIGNALLING_FUNCTIONS: ReadonlySet<string> = new Set([
  "check-endorsement",
  "check-ocr-intake",
  "composite-endorsement-signatures",
  "create-tenant-user",
  "hire-mortgage-agent",
  "homeowner-bank-link-send",
  "homeowner-deductible-pay",
  "homeowner-ledger-attach-upload",
  "homeowner-ledger-send",
  "homeowner-ledger-upload",
  "homeowner-upload-check",
  "moov-bank-account-add",
  "moov-disburse",
  "moov-invoice",
  "moov-micro-deposit-confirm",
  "moov-micro-deposit-initiate",
  "moov-recipient-create",
  "moov-recipient-disconnect",
  "moov-recipient-link-resend",
  "moov-wallet-fund",
  "notify-mortgage-handling-request",
  "retry-pdf-generation",
  "send-payment-direction-request",
  "send-portal-invite",
  "send-signature-request",
  "stakeholder-resend-verification",
  "tenant-credit-topup",
  "tenant-invite-resend",
  "tenant-invite-user",
  "tenant-library-document-create",
  "tenant-remove-openai-key",
  "tenant-set-openai-key",
]);

export function functionSignals(name: string): boolean {
  return SIGNALLING_FUNCTIONS.has(name);
}

const succeeded = (result: unknown) =>
  !!result && typeof result === "object" && !(result as { error?: unknown }).error;

/**
 * Wrap a data client (the AWS adapter's supabase-shaped client) so successful writes call
 * `notify`. Reads, failed writes and quiet writes pass through unchanged.
 */
type Fn = (...args: unknown[]) => unknown;
type DataClient = {
  from: (table: string) => object;
  rpc: (name: string, ...rest: unknown[]) => Promise<unknown>;
  functions?: { invoke: (name: string, ...rest: unknown[]) => Promise<unknown> };
};

export function withDataChangeSignals<C extends DataClient>(client: C, notify: DataChangeListener): C {
  const wrapBuilder = (table: string, builder: object) => {
    let op = "select";
    const proxy: object = new Proxy(builder, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const fn = value as Fn;
        if (prop === "then") {
          return (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
            fn.call(
              target,
              (result: unknown) => {
                if (succeeded(result) && tableWriteSignals(table, op)) notify({ source: "table", name: table });
                return resolve ? resolve(result) : result;
              },
              reject,
            );
        }
        return (...args: unknown[]) => {
          if (typeof prop === "string" && WRITE_OPS.has(prop)) op = prop;
          const out = fn.apply(target, args);
          // The adapter's builder methods return the builder itself; keep chaining on the proxy.
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };

  const from = (table: string) => wrapBuilder(table, client.from(table));

  const rpc = async (name: string, ...rest: unknown[]) => {
    const result = await client.rpc(name, ...rest);
    if (succeeded(result) && rpcSignals(name)) notify({ source: "rpc", name });
    return result;
  };

  const invoke = client.functions?.invoke;
  const functions = client.functions && invoke && {
    ...client.functions,
    invoke: async (name: string, ...rest: unknown[]) => {
      const result = await invoke.call(client.functions, name, ...rest);
      if (succeeded(result) && functionSignals(name)) notify({ source: "function", name });
      return result;
    },
  };

  return Object.assign(Object.create(Object.getPrototypeOf(client)), client, { from, rpc, functions }) as C;
}

// ---------------------------------------------------------------- signal bus

const listeners = new Set<DataChangeListener>();
const CHANNEL_NAME = "checksops-data-changed";
let channel: BroadcastChannel | null = null;

function broadcastChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    // Node (tests) keeps a process alive for an open channel; browsers have no unref.
    (channel as unknown as { unref?: () => void }).unref?.();
    channel.onmessage = (event) => {
      const change = event?.data as DataChange | undefined;
      if (change && typeof change.name === "string") listeners.forEach((l) => l(change));
    };
  } catch {
    channel = null;
  }
  return channel;
}

/** Signal a change to this tab and the user's other tabs. */
export function emitDataChange(change: DataChange): void {
  listeners.forEach((l) => l(change));
  try {
    broadcastChannel()?.postMessage(change);
  } catch {
    /* another tab missing an update is not an error */
  }
}

export function onDataChange(listener: DataChangeListener): () => void {
  listeners.add(listener);
  broadcastChannel();
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------- refresh scheduler

export type RefreshSchedulerOptions = {
  refresh: () => void;
  /** Collect a burst of signals (a save that writes several rows) into one refresh. */
  debounceMs?: number;
  /** At most this many refreshes per window; signals past the cap wait for the window to end. */
  burstLimit?: number;
  burstWindowMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
};

export function createRefreshScheduler(options: RefreshSchedulerOptions) {
  const debounceMs = options.debounceMs ?? 150;
  const burstLimit = options.burstLimit ?? 6;
  const burstWindowMs = options.burstWindowMs ?? 20_000;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let recent: number[] = [];
  let timer: unknown = null;

  const run = () => {
    timer = null;
    const t = now();
    recent = recent.filter((at) => t - at < burstWindowMs);
    if (recent.length >= burstLimit) {
      // Over the cap: one refresh when the oldest in the window ages out.
      timer = setTimer(run, burstWindowMs - (t - recent[0]));
      return;
    }
    recent.push(t);
    options.refresh();
  };

  return {
    signal() {
      if (timer !== null) return;
      timer = setTimer(run, debounceMs);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
