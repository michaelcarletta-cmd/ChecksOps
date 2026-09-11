import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Props = {
  qr: string | null;
  secret: string | null;
};

/** Renders a session-only TOTP QR and optional manual key. Does not persist the secret. */
export function TotpQrDisplay({ qr, secret }: Props) {
  const { toast } = useToast();
  if (!qr && !secret) return null;
  return (
    <div className="space-y-2">
      {qr && (
        <div className="flex justify-center rounded-md bg-background p-3 border border-border">
          <img src={qr} alt="ChecksOps Financial authenticator setup QR code" className="h-44 w-44" />
        </div>
      )}
      {secret && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            Can&apos;t scan? Enter this ChecksOps Financial setup key in your authenticator app.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{secret}</code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                void navigator.clipboard.writeText(secret);
                toast({ title: "Setup key copied" });
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
