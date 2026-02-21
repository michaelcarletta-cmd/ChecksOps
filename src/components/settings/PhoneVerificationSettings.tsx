import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Phone, CheckCircle, Loader2, Send, ShieldCheck, Trash2 } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

export function PhoneVerificationSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [step, setStep] = useState<"input" | "verify">("input");
  const [code, setCode] = useState("");

  const { data: linkStatus, isLoading } = useQuery({
    queryKey: ["phone-link-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("phone-verification", {
        body: { action: "get_status" },
      });
      if (error) throw error;
      return data?.link as { phone_number: string; is_verified: boolean; verified_at: string } | null;
    },
  });

  const sendCodeMutation = useMutation({
    mutationFn: async (phone: string) => {
      const { data, error } = await supabase.functions.invoke("phone-verification", {
        body: { action: "send_code", phoneNumber: phone },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      setStep("verify");
      toast({ title: "Code sent!", description: "Check your phone for a 6-digit code." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to send code", description: err.message, variant: "destructive" });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (verifyCode: string) => {
      const { data, error } = await supabase.functions.invoke("phone-verification", {
        body: { action: "verify_code", code: verifyCode },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phone-link-status"] });
      setStep("input");
      setCode("");
      toast({ title: "Phone verified!", description: "You can now use Darwin via SMS." });
    },
    onError: (err: Error) => {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("phone-verification", {
        body: { action: "remove" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phone-link-status"] });
      setPhoneNumber("");
      toast({ title: "Phone removed" });
    },
  });

  if (isLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Phone className="h-5 w-5 text-primary" />
          Darwin SMS Commands
        </CardTitle>
        <CardDescription>
          Link your phone number to send commands to Darwin via text message.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {linkStatus?.is_verified ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 bg-green-500/10 rounded-lg border border-green-500/20">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="font-medium text-foreground">{linkStatus.phone_number}</p>
                <p className="text-sm text-muted-foreground">
                  Verified — text commands to Darwin anytime
                </p>
              </div>
              <Badge className="ml-auto bg-green-500/20 text-green-500 border-green-500/30">
                <ShieldCheck className="h-3 w-3 mr-1" />
                Verified
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
              className="text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Remove Phone
            </Button>
          </div>
        ) : step === "input" ? (
          <div className="flex gap-2">
            <Input
              placeholder="(555) 123-4567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="bg-background border-border"
            />
            <Button
              onClick={() => sendCodeMutation.mutate(phoneNumber)}
              disabled={!phoneNumber.replace(/\D/g, '').match(/^\d{10,11}$/) || sendCodeMutation.isPending}
            >
              {sendCodeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Send Code
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter the 6-digit code sent to your phone:
            </p>
            <InputOTP maxLength={6} value={code} onChange={setCode}>
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
            <div className="flex gap-2">
              <Button
                onClick={() => verifyMutation.mutate(code)}
                disabled={code.length !== 6 || verifyMutation.isPending}
              >
                {verifyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                Verify
              </Button>
              <Button variant="ghost" onClick={() => { setStep("input"); setCode(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
