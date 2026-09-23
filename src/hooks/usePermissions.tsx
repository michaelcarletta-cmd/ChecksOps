import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "./useAuth";

export type Permission = 
  | "read"
  | "create"
  | "update"
  | "delete"
  | "export"
  | "reveal_pii"
  | "manage_users"
  | "view_audit_logs";

export function usePermissions() {
  const { user, userRole } = useAuth();
  const [permissions, setPermissions] = useState<Record<Permission, boolean>>({
    read: false,
    create: false,
    update: false,
    delete: false,
    export: false,
    reveal_pii: false,
    manage_users: false,
    view_audit_logs: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }

      const permissionsList: Permission[] = [
        "read",
        "create",
        "update",
        "delete",
        "export",
        "reveal_pii",
        "manage_users",
        "view_audit_logs",
      ];

      const results: Record<Permission, boolean> = {} as Record<Permission, boolean>;

      // Check each permission via the database function
      for (const perm of permissionsList) {
        try {
          const { data, error } = await supabase.rpc("has_permission", {
            _user_id: user.id,
            _permission: perm,
          });
          results[perm] = error ? false : !!data;
        } catch {
          results[perm] = false;
        }
      }

      setPermissions(results);
      setLoading(false);
    };

    checkPermissions();
  }, [user?.id, userRole]);

  const can = useCallback((permission: Permission): boolean => {
    return permissions[permission] || false;
  }, [permissions]);

  const isReadOnly = userRole === "read_only";
  const isAdmin = userRole === "admin";
  const isStaff = userRole === "staff";

  return {
    permissions,
    loading,
    can,
    isReadOnly,
    isAdmin,
    isStaff,
  };
}
