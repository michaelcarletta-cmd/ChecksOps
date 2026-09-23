import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import { getMaskedValue } from "@/hooks/usePIIMasking";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";

interface MaskedFieldProps {
  value: string | null | undefined;
  fieldName: string;
  recordType: string;
  recordId: string;
  className?: string;
  showToggle?: boolean;
  defaultRevealed?: boolean;
}

export function MaskedField({
  value,
  fieldName,
  recordType,
  recordId,
  className,
  showToggle = true,
  defaultRevealed = false,
}: MaskedFieldProps) {
  const { user, userRole, loading } = useAuth();
  const [revealed, setRevealed] = useState(defaultRevealed);

  // Check if user is admin or staff - show unmasked immediately if role is cached or loading with a session
  // This prevents the flash of masked content for privileged users
  const isPrivilegedUser = userRole === "admin" || userRole === "staff";

  const handleReveal = async () => {
    if (!revealed) {
      // Log the reveal action only for non-privileged users
      if (!isPrivilegedUser) {
        try {
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (authUser) {
            await supabase.from("pii_reveal_logs").insert({
              user_id: authUser.id,
              field_name: fieldName,
              record_type: recordType,
              record_id: recordId,
            });
            
            await supabase.rpc("log_audit", {
              p_action: "reveal_pii",
              p_record_type: recordType,
              p_record_id: recordId,
              p_metadata: { field_name: fieldName },
            });
          }
        } catch (error) {
          console.error("Failed to log PII reveal:", error);
        }
      }
    }
    setRevealed(!revealed);
  };

  // For privileged users (admin/staff), always show unmasked
  if (isPrivilegedUser) {
    return (
      <span className={cn("font-mono text-sm", className)}>
        {value || "—"}
      </span>
    );
  }

  // For non-privileged users, show masked with toggle option
  const displayValue = revealed ? (value || "—") : getMaskedValue(fieldName, value);

  if (!showToggle) {
    return (
      <span className={cn("font-mono text-sm", className)}>
        {displayValue}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("font-mono text-sm", !revealed && "text-muted-foreground")}>
        {displayValue}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 hover:bg-muted"
        onClick={handleReveal}
        title={revealed ? "Hide" : "Reveal"}
      >
        {revealed ? (
          <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>
    </span>
  );
}
