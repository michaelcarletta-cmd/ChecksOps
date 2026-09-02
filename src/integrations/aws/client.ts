import type { Session, User } from "@supabase/supabase-js";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { createAwsStorageAdapter } from "./storage";

const SESSION_KEY = "checksops.aws.staging.auth";
const TESTER_EMAIL = "checksops-tester@freedomadj.com";

type AuthListener = (event: string, session: Session | null) => void;

type QueryState = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  select: string;
  filters: Array<Record<string, unknown>>;
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
  offset: number | null;
  count: string | null;
  head: boolean;
  single: boolean;
  maybeSingle: boolean;
  payload: unknown;
};

const listeners = new Set<AuthListener>();

const emit = (event: string, session: Session | null) => {
  listeners.forEach((listener) => {
    try {
      listener(event, session);
    } catch {
      /* ignore listener errors */
    }
  });
};

const authError = (message: string, extra: Record<string, unknown> = {}) => ({
  name: "AuthApiError",
  message,
  status: extra.status || 400,
  ...extra,
});

const postgrestError = (message: string, code = "42501", extra: Record<string, unknown> = {}) => ({
  message,
  details: extra.details || null,
  hint: extra.hint || null,
  code,
  ...extra,
});

const readStored = (): Record<string, unknown> | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStored = (value: Record<string, unknown> | null) => {
  try {
    if (!value) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
};

const toUser = (identity: Record<string, unknown>, emailFallback?: string | null): User => {
  const applicationUserId = String(identity.applicationUserId || "");
  const email = String((identity.profile as Record<string, unknown> | undefined)?.email || identity.email || emailFallback || "");
  const now = new Date().toISOString();
  return {
    id: applicationUserId,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: now,
    phone: "",
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: "cognito", providers: ["cognito"] },
    user_metadata: {
      email,
      full_name: (identity.profile as Record<string, unknown> | undefined)?.fullName || null,
      application_user_id: applicationUserId,
    },
    identities: [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  } as User;
};

const toSession = (tokens: Record<string, unknown>, user: User): Session => {
  const expiresIn = Number(tokens.expiresIn || 3600);
  return {
    access_token: String(tokens.idToken || ""),
    refresh_token: String(tokens.refreshToken || ""),
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: "bearer",
    user,
  } as Session;
};

const apiUrl = (path: string) => `${awsApiBaseUrl()}${path}`;

const apiFetch = async (path: string, init: RequestInit = {}, token?: string | null) => {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { response, body };
};

async function identityFromTokens(tokens: Record<string, unknown>, emailFallback?: string | null) {
  const idToken = String(tokens.idToken || "");
  const { response, body } = await apiFetch("/identity/me", { method: "GET" }, idToken);
  if (!response.ok || !body.applicationUserId) {
    throw authError(String(body.error || "identity_not_linked"), { status: response.status, details: body });
  }
  if (String(body.applicationUserId) === String(body.cognitoSub)) {
    throw authError("refusing identity mapping where application_user_id equals cognito_sub");
  }
  const user = toUser(body, emailFallback);
  const session = toSession(tokens, user);
  writeStored({
    tokens: {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    },
    user,
    expiresAt: session.expires_at,
  });
  return { user, session };
}

let refreshInFlight: Promise<{ session: Session | null; error: unknown }> | null = null;

async function restoreSession(forceRefresh = false): Promise<{ session: Session | null; error: unknown }> {
  const stored = readStored();
  if (!stored?.tokens || !stored.user) return { session: null, error: null };
  const expiresAt = Number(stored.expiresAt || 0);
  const shouldRefresh = forceRefresh || !expiresAt || expiresAt * 1000 < Date.now() + 60_000;
  if (!shouldRefresh) {
    const session = toSession(stored.tokens as Record<string, unknown>, stored.user as User);
    return { session, error: null };
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const { response, body } = await apiFetch("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: (stored.tokens as Record<string, unknown>).refreshToken }),
    });
    if (!response.ok || !body.authentication) {
      writeStored(null);
      emit("SIGNED_OUT", null);
      return { session: null, error: authError("session_expired", { status: 401, code: "session_expired" }) };
    }
    const mapped = await identityFromTokens(body.authentication as Record<string, unknown>, (stored.user as User).email);
    emit("TOKEN_REFRESHED", mapped.session);
    return { session: mapped.session, error: null };
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function createBuilder(table: string) {
  const state: QueryState = {
    table,
    op: "select",
    select: "*",
    filters: [],
    order: null,
    limit: null,
    offset: null,
    count: null,
    head: false,
    single: false,
    maybeSingle: false,
    payload: null,
  };

  const execute = async () => {
    if (state.op !== "select") {
      return {
        data: null,
        error: postgrestError("writes_disabled", "42501", {
          hint: "Staging application writes are disabled (default_transaction_read_only=on)",
        }),
        count: null,
        status: 403,
        statusText: "Forbidden",
      };
    }
    const restored = await restoreSession();
    const token = restored.session?.access_token;
    const allowPublicTenant = state.table === "tenants_public" && state.op === "select";
    if (!token && !allowPublicTenant) {
      return {
        data: null,
        error: postgrestError("JWT expired", "PGRST301"),
        count: null,
        status: 401,
        statusText: "Unauthorized",
      };
    }
    const { response, body } = await apiFetch("/data/query", {
      method: "POST",
      body: JSON.stringify({
        table: state.table,
        op: "select",
        select: state.select,
        filters: state.filters,
        order: state.order,
        limit: state.limit,
        offset: state.offset,
        count: state.count,
        head: state.head,
        single: state.single,
        maybeSingle: state.maybeSingle,
      }),
    }, token);
    if (response.status === 401) {
      writeStored(null);
      emit("SIGNED_OUT", null);
    }
    if (!response.ok) {
      return {
        data: body.data ?? null,
        error: postgrestError(String(body.message || body.error || "query_failed"), String(body.error || "42501")),
        count: body.count ?? null,
        status: response.status,
        statusText: response.statusText,
      };
    }
    return {
      data: body.data ?? null,
      error: null,
      count: body.count ?? null,
      status: 200,
      statusText: "OK",
    };
  };

  const builder: any = {
    select(columns?: string, options?: { count?: string; head?: boolean }) {
      if (typeof columns === "string") state.select = columns;
      if (options?.count) state.count = options.count;
      if (options?.head) state.head = true;
      return builder;
    },
    insert(payload: unknown) {
      state.op = "insert";
      state.payload = payload;
      return builder;
    },
    update(payload: unknown) {
      state.op = "update";
      state.payload = payload;
      return builder;
    },
    upsert(payload: unknown) {
      state.op = "upsert";
      state.payload = payload;
      return builder;
    },
    delete() {
      state.op = "delete";
      return builder;
    },
    eq(column: string, value: unknown) {
      state.filters.push({ column, op: "eq", value });
      return builder;
    },
    neq(column: string, value: unknown) {
      state.filters.push({ column, op: "neq", value });
      return builder;
    },
    gt(column: string, value: unknown) {
      state.filters.push({ column, op: "gt", value });
      return builder;
    },
    gte(column: string, value: unknown) {
      state.filters.push({ column, op: "gte", value });
      return builder;
    },
    lt(column: string, value: unknown) {
      state.filters.push({ column, op: "lt", value });
      return builder;
    },
    lte(column: string, value: unknown) {
      state.filters.push({ column, op: "lte", value });
      return builder;
    },
    like(column: string, value: unknown) {
      state.filters.push({ column, op: "like", value });
      return builder;
    },
    ilike(column: string, value: unknown) {
      state.filters.push({ column, op: "ilike", value });
      return builder;
    },
    is(column: string, value: unknown) {
      state.filters.push({ column, op: "is", value });
      return builder;
    },
    in(column: string, value: unknown) {
      state.filters.push({ column, op: "in", value });
      return builder;
    },
    or(value: string) {
      state.filters.push({ op: "or", value });
      return builder;
    },
    not(column: string, notOp: string, value: unknown) {
      state.filters.push({ column, op: "not", notOp, value });
      return builder;
    },
    match(values: Record<string, unknown>) {
      Object.entries(values || {}).forEach(([column, value]) => {
        state.filters.push({ column, op: "eq", value });
      });
      return builder;
    },
    filter(column: string, op: string, value: unknown) {
      state.filters.push({ column, op, value });
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      state.order = { column, ascending: options?.ascending !== false };
      return builder;
    },
    limit(count: number) {
      state.limit = count;
      return builder;
    },
    range(from: number, to: number) {
      state.offset = from;
      state.limit = to - from + 1;
      return builder;
    },
    single() {
      state.single = true;
      return builder;
    },
    maybeSingle() {
      state.maybeSingle = true;
      return builder;
    },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return execute().then(resolve, reject);
    },
  };

  return builder;
}

export function createAwsStagingClient() {
  const auth = {
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const { response, body } = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (body.challenge === "NEW_PASSWORD_REQUIRED") {
        return {
          data: { user: null, session: null },
          error: authError("NEW_PASSWORD_REQUIRED", {
            code: "NEW_PASSWORD_REQUIRED",
            session: body.session,
            email: body.email || email,
            status: 401,
          }),
        };
      }
      if (!response.ok || !body.authentication) {
        return {
          data: { user: null, session: null },
          error: authError(String(body.message || body.error || "Invalid credentials"), { status: response.status }),
        };
      }
      try {
        const mapped = await identityFromTokens(body.authentication as Record<string, unknown>, email);
        emit("SIGNED_IN", mapped.session);
        return { data: { user: mapped.user, session: mapped.session }, error: null };
      } catch (error: any) {
        return { data: { user: null, session: null }, error: authError(error.message || "identity_not_linked") };
      }
    },
    completeNewPassword: async ({
      email,
      session,
      newPassword,
    }: {
      email: string;
      session: string;
      newPassword: string;
    }) => {
      const { response, body } = await apiFetch("/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ email, session, newPassword }),
      });
      if (!response.ok || !body.authentication) {
        return {
          data: { user: null, session: null },
          error: authError(String(body.message || body.error || "challenge_failed"), { status: response.status }),
        };
      }
      const mapped = await identityFromTokens(body.authentication as Record<string, unknown>, email);
      emit("SIGNED_IN", mapped.session);
      return { data: { user: mapped.user, session: mapped.session }, error: null };
    },
    signOut: async () => {
      const stored = readStored();
      const accessToken = (stored?.tokens as Record<string, unknown> | undefined)?.accessToken;
      try {
        await apiFetch("/auth/logout", {
          method: "POST",
          body: JSON.stringify({ accessToken }),
        });
      } catch {
        /* best-effort */
      }
      writeStored(null);
      emit("SIGNED_OUT", null);
      return { error: null };
    },
    getSession: async () => {
      const restored = await restoreSession();
      return { data: { session: restored.session }, error: restored.error };
    },
    getUser: async () => {
      const restored = await restoreSession();
      return { data: { user: restored.session?.user ?? null }, error: restored.error };
    },
    refreshSession: async () => restoreSession(true).then((result) => ({
      data: { session: result.session, user: result.session?.user ?? null },
      error: result.error,
    })),
    onAuthStateChange: (callback: AuthListener) => {
      listeners.add(callback);
      queueMicrotask(async () => {
        const restored = await restoreSession();
        callback("INITIAL_SESSION", restored.session);
      });
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              listeners.delete(callback);
            },
          },
        },
      };
    },
    resetPasswordForEmail: async (email: string) => {
      const { response, body } = await apiFetch("/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        return { data: null, error: authError(String(body.message || body.error || "forgot_password_failed")) };
      }
      if (body.suppressed && String(email).trim().toLowerCase() !== TESTER_EMAIL) {
        return { data: { sent: false, suppressed: true }, error: null };
      }
      return { data: body, error: null };
    },
    confirmForgotPassword: async ({
      email,
      code,
      password,
    }: {
      email: string;
      code: string;
      password: string;
    }) => {
      const { response, body } = await apiFetch("/auth/confirm-forgot", {
        method: "POST",
        body: JSON.stringify({ email, code, password }),
      });
      if (!response.ok) {
        return { data: null, error: authError(String(body.message || body.error || "confirm_forgot_failed")) };
      }
      return { data: body, error: null };
    },
    updateUser: async ({ password }: { password?: string }) => {
      return {
        data: { user: null },
        error: authError("Cognito password reset uses a confirmation code, not a recovery session"),
      };
    },
    setSession: async ({ access_token, refresh_token }: { access_token: string; refresh_token: string }) => {
      try {
        const mapped = await identityFromTokens({
          idToken: access_token,
          refreshToken: refresh_token,
          expiresIn: 3600,
        });
        emit("SIGNED_IN", mapped.session);
        return { data: { user: mapped.user, session: mapped.session }, error: null };
      } catch (error: any) {
        return { data: { user: null, session: null }, error: authError(error.message || "setSession failed") };
      }
    },
    signUp: async () => ({
      data: { user: null, session: null },
      error: authError("signUp is disabled on AWS staging"),
    }),
    signInWithOtp: async () => ({
      data: { user: null, session: null },
      error: authError("OTP sign-in is disabled on AWS staging"),
    }),
  };

  const functions = {
    invoke: async (name: string) => ({
      data: null,
      error: {
        message: `provider_disabled:${name}`,
        name: "FunctionsError",
        context: { status: 403 },
      },
    }),
  };

  const channel = () => {
    const noop = {
      on() {
        return noop;
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      unsubscribe() {},
    };
    return noop;
  };

  return {
    auth,
    from: (table: string) => createBuilder(table),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const restored = await restoreSession();
      const token = restored.session?.access_token;
      if (!token) {
        return { data: null, error: postgrestError("JWT expired", "PGRST301") };
      }
      const { response, body } = await apiFetch("/data/rpc", {
        method: "POST",
        body: JSON.stringify({ name, args }),
      }, token);
      if (response.status === 401) {
        writeStored(null);
        emit("SIGNED_OUT", null);
      }
      if (!response.ok) {
        return { data: null, error: postgrestError(String(body.message || body.error || "rpc_failed"), String(body.error || "42501")) };
      }
      return { data: body.data ?? null, error: null };
    },
    storage: createAwsStorageAdapter(),
    functions,
    channel,
    removeChannel() {},
    getChannels() {
      return [];
    },
  };
}
