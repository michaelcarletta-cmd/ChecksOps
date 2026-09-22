/**
 * Auth provider and data/service provider are independent switches.
 *
 * AUTH: supabase | cognito
 *   VITE_AUTH_PROVIDER=cognito selects Cognito as the browser identity.
 *   Anything else (including empty) keeps Supabase Auth.
 *
 * DATA/SERVICE: supabase | aws
 *   VITE_DATA_SERVICE_PROVIDER wins when set to supabase or aws.
 *   Otherwise Cognito auth defaults to the AWS adapter (staging today)
 *   and Supabase auth defaults to the Supabase client (production today).
 *
 * AWS data plane requires Cognito identity. Supabase Auth + AWS data is
 * unsupported and fail-closes to the Supabase client.
 *
 * This file is import.meta-free so Node tests can import it directly.
 */

export type AuthProvider = "supabase" | "cognito";
export type DataServiceProvider = "supabase" | "aws";

export type IntegrationClientKind =
  | "supabase"
  | "aws-adapter"
  | "cognito-auth-supabase-data";

export type IntegrationSelection = {
  auth: AuthProvider;
  data: DataServiceProvider;
  client: IntegrationClientKind;
};

type EnvLike = Record<string, string | undefined> | undefined | null;

const readEnv = (env: EnvLike, key: string): string =>
  String(env?.[key] ?? "").trim().toLowerCase();

export function resolveAuthProvider(env: EnvLike = {}): AuthProvider {
  return readEnv(env, "VITE_AUTH_PROVIDER") === "cognito" ? "cognito" : "supabase";
}

export function resolveDataServiceProvider(env: EnvLike = {}): DataServiceProvider {
  const auth = resolveAuthProvider(env);
  const explicit = readEnv(env, "VITE_DATA_SERVICE_PROVIDER");
  if (explicit === "supabase") return "supabase";
  if (explicit === "aws") {
    return auth === "cognito" ? "aws" : "supabase";
  }
  return auth === "cognito" ? "aws" : "supabase";
}

export function resolveIntegrationSelection(env: EnvLike = {}): IntegrationSelection {
  const auth = resolveAuthProvider(env);
  const data = resolveDataServiceProvider(env);
  if (auth === "cognito" && data === "aws") {
    return { auth, data, client: "aws-adapter" };
  }
  if (auth === "cognito" && data === "supabase") {
    return { auth, data, client: "cognito-auth-supabase-data" };
  }
  return { auth: "supabase", data: "supabase", client: "supabase" };
}

export function isCombinedAwsClient(env: EnvLike = {}): boolean {
  return resolveIntegrationSelection(env).client === "aws-adapter";
}

/** Storage that never reads or writes Supabase Auth session keys. */
export function createDisabledSupabaseAuthStorage() {
  return {
    getItem: (_key: string) => null,
    setItem: (_key: string, _value: string) => {},
    removeItem: (_key: string) => {},
  };
}

/**
 * Auth options for a Supabase *data* client used under Cognito identity.
 * persistSession/autoRefresh/detectSessionInUrl stay off so a stale sb-*
 * session cannot become authoritative and no new Supabase session is minted.
 */
export function supabaseDataClientAuthOptions() {
  return {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storage: createDisabledSupabaseAuthStorage(),
  };
}

/**
 * Cognito is the only exported auth surface. Data/storage/functions/rpc
 * stay on the supplied Supabase client. The data client's auth object is
 * discarded so it cannot restore or mint a Supabase user session.
 */
export function composeCognitoAuthWithSupabaseData(
  cognitoClient: { auth: unknown },
  supabaseDataClient: {
    from: (...args: never[]) => unknown;
    rpc: (...args: never[]) => unknown;
    storage: unknown;
    functions: unknown;
    channel: (...args: never[]) => unknown;
    removeChannel: (...args: never[]) => unknown;
    getChannels: (...args: never[]) => unknown;
  },
) {
  return {
    auth: cognitoClient.auth,
    from: (...args: never[]) => supabaseDataClient.from(...args),
    rpc: (...args: never[]) => supabaseDataClient.rpc(...args),
    storage: supabaseDataClient.storage,
    functions: supabaseDataClient.functions,
    channel: (...args: never[]) => supabaseDataClient.channel(...args),
    removeChannel: (...args: never[]) => supabaseDataClient.removeChannel(...args),
    getChannels: (...args: never[]) => supabaseDataClient.getChannels(...args),
  };
}
