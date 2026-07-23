// Translates raw Supabase / network auth errors into user-friendly copy.
// Also detects "system update" style failures where the right fix is a
// hard refresh (stale bundle after a key rotation, deprecated API key, etc.).

export type FriendlyAuthError = {
  title: string;
  description: string;
  needsHardRefresh: boolean;
};

const SYSTEM_UPDATE_PATTERNS = [
  /legacy api key/i,
  /api key.*disabled/i,
  /disabled.*api key/i,
  /invalid api key/i,
  /no api key found/i,
  /project.*paused/i,
];

const NETWORK_PATTERNS = [
  /failed to fetch/i,
  /network(?:error)?/i,
  /load failed/i,
  /timeout/i,
];

export function getFriendlyAuthError(err: unknown): FriendlyAuthError {
  const raw =
    (err && typeof err === "object" && "message" in err
      ? String((err as any).message)
      : String(err ?? "")) || "";

  if (SYSTEM_UPDATE_PATTERNS.some((p) => p.test(raw))) {
    return {
      title: "We're updating the system",
      description:
        "Please refresh the page and try again. If it keeps happening, close and reopen your browser.",
      needsHardRefresh: true,
    };
  }

  if (/invalid login credentials/i.test(raw)) {
    return {
      title: "Sign in failed",
      description: "That email and password don't match. Try again or reset your password.",
      needsHardRefresh: false,
    };
  }

  if (/email not confirmed/i.test(raw)) {
    return {
      title: "Confirm your email",
      description: "Check your inbox for a confirmation link before signing in.",
      needsHardRefresh: false,
    };
  }

  if (/rate limit|too many/i.test(raw)) {
    return {
      title: "Too many attempts",
      description: "Please wait a minute and try again.",
      needsHardRefresh: false,
    };
  }

  if (NETWORK_PATTERNS.some((p) => p.test(raw))) {
    return {
      title: "Can't reach the server",
      description: "Check your internet connection and try again.",
      needsHardRefresh: false,
    };
  }

  return {
    title: "Sign in failed",
    description: raw || "Something went wrong. Please try again.",
    needsHardRefresh: false,
  };
}

export function hardRefresh() {
  // Bust the cached bundle: append a cache-busting query and reload.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_v", Date.now().toString());
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}
