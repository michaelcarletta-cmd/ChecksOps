import { useState, useEffect, useCallback } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/aws/client";
import { format } from "date-fns";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";

interface Notification {
  id: string;
  is_read: boolean;
  created_at: string;
  claim_id: string;
  claim_updates: {
    content: string;
    profiles: {
      full_name: string | null;
      email: string;
    } | null;
  };
  claims: {
    claim_number: string;
  };
}

export function NotificationPopover() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const fetchNotifications = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .from("notifications")
      .select(`
        id,
        is_read,
        created_at,
        claim_id,
        claim_updates!inner (
          content,
          profiles (
            full_name,
            email
          )
        ),
        claims (
          claim_number
        )
      `)
      .eq("user_id", user.id)
      .eq("is_read", false)
      .order("created_at", { ascending: false });

    if (data) {
      setNotifications(data as any);
      setUnreadCount(data.length);
    }
  }, [user]);

  useAwsPollingFallback(!!user, fetchNotifications, 20_000);

  useEffect(() => {
    if (!user) return;
    
    fetchNotifications();

    const notificationsChannel = supabase
      .channel('notifications-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchNotifications();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(notificationsChannel);
    };
  }, [user, fetchNotifications]);

  const markNotificationAsRead = async (notificationId: string, claimId: string) => {
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", notificationId);
    
    // Invalidate sidebar and claims table notification queries
    queryClient.invalidateQueries({ queryKey: ["claim-notifications"] });
    queryClient.invalidateQueries({ queryKey: ["unread-claim-notifications"] });
    
    navigate(`/claims/${claimId}`);
    fetchNotifications();
  };

  const markAllAsRead = async () => {
    if (!user || notifications.length === 0) return;
    
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user.id)
      .eq("is_read", false);
    
    queryClient.invalidateQueries({ queryKey: ["claim-notifications"] });
    queryClient.invalidateQueries({ queryKey: ["unread-claim-notifications"] });
    fetchNotifications();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge 
              variant="destructive" 
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Notifications</h3>
            <p className="text-sm text-muted-foreground">
              {unreadCount} unread mention{unreadCount !== 1 ? "s" : ""}
            </p>
          </div>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllAsRead} className="text-xs">
              Mark all read
            </Button>
          )}
        </div>
        <ScrollArea className="h-[400px]">
          {notifications.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No unread notifications
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => {
                const authorName = notification.claim_updates.profiles?.full_name 
                  || notification.claim_updates.profiles?.email 
                  || "Someone";
                
                return (
                  <div
                    key={notification.id}
                    className="p-4 hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => markNotificationAsRead(notification.id, notification.claim_id)}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h4 className="font-medium text-sm">{authorName} mentioned you</h4>
                      <Badge variant="default" className="text-xs shrink-0">
                        New
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground line-clamp-2 mb-2">
                      {notification.claim_updates.content}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Claim: {notification.claims?.claim_number}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {format(new Date(notification.created_at), "MMM d, yyyy h:mm a")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}