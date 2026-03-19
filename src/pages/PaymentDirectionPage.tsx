import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getPaymentDirectionByToken, submitPaymentDirection } from "@/lib/paymentDirection";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Loader2 } from "lucide-react";

type LoadState = "loading" | "ready" | "submitted" | "error";

export default function PaymentDirectionPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [record, setRecord] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        if (!token) throw new Error("Missing token.");
        const data = await getPaymentDirectionByToken(token);
        if (data.request_status !== "pending") {
          setState("submitted");
          return;
        }
        setRecord(data);
        setState("ready");
      } catch (error: any) {
        setErrorMessage(error.message || "Unable to load request.");
        setState("error");
      }
    }
    load();
  }, [token]);

  async function handleDecision(decision: "pay_contractor" | "pay_insured") {
    try {
      if (!token) throw new Error("Missing token.");
      setSubmitting(true);
      await submitPaymentDirection({
        token,
        decision,
        source: "portal",
      });
      setState("submitted");
    } catch (error: any) {
      setErrorMessage(error.message || "Unable to submit decision.");
      setState("error");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading payment direction request...</span>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-6 text-center">
            <p className="text-destructive">{errorMessage}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === "submitted") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-6 text-center space-y-3">
            <CheckCircle className="h-12 w-12 text-primary mx-auto" />
            <h2 className="text-xl font-semibold text-foreground">Thank you</h2>
            <p className="text-muted-foreground">
              Your payment direction has been recorded successfully.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const amount = record?.claim_checks?.amount;
  const checkNumber = record?.claim_checks?.check_number;
  const contractorName = record?.contractor_name;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-lg w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Payment Direction</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            We have received the required endorsement for your insurance check.
            Please tell us how you want funds handled so we can move your claim forward.
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="bg-muted/50 rounded-lg p-4 space-y-1 text-sm">
            {typeof amount === "number" && (
              <p className="text-foreground">
                <span className="font-medium">Check Amount:</span> ${amount.toFixed(2)}
              </p>
            )}
            {checkNumber && (
              <p className="text-foreground">
                <span className="font-medium">Check Number:</span> {checkNumber}
              </p>
            )}
            {contractorName && (
              <p className="text-foreground">
                <span className="font-medium">Contractor:</span> {contractorName}
              </p>
            )}
          </div>

          <p className="text-sm text-foreground font-medium text-center">
            Do you authorize us to pay your contractor directly for work to commence?
          </p>

          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              className="w-full"
              disabled={submitting}
              onClick={() => handleDecision("pay_contractor")}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Yes, pay contractor directly
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="w-full"
              disabled={submitting}
              onClick={() => handleDecision("pay_insured")}
            >
              No, send funds to me
            </Button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Your response helps us direct funds properly and avoid delays in claim handling.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
