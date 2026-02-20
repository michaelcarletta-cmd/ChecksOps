import { Home, FileText, CheckSquare, Inbox, Users, Network, DollarSign, FileStack, Settings, LogOut, Bot } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import logo from "@/assets/freedom-adjustment-logo.png";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { queryClient } from "@/App";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const mainItems = [
  { title: "Dashboard", url: "/", icon: Home },
  { title: "Claims", url: "/claims", icon: FileText },
  { title: "Tasks", url: "/tasks", icon: CheckSquare },
  { title: "Inbox", url: "/inbox", icon: Inbox },
  
  { title: "Darwin Ops", url: "/darwin-operations", icon: Bot },
  { title: "Clients", url: "/clients", icon: Users },
  { title: "Networking", url: "/networking", icon: Network },
  { title: "Sales", url: "/sales", icon: DollarSign },
  { title: "Templates", url: "/templates", icon: FileStack },
  { title: "Settings", url: "/settings", icon: Settings },
];

const accountItems: any[] = [];

export function AppSidebar() {
  const { open } = useSidebar();
  const { signOut, user } = useAuth();

  // Fetch unread notification count for claims
  const { data: unreadClaimNotifications = 0, refetch: refetchNotifications } = useQuery({
    queryKey: ["unread-claim-notifications", user?.id],
    queryFn: async () => {
      if (!user?.id) return 0;
      const { count, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_read", false);
      if (error) throw error;
      return count || 0;
    },
    enabled: !!user?.id,
    staleTime: 10000,
  });

  // Real-time subscription for notification updates
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel('sidebar-notifications')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          refetchNotifications();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, refetchNotifications]);

  const handleSignOut = async () => {
    await signOut();
    queryClient.clear();
    window.location.href = "/auth";
  };

  return (
    <Sidebar className="border-r border-sidebar-border text-purple-900" style={{ background: 'linear-gradient(180deg, #ffffff 0%, hsl(270, 80%, 92%) 40%, hsl(270, 60%, 60%) 100%)' }}>
      <SidebarContent>
        <div className="px-4 py-4 flex items-center">
          <img src={logo} alt="Freedom Claims" className="h-10 w-auto" />
        </div>

        <div className="h-20" />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink 
                      to={item.url} 
                      end={item.url === "/"}
                      className="text-purple-900 hover:bg-white/30 transition-colors relative"
                      activeClassName="bg-white/40 text-purple-950 font-medium"
                    >
                      <item.icon className="h-5 w-5" />
                      <span>{item.title}</span>
                      {item.title === "Claims" && unreadClaimNotifications > 0 && (
                        <Badge 
                          variant="destructive" 
                          className="ml-1 h-5 min-w-5 flex items-center justify-center p-0 text-xs"
                        >
                          {unreadClaimNotifications > 99 ? "99+" : unreadClaimNotifications}
                        </Badge>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Logout button at bottom */}
        <div className="mt-auto p-4 border-t border-white/30">
          {user && (
            <div className="mb-3">
              {open && (
                <p className="text-xs text-purple-700 truncate">
                  {user.email}
                </p>
              )}
            </div>
          )}
          <Button
            onClick={handleSignOut}
            variant="ghost"
            className="w-full justify-start text-purple-900 hover:bg-white/30"
          >
            <LogOut className="h-5 w-5" />
            {open && <span className="ml-2">Log Out</span>}
          </Button>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}
