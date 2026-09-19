import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { MOOV_ENVIRONMENT_CHANGE_WARNING, type MoovEnvironment } from "@/lib/moovEnvironment";
import { MoovEnvironmentBadge } from "@/components/payments/MoovEnvironmentBadge";

export function MoovEnvironmentControl({
  tenantId,
  current,
}: {
  tenantId: string;
  current?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const environment = (current === "production" ? "production" : "sandbox") as MoovEnvironment;
  const [pending, setPending] = useState<MoovEnvironment | null>(null);

  const save = useMutation({
    mutationFn: async (next: MoovEnvironment) => {
      const { data, error } = await supabase.functions.invoke("moov-tenant-environment", {
        body: {
          tenant_id: tenantId,
          next_environment: next,
          expected_current: environment,
          confirm: true,
        },
      });
      if (error) throw error;
      if ((data as any)?.ok === false) {
        throw new Error((data as any)?.message || (data as any)?.error || "Could not change Moov environment");
      }
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: data?.changed ? `Moov environment is now ${data.after}` : "Moov environment unchanged",
        description: MOOV_ENVIRONMENT_CHANGE_WARNING,
      });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["payment-provider-eligibility"] });
      queryClient.invalidateQueries({ queryKey: ["tenant-payment-account", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["wallet-ops-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-ops-provider-activity"] });
      queryClient.invalidateQueries({ queryKey: ["payment-wallet"] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not change Moov environment", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label className="text-sm">Moov Environment</Label>
          <p className="text-xs text-muted-foreground">
            Tenant-level ledger. Switching does not migrate accounts, wallets, banks, recipients, or transfers.
          </p>
        </div>
        <MoovEnvironmentBadge environment={environment} />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={environment === "sandbox" ? "default" : "outline"}
          disabled={save.isPending}
          onClick={() => environment === "sandbox" ? null : setPending("sandbox")}
        >
          Sandbox
        </Button>
        <Button
          type="button"
          size="sm"
          variant={environment === "production" ? "default" : "outline"}
          disabled={save.isPending}
          onClick={() => environment === "production" ? null : setPending("production")}
        >
          Production
        </Button>
      </div>
      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change Moov environment to {pending === "production" ? "Production" : "Sandbox"}?</AlertDialogTitle>
            <AlertDialogDescription>{MOOV_ENVIRONMENT_CHANGE_WARNING}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) save.mutate(pending);
                setPending(null);
              }}
            >
              Change environment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
