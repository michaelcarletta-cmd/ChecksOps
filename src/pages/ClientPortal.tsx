import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClaimsTableConnected } from "@/components/ClaimsTableConnected";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { HelpCircle } from "lucide-react";

const ClientPortal = () => {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">My Claims</h1>
          <p className="text-muted-foreground mt-1">View and manage your property insurance claims</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => navigate("/client-portal/help")} variant="outline" size="sm">
            <HelpCircle className="h-4 w-4 mr-2" /> How It Works
          </Button>
          <Button onClick={signOut} variant="outline" size="sm">Sign Out</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your Claims</CardTitle>
        </CardHeader>
        <CardContent>
          <ClaimsTableConnected portalType="client" />
        </CardContent>
      </Card>
    </div>
  );
};

export default ClientPortal;
