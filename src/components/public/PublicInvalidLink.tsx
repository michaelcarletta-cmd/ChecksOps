import { AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function PublicInvalidLink({
  title = "This link is invalid or has expired",
  description = "Ask the sender for a new link. This page does not require an account sign-in.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 text-center space-y-4">
          <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}

export function isCleanPublicLinkError(message: string | null | undefined) {
  const value = String(message || "").toLowerCase();
  if (!value) return false;
  return (
    value.includes("invalid")
    || value.includes("expired")
    || value.includes("not valid")
    || value.includes("not available")
    || value.includes("already been used")
    || value.includes("already-used")
  );
}

export function publicLinkUserMessage(raw: string | null | undefined, fallback: string) {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  if (/missing_cognito_token|invalid_cognito_token|jwt|stack|sql|relation |column /i.test(value)) {
    return fallback;
  }
  // Unknown/malformed tokens must not say the link "already been used".
  // Rotated or never-issued tokens are indistinguishable once the row is gone.
  if (/already been used or replaced|already-used token|token_consumed/i.test(value)) {
    return fallback;
  }
  return value;
}
