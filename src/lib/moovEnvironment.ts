export const MOOV_ENVIRONMENTS = ["sandbox", "production"] as const;
export type MoovEnvironment = (typeof MOOV_ENVIRONMENTS)[number];

export const MOOV_ENVIRONMENT_CHANGE_WARNING =
  "Changing Moov environment changes which provider account, wallet, banks, recipients, transfers, and credentials this tenant uses. No money or provider objects are migrated between environments.";

export const SANDBOX_SETUP_REQUIRED = "Sandbox Moov setup required";
export const PRODUCTION_SETUP_REQUIRED = "Production Moov setup required";

export const normalizeMoovEnvironment = (value?: string | null): MoovEnvironment => {
  const env = String(value || "").trim().toLowerCase();
  return env === "production" ? "production" : "sandbox";
};

export const moovEnvironmentLabel = (value?: string | null) =>
  normalizeMoovEnvironment(value) === "production" ? "Production" : "SANDBOX";
