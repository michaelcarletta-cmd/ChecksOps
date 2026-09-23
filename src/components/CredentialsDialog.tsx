import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Check, Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/aws/client";

interface CredentialsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  email: string;
  password: string;
  pin?: string;
  userType: string;
  userName?: string;
  tenantName?: string;
}

export const CredentialsDialog = ({
  isOpen,
  onClose,
  email,
  password,
  pin,
  userType,
  userName,
  tenantName,
}: CredentialsDialogProps) => {
  const [copiedPin, setCopiedPin] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const isClientWithPin = userType === "Client" && pin;

  const handleCopy = async (text: string, type: "email" | "password" | "pin") => {
    await navigator.clipboard.writeText(text);
    if (type === "pin") {
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 2000);
    } else if (type === "email") {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    } else {
      setCopiedPassword(true);
      setTimeout(() => setCopiedPassword(false), 2000);
    }
    toast.success(`${type === "pin" ? "PIN" : type === "email" ? "Email" : "Password"} copied to clipboard`);
  };

  const handleCopyAll = async () => {
    const text = isClientWithPin
      ? `Portal PIN: ${pin}`
      : `Email: ${email}\nPassword: ${password}`;
    await navigator.clipboard.writeText(text);
    toast.success("Credentials copied to clipboard");
  };

  const handleSendInvite = async () => {
    setSendingEmail(true);
    try {
      const appUrl = window.location.origin;
      const { data, error } = await supabase.functions.invoke("send-portal-invite", {
        body: { email, password, pin, userType, userName, appUrl, tenantName },
      });

      if (error) throw error;

      setEmailSent(true);
      toast.success("Invitation email sent successfully");
    } catch (error: any) {
      console.error("Error sending invite:", error);
      toast.error(error.message || "Failed to send invitation email");
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{userType} Account Created</DialogTitle>
          <DialogDescription>
            {isClientWithPin
              ? "Save this PIN or send it via email. The client will use this 4-digit PIN to log in."
              : "Save these login credentials or send them via email. The password cannot be retrieved later."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isClientWithPin ? (
            <div className="space-y-2">
              <Label>Portal PIN</Label>
              <div className="flex gap-2">
                <Input value={pin} readOnly className="bg-muted font-mono text-2xl text-center tracking-[0.5em]" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleCopy(pin, "pin")}
                >
                  {copiedPin ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Client logs in at <span className="font-mono">/portal</span> using just this PIN — no email or password needed.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Email</Label>
                <div className="flex gap-2">
                  <Input value={email} readOnly className="bg-muted" />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleCopy(email, "email")}
                  >
                    {copiedEmail ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Temporary Password</Label>
                <div className="flex gap-2">
                  <Input value={password} readOnly className="bg-muted font-mono" />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleCopy(password, "password")}
                  >
                    {copiedPassword ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </>
          )}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Button 
              variant="outline" 
              onClick={handleSendInvite}
              disabled={sendingEmail || emailSent}
              className="flex-1"
            >
              {sendingEmail ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : emailSent ? (
                <Check className="h-4 w-4 mr-2 text-green-500" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              {emailSent ? "Email Sent" : "Send Invite Email"}
            </Button>
            <Button variant="outline" onClick={handleCopyAll}>
              Copy All
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
