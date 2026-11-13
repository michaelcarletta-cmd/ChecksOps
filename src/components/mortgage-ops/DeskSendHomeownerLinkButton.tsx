import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, Link2, Copy } from "lucide-react";
import {
  sendMortgageDeskTrackingLink,
  type MortgageDeskFunctionsClient,
} from "@/lib/mortgageDeskEsign";

/**
 * Send the homeowner tracking link from the Mortgage Desk (owner 2026-11-12: "When sending homeowner link from mortgage
 * desk, error missing_cognito_token. Fix it."). It goes through the Desk API with the Desk session, so there is no
 * tenant login; the server sends it to the homeowner on file (never an address typed here) and may be used any number of
 * times ("They can send the link whenever"). Until SQL 163 is live in production the server answers 503 and the button
 * shows that message.
 */
export function DeskSendHomeownerLinkButton({
  client,
  requestId,
  homeownerName,
  homeownerEmail,
  label = "Send tracking link to homeowner",
}: {
  client: MortgageDeskFunctionsClient;
  requestId: string;
  homeownerName?: string | null;
  homeownerEmail?: string | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; sentTo: string | null; reused: boolean } | null>(null);

  const send = async () => {
    setBusy(true);
    const { data, error } = await sendMortgageDeskTrackingLink(client, requestId, window.location.origin);
    setBusy(false);
    if (error || !data) {
      toast.error(error || "The homeowner link could not be sent.");
      return;
    }
    setResult(data);
    toast.success(data.sentTo ? `Tracking link emailed to ${data.sentTo}` : "Tracking link created");
  };

  const reset = () => {
    setOpen(false);
    setResult(null);
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Link2 className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send homeowner tracking link</DialogTitle>
            <DialogDescription>
              The homeowner gets a private link to follow every check on this claim — status, endorsements, deposits,
              mortgage/loss-draft docs and messages. No login required. It is sent to the homeowner on file
              {homeownerEmail ? <> (<span className="font-medium">{homeownerEmail}</span>)</> : null}.
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-3">
              <div className="text-sm">Link is live{result.reused ? " (existing link reused)" : ""}:</div>
              <div className="p-2 bg-muted rounded text-xs break-all font-mono">{result.url}</div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(result.url);
                    toast.success("Link copied");
                  }}
                >
                  <Copy className="h-4 w-4 mr-1" /> Copy
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={result.url} target="_blank" rel="noreferrer">Preview</a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {result.sentTo ? `Email sent to ${result.sentTo}.` : "No email on file — copy the link and share it manually."}
                {" "}The same link works for every check on this claim.
              </p>
              <DialogFooter>
                <Button size="sm" onClick={reset}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="ghost" onClick={reset} disabled={busy}>Cancel</Button>
              <Button onClick={send} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Link2 className="h-4 w-4 mr-1" />}
                {homeownerName ? `Send to ${homeownerName}` : "Send link"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
