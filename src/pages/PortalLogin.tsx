import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { Shield, Loader2 } from "lucide-react";

export default function PortalLogin() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const handlePinLogin = async () => {
    if (pin.length !== 4) return;

    setLoading(true);
    try {
      // Call edge function to validate PIN and get magic link token
      const { data, error } = await supabase.functions.invoke("portal-pin-login", {
        body: { pin },
      });

      if (error) throw error;
      if (data?.error) {
        toast({
          title: "Login Failed",
          description: data.error,
          variant: "destructive",
        });
        setPin("");
        setLoading(false);
        return;
      }

      if (data?.token_hash && data?.email) {
        // Exchange the magic link token for a session
        const { error: otpError } = await supabase.auth.verifyOtp({
          token_hash: data.token_hash,
          type: "magiclink",
        });

        if (otpError) {
          console.error("OTP verification failed:", otpError);
          toast({
            title: "Login Failed",
            description: "Unable to sign in. Please try again.",
            variant: "destructive",
          });
          setPin("");
        } else {
          // Navigate to client portal after successful auth
          navigate("/client-portal", { replace: true });
        }
      }
    } catch (err: any) {
      console.error("PIN login error:", err);
      toast({
        title: "Login Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
      setPin("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
            <Shield className="h-7 w-7 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl">Client Portal</CardTitle>
            <CardDescription className="mt-2">
              Enter your 4-digit PIN to access your claims
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex justify-center">
            <InputOTP
              maxLength={4}
              value={pin}
              onChange={(value) => setPin(value)}
              onComplete={handlePinLogin}
              disabled={loading}
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={1} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={2} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={3} className="h-14 w-14 text-2xl" />
              </InputOTPGroup>
            </InputOTP>
          </div>

          <Button
            onClick={handlePinLogin}
            className="w-full"
            disabled={loading || pin.length !== 4}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign In"
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Your PIN was included in your welcome email from Freedom Claims.
            If you need help, contact your claims representative.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
