import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Clock } from "lucide-react";
import { getFriendlyAuthError, hardRefresh } from "@/lib/authErrorMessage";
import { ToastAction } from "@/components/ui/toast";

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotPasswordLoading, setForgotPasswordLoading] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [resetMode, setResetMode] = useState(() => {
    const isRecovery =
      window.location.hash.includes("type=recovery") ||
      new URLSearchParams(window.location.search).get("type") === "recovery" ||
      new URLSearchParams(window.location.search).get("reset") === "1" ||
      sessionStorage.getItem("password_reset_mode") === "true";
    if (isRecovery) {
      sessionStorage.setItem("password_reset_mode", "true");
    }
    return isRecovery;
  });
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const inRecoveryFlow =
      window.location.hash.includes("type=recovery") ||
      new URLSearchParams(window.location.search).get("type") === "recovery" ||
      new URLSearchParams(window.location.search).get("reset") === "1" ||
      sessionStorage.getItem("password_reset_mode") === "true";
    if (inRecoveryFlow) {
      setResetMode(true);
      sessionStorage.setItem("password_reset_mode", "true");
    }

    // Check if user is already logged in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !inRecoveryFlow) {
        checkApprovalAndNavigate(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      const recoveryInUrl =
        window.location.hash.includes("type=recovery") ||
        new URLSearchParams(window.location.search).get("type") === "recovery" ||
        new URLSearchParams(window.location.search).get("reset") === "1" ||
        sessionStorage.getItem("password_reset_mode") === "true";

      if (event === "PASSWORD_RECOVERY" || recoveryInUrl) {
        setResetMode(true);
        sessionStorage.setItem("password_reset_mode", "true");
        return;
      }

      if (session) {
        checkApprovalAndNavigate(session.user.id);
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const checkApprovalAndNavigate = async (userId: string) => {
    // Check user roles
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);

    const roleList = roles?.map(r => r.role) || [];
    const isStaff = roleList.includes('staff');
    const isAdmin = roleList.includes('admin');
    const isContractor = roleList.includes('contractor');
    const isReferrer = roleList.includes('referrer');
    const isClient = roleList.includes('client');
    
    // Staff approval check
    if (isStaff && !isAdmin) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("approval_status")
        .eq("id", userId)
        .single();

      if (profile?.approval_status === 'pending') {
        setPendingApproval(true);
        await supabase.auth.signOut();
        return;
      }

      if (profile?.approval_status === 'denied') {
        toast({
          title: "Access Denied",
          description: "Your account request has been denied. Please contact an administrator.",
          variant: "destructive",
        });
        await supabase.auth.signOut();
        return;
      }
    }

    // Route to appropriate portal based on role
    if (isContractor && !isAdmin && !isStaff) {
      navigate("/contractor-portal");
    } else if (isReferrer && !isAdmin && !isStaff) {
      navigate("/referrer-portal");
    } else if (isClient && !isAdmin && !isStaff) {
      navigate("/client-portal");
    } else {
      navigate("/");
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setPendingApproval(false);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: {
          full_name: fullName,
          role: 'staff',
        },
      },
    });

    if (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } else {
      setPendingApproval(true);
      toast({
        title: "Account Created",
        description: "Your account is pending approval. An administrator will review your request.",
      });
    }

    setLoading(false);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setPendingApproval(false);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password.trim(),
    });

    if (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } else if (data.user) {
      // Check approval will happen in the auth state change handler
    }

    setLoading(false);
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      toast({
        title: "Enter your email",
        description: "Please enter your email address first.",
        variant: "destructive",
      });
      return;
    }

    setForgotPasswordLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth?reset=1`,
    });

    if (error) {
      toast({
        title: "Unable to send reset email",
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Password reset sent",
        description: "Check your inbox for a password reset link.",
      });
    }
    setForgotPasswordLoading(false);
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 6) {
      toast({
        title: "Password too short",
        description: "Password must be at least 6 characters long.",
        variant: "destructive",
      });
      return;
    }

    if (newPassword !== confirmNewPassword) {
      toast({
        title: "Passwords do not match",
        description: "Please make sure both password fields match.",
        variant: "destructive",
      });
      return;
    }

    setUpdatingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      toast({
        title: "Unable to update password",
        description: error.message,
        variant: "destructive",
      });
      setUpdatingPassword(false);
      return;
    }

    await supabase.auth.signOut();
    window.history.replaceState({}, document.title, "/auth");
    sessionStorage.removeItem("password_reset_mode");
    setResetMode(false);
    setNewPassword("");
    setConfirmNewPassword("");
    toast({
      title: "Password updated",
      description: "Your password has been reset. Please sign in.",
    });
    setUpdatingPassword(false);
  };

  if (pendingApproval) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-yellow-500/20 flex items-center justify-center">
              <Clock className="h-6 w-6 text-yellow-500" />
            </div>
            <CardTitle>Pending Approval</CardTitle>
            <CardDescription>
              Your account is awaiting administrator approval. You'll be able to sign in once your access has been approved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => setPendingApproval(false)}
            >
              Back to Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (resetMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Reset Your Password</CardTitle>
            <CardDescription>
              Enter a new password for your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
              <Button type="submit" className="w-full" disabled={updatingPassword}>
                {updatingPassword ? "Updating password..." : "Update Password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>Sign in to access your claims portal</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1">
              <TabsTrigger value="signin" className="flex-1 justify-center text-base font-medium px-4">Sign In</TabsTrigger>
              <TabsTrigger value="signup" className="flex-1 justify-center text-base font-medium px-4">Sign Up</TabsTrigger>
            </TabsList>
            
            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signin-email">Email</Label>
                  <Input
                    id="signin-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signin-password">Password</Label>
                  <Input
                    id="signin-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs text-primary underline-offset-4 hover:underline disabled:opacity-60"
                    disabled={forgotPasswordLoading}
                    onClick={handleForgotPassword}
                  >
                    {forgotPasswordLoading ? "Sending reset..." : "Forgot password?"}
                  </button>
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Signing in..." : "Sign In"}
                </Button>
              </form>
            </TabsContent>
            
            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-name">Full Name</Label>
                  <Input
                    id="signup-name"
                    type="text"
                    placeholder="John Doe"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Staff accounts require administrator approval before access is granted.
                </p>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Creating account..." : "Sign Up"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}