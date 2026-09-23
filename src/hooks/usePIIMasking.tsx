import { useState, useCallback } from "react";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "./useAuth";

// Fields that should be masked by default
export const PII_FIELDS = [
  "full_name",
  "email",
  "phone",
  "address",
  "policyholder_name",
  "policyholder_email",
  "policyholder_phone",
  "policyholder_address",
  "policy_number",
  "claim_number",
  "ssn_last_four",
  "loan_number",
] as const;

export type PIIField = (typeof PII_FIELDS)[number];

// Mask a value showing only last 4 characters
export function maskValue(value: string | null | undefined, showChars = 4): string {
  if (!value) return "••••";
  if (value.length <= showChars) return "•".repeat(value.length);
  return "•".repeat(value.length - showChars) + value.slice(-showChars);
}

// Mask email showing domain hint
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "••••@••••";
  const [local, domain] = email.split("@");
  if (!domain) return maskValue(email);
  const maskedLocal = local.length > 2 
    ? local[0] + "•".repeat(local.length - 2) + local[local.length - 1]
    : "••";
  const domainParts = domain.split(".");
  const tld = domainParts.pop() || "";
  return `${maskedLocal}@••••.${tld}`;
}

// Mask phone showing last 4 digits
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "•••-•••-••••";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "•".repeat(phone.length);
  return "•••-•••-" + digits.slice(-4);
}

// Mask name showing first initial
export function maskName(name: string | null | undefined): string {
  if (!name) return "••••";
  const parts = name.trim().split(" ");
  return parts.map(p => p[0] + "•".repeat(Math.max(p.length - 1, 2))).join(" ");
}

// Get appropriate mask function for field
export function getMaskedValue(fieldName: string, value: string | null | undefined): string {
  if (!value) return "••••";
  
  const lowerField = fieldName.toLowerCase();
  
  if (lowerField.includes("email")) {
    return maskEmail(value);
  }
  if (lowerField.includes("phone")) {
    return maskPhone(value);
  }
  if (lowerField.includes("name")) {
    return maskName(value);
  }
  if (lowerField.includes("address")) {
    return maskValue(value, 6);
  }
  if (lowerField.includes("ssn")) {
    return "•••-••-" + value.slice(-4);
  }
  
  return maskValue(value);
}

export function usePIIMasking() {
  const { user } = useAuth();
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  // Log PII reveal to database
  const logReveal = useCallback(async (
    fieldName: string,
    recordType: string,
    recordId: string
  ) => {
    if (!user?.id) return;
    
    try {
      await supabase.from("pii_reveal_logs").insert({
        user_id: user.id,
        field_name: fieldName,
        record_type: recordType,
        record_id: recordId,
      });
      
      // Also log to audit trail
      await supabase.rpc("log_audit", {
        p_action: "reveal_pii",
        p_record_type: recordType,
        p_record_id: recordId,
        p_metadata: { field_name: fieldName },
      });
    } catch (error) {
      console.error("Failed to log PII reveal:", error);
    }
  }, [user?.id]);

  // Reveal a specific field
  const revealField = useCallback((
    fieldKey: string,
    fieldName: string,
    recordType: string,
    recordId: string
  ) => {
    setRevealedFields(prev => new Set([...prev, fieldKey]));
    logReveal(fieldName, recordType, recordId);
  }, [logReveal]);

  // Hide a specific field
  const hideField = useCallback((fieldKey: string) => {
    setRevealedFields(prev => {
      const next = new Set(prev);
      next.delete(fieldKey);
      return next;
    });
  }, []);

  // Check if field is revealed
  const isRevealed = useCallback((fieldKey: string) => {
    return revealedFields.has(fieldKey);
  }, [revealedFields]);

  // Hide all fields
  const hideAll = useCallback(() => {
    setRevealedFields(new Set());
  }, []);

  return {
    revealField,
    hideField,
    isRevealed,
    hideAll,
    getMaskedValue,
    maskValue,
    maskEmail,
    maskPhone,
    maskName,
  };
}
