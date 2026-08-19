import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Phone, CheckCircle, Loader2, Send, ShieldCheck, Trash2, Settings2, Smartphone } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export function PhoneVerificationSettings() {
  const { toast } = useToast();
  const { user } = useAuth();
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

  // Check if user is admin for send-mode toggle
  const { data: isAdmin } = useQuery({
    queryKey: ["user-is-admin", user?.id],
    queryFn: async () => {
      if (!user?.id) return false;
      const { data } = await supabase
        .from("user_roles")
        .select("id")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .limit(1)
        .single();
      return !!data;
    },
    enabled: !!user?.id,
  });

  // Get org send mode setting
  const { data: smsSettings } = useQuery({
    queryKey: ["darwin-sms-settings"],
    queryFn: async () => {
      const { data } = await supabase
        .from("darwin_sms_settings")
        .select("*")
        .limit(1)
        .single();
      return data as { id: string; send_mode: string; auto_send_roles: string[] } | null;
    },
    enabled: !!isAdmin,
  });

  const toggleSendModeMutation = useMutation({
    mutationFn: async (newMode: string) => {
      if (!user?.id) throw new Error("Not authenticated");
      // Get org_id
      const { data: orgMember } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1)
        .single();
      if (!orgMember?.org_id) throw new Error("No org found");

      if (smsSettings?.id) {
        const { error } = await supabase
          .from("darwin_sms_settings")
          .update({ send_mode: newMode })
          .eq("id", smsSettings.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("darwin_sms_settings")
          .insert({ org_id: orgMember.org_id, send_mode: newMode });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["darwin-sms-settings"] });
      toast({ title: "Send mode updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
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
    <div className="space-y-6">
      <SettingsHero
        title="SMS Commands"
        description="Configure your mobile integration for AI-powered text message interactions."
        badge="Darwin AI"
        icon={<Phone className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Phone Link"
        icon={<Smartphone className="h-4 w-4 text-blue-500" />}
        accent="bg-gradient-to-r from-blue-500/60 to-blue-500/10"
        description="Link your phone number to interact with Darwin via SMS."
      >
        <div className="space-y-4 pt-4">
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

        {/* Admin-only: Send Mode Toggle */}
        {isAdmin && (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <Label className="text-sm font-medium text-foreground">SMS Send Mode</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Controls whether Darwin SMS commands that send messages to clients require confirmation first.
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  checked={(smsSettings?.send_mode || 'draft') === 'auto_send'}
                  onCheckedChange={(checked) =>
                    toggleSendModeMutation.mutate(checked ? 'auto_send' : 'draft')
                  }
                  disabled={toggleSendModeMutation.isPending}
                />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {(smsSettings?.send_mode || 'draft') === 'auto_send' ? 'Auto-send' : 'Draft mode'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(smsSettings?.send_mode || 'draft') === 'auto_send'
                      ? 'Admins can send client messages immediately without confirmation'
                      : 'All client messages require SEND confirmation via SMS'}
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
        </div>
      </SectionCard>
    </div>
  );
}
