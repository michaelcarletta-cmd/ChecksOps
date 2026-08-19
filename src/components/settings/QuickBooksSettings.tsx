import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle, XCircle, Loader2, ExternalLink } from "lucide-react";

const QUICKBOOKS_STORAGE_KEY = 'quickbooks_connection';

interface QuickBooksConnection {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: number;
  connectedAt: string;
}

interface QuickBooksSettingsProps {
  embedded?: boolean;
}

export function QuickBooksSettings({ embedded }: QuickBooksSettingsProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connection, setConnection] = useState<QuickBooksConnection | null>(null);

  useEffect(() => {
    // Check for existing connection
    const stored = localStorage.getItem(QUICKBOOKS_STORAGE_KEY);
    if (stored) {
      try {
        const conn = JSON.parse(stored) as QuickBooksConnection;
        // Check if token is still valid (with 5 minute buffer)
        if (conn.expiresAt > Date.now() + 300000) {
          setConnection(conn);
          setIsConnected(true);
        } else if (conn.refreshToken && conn.realmId) {
          // Try to refresh the token - pass full connection to preserve realmId
          refreshTokenWithConnection(conn);
        } else {
          // Invalid stored connection, clear it
          localStorage.removeItem(QUICKBOOKS_STORAGE_KEY);
        }
      } catch (e) {
        console.error('Error parsing stored QuickBooks connection:', e);
        localStorage.removeItem(QUICKBOOKS_STORAGE_KEY);
      }
    }

    // Check for OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const realmId = urlParams.get('realmId');

    if (code && realmId) {
      handleOAuthCallback(code, realmId);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Set up automatic token refresh 5 minutes before expiration
  useEffect(() => {
    if (!connection || !isConnected) return;

    const timeUntilRefresh = connection.expiresAt - Date.now() - 300000; // 5 min before expiry
    
    if (timeUntilRefresh <= 0) {
      // Token already expired or about to, refresh now
      refreshTokenWithConnection(connection);
      return;
    }

    const refreshTimer = setTimeout(() => {
      console.log('Auto-refreshing QuickBooks token');
      refreshTokenWithConnection(connection);
    }, timeUntilRefresh);

    return () => clearTimeout(refreshTimer);
  }, [connection, isConnected]);

  const refreshTokenWithConnection = async (existingConnection: QuickBooksConnection) => {
    try {
      console.log('Refreshing QuickBooks token for realm:', existingConnection.realmId);
      
      const { data, error } = await supabase.functions.invoke('quickbooks-auth', {
        body: {
          action: 'refresh-token',
          refreshToken: existingConnection.refreshToken,
        },
      });

      if (error || !data?.success) {
        console.error('Token refresh failed:', error || data);
        // Don't disconnect immediately - QuickBooks refresh tokens are valid for 100 days
        // Only disconnect if refresh fails multiple times
        const failCount = parseInt(localStorage.getItem('qb_refresh_failures') || '0') + 1;
        localStorage.setItem('qb_refresh_failures', failCount.toString());
        
        if (failCount >= 3) {
          console.error('Multiple refresh failures, disconnecting');
          handleDisconnect();
          localStorage.removeItem('qb_refresh_failures');
        }
        return;
      }

      // Reset failure count on success
      localStorage.removeItem('qb_refresh_failures');

      const newConnection: QuickBooksConnection = {
        accessToken: data.tokens.access_token,
        refreshToken: data.tokens.refresh_token || existingConnection.refreshToken, // Keep old if not provided
        realmId: existingConnection.realmId, // Always preserve realmId
        expiresAt: Date.now() + (data.tokens.expires_in * 1000),
        connectedAt: existingConnection.connectedAt,
      };

      localStorage.setItem(QUICKBOOKS_STORAGE_KEY, JSON.stringify(newConnection));
      setConnection(newConnection);
      setIsConnected(true);
      console.log('QuickBooks token refreshed successfully');
    } catch (err) {
      console.error('Token refresh error:', err);
    }
  };

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/settings`;
      
      const { data, error } = await supabase.functions.invoke('quickbooks-auth', {
        body: {
          action: 'get-auth-url',
          redirectUri,
        },
      });

      if (error) throw error;

      // Store state for verification
      localStorage.setItem('quickbooks_oauth_state', data.state);
      
      // Redirect to QuickBooks OAuth
      window.location.href = data.authUrl;
    } catch (err: any) {
      console.error('QuickBooks connect error:', err);
      toast.error('Failed to connect to QuickBooks');
      setIsConnecting(false);
    }
  };

  const handleOAuthCallback = async (code: string, realmId: string) => {
    setIsConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/settings`;

      const { data, error } = await supabase.functions.invoke('quickbooks-auth', {
        body: {
          action: 'exchange-code',
          code,
          realmId,
          redirectUri,
        },
      });

      if (error || !data?.success) {
        throw new Error(error?.message || 'Token exchange failed');
      }

      const newConnection: QuickBooksConnection = {
        accessToken: data.tokens.access_token,
        refreshToken: data.tokens.refresh_token,
        realmId: data.realmId,
        expiresAt: Date.now() + (data.tokens.expires_in * 1000),
        connectedAt: new Date().toISOString(),
      };

      localStorage.setItem(QUICKBOOKS_STORAGE_KEY, JSON.stringify(newConnection));
      setConnection(newConnection);
      setIsConnected(true);
      toast.success('QuickBooks connected successfully');
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      toast.error('Failed to complete QuickBooks connection');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    localStorage.removeItem(QUICKBOOKS_STORAGE_KEY);
    localStorage.removeItem('quickbooks_oauth_state');
    setConnection(null);
    setIsConnected(false);
    toast.success('QuickBooks disconnected');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          QuickBooks Integration
          {isConnected ? (
            <Badge variant="default" className="bg-green-600">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">
              <XCircle className="h-3 w-3 mr-1" />
              Not Connected
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Connect to QuickBooks to send payments directly from the CRM
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isConnected && connection ? (
          <div className="space-y-4">
            <div className="p-4 bg-muted/50 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Company ID:</span>
                <span className="font-medium">{connection.realmId}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Connected:</span>
                <span className="font-medium">
                  {new Date(connection.connectedAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Token Expires:</span>
                <span className="font-medium">
                  {new Date(connection.expiresAt).toLocaleString()}
                </span>
              </div>
            </div>
            <Button variant="destructive" onClick={handleDisconnect}>
              Disconnect QuickBooks
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Connect your QuickBooks account to enable direct payments to clients, 
              contractors, and employees from the Accounting tab and Sales dashboard.
            </p>
            <Button onClick={handleConnect} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Connect to QuickBooks
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
