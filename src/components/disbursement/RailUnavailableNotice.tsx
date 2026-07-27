import { Card, CardContent } from "@/components/ui/card";
import { Banknote } from "lucide-react";

/**
 * Shown in place of an Actum/Authentecheck surface when a tenant has been
 * moved to the Plaid rail but the Plaid equivalent is not wired up yet.
 * Neutral wording — never names the vendor being retired.
 */
export function RailUnavailableNotice({
  title = "Bank payments unavailable",
  description = "Bank payments and account linking are being migrated for this organization. This will be available again shortly.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Card>
      <CardContent className="py-6 text-center space-y-1.5">
        <Banknote className="h-6 w-6 text-muted-foreground mx-auto" />
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">{description}</p>
      </CardContent>
    </Card>
  );
}
