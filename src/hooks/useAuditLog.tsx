import { useCallback } from "react";
import { supabase } from "@/integrations/aws/client";

type AuditAction = 
  | "create"
  | "read"
  | "update"
  | "delete"
  | "export"
  | "login"
  | "logout"
  | "reveal_pii"
  | "status_change"
  | "assignment_change"
  | "file_upload"
  | "file_download"
  | "email_sent"
  | "sms_sent"
  | "payment_recorded"
  | "role_change"
  | "permission_change";

interface AuditLogParams {
  action: AuditAction;
  recordType: string;
  recordId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function useAuditLog() {
  const log = useCallback(async ({
    action,
    recordType,
    recordId,
    oldValues,
    newValues,
    metadata,
  }: AuditLogParams) => {
    try {
      const { error } = await supabase.rpc("log_audit", {
        p_action: action,
        p_record_type: recordType,
        p_record_id: recordId || null,
        p_old_values: oldValues ? JSON.stringify(oldValues) : null,
        p_new_values: newValues ? JSON.stringify(newValues) : null,
        p_metadata: metadata ? JSON.stringify(metadata) : null,
      });

      if (error) {
        console.error("Failed to log audit:", error);
      }
    } catch (error) {
      console.error("Audit log error:", error);
    }
  }, []);

  return { log };
}

// Standalone function for use outside of React components
export async function logAudit(params: AuditLogParams) {
  try {
    const { error } = await supabase.rpc("log_audit", {
      p_action: params.action,
      p_record_type: params.recordType,
      p_record_id: params.recordId || null,
      p_old_values: params.oldValues ? JSON.stringify(params.oldValues) : null,
      p_new_values: params.newValues ? JSON.stringify(params.newValues) : null,
      p_metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });

    if (error) {
      console.error("Failed to log audit:", error);
    }
  } catch (error) {
    console.error("Audit log error:", error);
  }
}
