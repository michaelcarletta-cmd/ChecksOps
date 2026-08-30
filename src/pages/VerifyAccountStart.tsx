import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";

/**
 * Legacy bank-verification landing page.
 *
 * The old ACH verification rail has been retired — all payout setup now runs
 * through the hosted recipient flow at `/pay-setup/:token`. Links that were
 * mailed out before the switch still land here, so this page explains what to
 * do instead of showing a dead end.
 */
export default function VerifyAccountStart() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info className="h-5 w-5 text-primary" />
            <CardTitle>This link is no longer active</CardTitle>
          </div>
          <CardDescription>
            We upgraded how bank accounts are connected for payouts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            Please ask the company that sent you this link to send you a new
            payout setup link. The new link starts with <code>/pay-setup/</code>{" "}
            and walks you through verifying your details and connecting your
            bank account securely.
          </p>
          <p>
            Need help? Email{" "}
            <a className="text-primary underline" href="mailto:support@checksops.com">
              support@checksops.com
            </a>
            .
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to="/">Return home</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
