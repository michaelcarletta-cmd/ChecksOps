import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

interface Props {
  tenantId: string;
  onConnected?: (bankAccountId: string) => void;
  onExit?: () => void;
}

/**
 * Moov.js Bank Account Drop wrapper.
 * 
 * Safely collects bank account details (routing/account) via an iframe
 * and links them to the Moov account without the sensitive data ever 
 * touching our servers.
 */
export function MoovBankLink({ tenantId, onConnected, onExit }: Props) {
  const { toast } = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const { data, error } = await supabase.functions.invoke("moov-bank-link-token", {
          body: { tenant_id: tenantId }
        });
        if (error) throw error;
        if (!active) return;
        setToken(data.token);
      } catch (e: any) {
        toast({
          title: "Couldn't start bank link",
          description: e.message,
          variant: "destructive"
        });
        onExit?.();
      } finally {
        if (active) setLoading(false);
      }
    }
    init();
    return () => { active = false; };
  }, [tenantId, toast, onExit]);

  useEffect(() => {
    if (!token || !mountRef.current) return;

    let mounted = true;
    let cancelled = false;

    async function loadSdk() {
      if (customElements.get("moov-bank-account")) return;
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[src="https://js.moov.io/v1"]');
        if (existing) {
          existing.addEventListener("load", () => resolve());
          existing.addEventListener("error", () => reject(new Error("Failed to load Moov.js")));
          if (customElements.get("moov-bank-account")) resolve();
          return;
        }
        const script = document.createElement("script");
        script.src = "https://js.moov.io/v1";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Moov.js"));
        document.head.appendChild(script);
      });
      await customElements.whenDefined("moov-bank-account");
    }

    loadSdk()
      .then(() => {
        if (cancelled || !mountRef.current) return;
        const el = document.createElement("moov-bank-account") as any;
        el.token = token;

        mountRef.current.replaceChildren(el);


    el.onCancel = () => {
      onExit?.();
    };

    el.onSuccess = (bankAccount: any) => {
      const id = bankAccount?.bankAccountID ?? bankAccount?.bankAccountId;
      toast({
        title: "Bank account linked",
        description: "Your bank account has been securely attached. Verification may be required."
      });
      if (id) {
        onConnected?.(id);
      }
    };

    el.onError = (err: any) => {
      toast({
        title: "Bank link failed",
        description: err?.message ?? "An unexpected error occurred.",
        variant: "destructive"
      });
    };

    return () => {
      mounted = false;
      if (mountRef.current) mountRef.current.replaceChildren();
    };
  }, [token, toast, onConnected, onExit]);

  return (
    <div className="min-h-[300px] flex flex-col items-center justify-center p-4 border rounded-lg bg-card/50">
      {loading && (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Connecting to secure banking partner...</p>
        </div>
      )}
      <div ref={mountRef} className="w-full max-w-md" />
      <p className="text-[10px] text-muted-foreground mt-4 text-center max-w-[300px]">
        Your bank details are encrypted and sent directly to Moov. 
        ChecksOps never sees or stores your login or account numbers.
      </p>
    </div>
  );
}
