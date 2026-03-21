import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { 
  ArrowLeft, 
  Edit, 
  Mail, 
  Phone, 
  MapPin, 
  Calendar,
  FileText,
  MessageSquare,
  Eye,
  DollarSign,
  Send,
  Loader2
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { EditClientDialog } from "@/components/EditClientDialog";
import { toast } from "sonner";


interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  created_at: string;
}

const mockClientClaims = [
  {
    id: "1",
    claimNumber: "CLM-2024-001",
    propertyAddress: "123 Main St, Springfield",
    claimAmount: "$45,000",
    status: "approved",
    dateSubmitted: "2024-01-15",
  },
  {
    id: "2",
    claimNumber: "CLM-2023-087",
    propertyAddress: "789 Elm St, Springfield",
    claimAmount: "$28,500",
    status: "approved",
    dateSubmitted: "2023-11-20",
  },
  {
    id: "3",
    claimNumber: "CLM-2023-042",
    propertyAddress: "321 Pine Rd, Springfield",
    claimAmount: "$5,000",
    status: "rejected",
    dateSubmitted: "2023-08-30",
  },
];



const ClientDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [claims, setClaims] = useState<any[]>([]);
  const [isEmailDialogOpen, setIsEmailDialogOpen] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);

  const fetchClient = async () => {
    if (!id) return;
    
    try {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      setClient(data);

      // Fetch claims for this client
      const { data: claimsData } = await supabase
        .from("claims")
        .select("*")
        .eq("client_id", id)
        .order("created_at", { ascending: false });

      setClaims(claimsData || []);
    } catch (error) {
      console.error("Error fetching client:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClient();
  }, [id]);

  const getStatusClassName = (status: string) => {
    const classes: Record<string, string> = {
      new: "bg-accent/20 text-accent-foreground border border-accent/30",
      in_progress: "bg-primary/10 text-primary border border-primary/20",
      under_review: "bg-amber-500/10 text-amber-600 border border-amber-500/20",
      approved: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20",
      rejected: "bg-destructive/10 text-destructive border border-destructive/20",
    };
    return classes[status] || "bg-muted text-muted-foreground border border-border/50";
  };

  const handleSendEmail = () => {
    if (!client?.email) {
      toast.error("No email address available");
      return;
    }
    setIsEmailDialogOpen(true);
  };

  const handleSendEmailSubmit = async () => {
    if (!emailSubject || !emailBody) {
      toast.error("Please fill in all fields");
      return;
    }

    setSendingEmail(true);
    try {
      const { error } = await supabase.functions.invoke("send-email", {
        body: {
          to: client!.email,
          subject: emailSubject,
          body: emailBody,
          recipientName: client!.name,
          recipientType: "client",
        }
      });

      if (error) throw error;

      toast.success("Email sent successfully");
      setIsEmailDialogOpen(false);
      setEmailSubject("");
      setEmailBody("");
    } catch (error: any) {
      console.error("Error sending email:", error);
      toast.error(error.message || "Failed to send email");
    } finally {
      setSendingEmail(false);
    }
  };

  const handleCall = () => {
    if (!client?.phone) {
      toast.error("No phone number available");
      return;
    }
    window.location.href = `tel:${client.phone}`;
  };

  const handleSendMessage = () => {
    if (!client?.phone) {
      toast.error("No phone number available");
      return;
    }
    window.location.href = `sms:${client.phone}`;
  };

  const handleCreateClaim = () => {
    // Navigate to claims page - the NewClaimDialog will open there
    navigate("/claims");
    toast.info("Create a new claim and assign it to this client");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading client...</div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <p className="text-muted-foreground mb-4">Client not found</p>
        <Link to="/clients">
          <Button>Back to Clients</Button>
        </Link>
      </div>
    );
  }

  const mockClient = {
    ...client,
    dateAdded: client.created_at,
    totalClaims: claims.length,
    activeClaims: claims.filter(c => c.status !== "approved" && c.status !== "rejected").length,
    totalClaimValue: "$0",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/clients">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <Avatar className="h-12 w-12">
          <AvatarFallback className="bg-primary text-primary-foreground text-lg">
            {mockClient.name.split(' ').map(n => n[0]).join('')}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-foreground">{mockClient.name}</h1>
          <p className="text-muted-foreground mt-1">Client since {new Date(mockClient.dateAdded).toLocaleDateString()}</p>
        </div>
        <Button
          className="bg-primary hover:bg-primary/90"
          onClick={() => setIsEditDialogOpen(true)}
        >
          <Edit className="h-4 w-4 mr-2" />
          Edit Client
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Claims</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{mockClient.totalClaims}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Claims</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{mockClient.activeClaims}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Claim Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{mockClient.totalClaimValue}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Last Contact</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">2 days ago</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Mail className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="text-sm font-medium">{mockClient.email || "N/A"}</p>
                </div>
              </div>
              <Separator />
              <div className="flex items-center gap-3">
                <Phone className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm text-muted-foreground">Phone</p>
                  <p className="text-sm font-medium">{mockClient.phone || "N/A"}</p>
                </div>
              </div>
              <Separator />
              <div className="flex items-center gap-3">
                <MapPin className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm text-muted-foreground">Address</p>
                  <p className="text-sm font-medium">
                    {[mockClient.street, mockClient.city, mockClient.state, mockClient.zip_code]
                      .filter(Boolean)
                      .join(", ") || "N/A"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <Tabs defaultValue="claims" className="w-full">
                <TabsList className="flex flex-row w-full bg-muted/40 p-2 rounded-lg gap-1 overflow-x-auto scrollbar-hide">
                  <TabsTrigger value="claims" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Claims History</TabsTrigger>
                  <TabsTrigger value="communications" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Communications</TabsTrigger>
                  <TabsTrigger value="documents" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Documents</TabsTrigger>
                </TabsList>

                <TabsContent value="claims" className="mt-6 space-y-4">
                  {claims.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">No claims found for this client</p>
                  ) : (
                    claims.map((claim) => (
                    <div
                      key={claim.id}
                      className="p-4 rounded-lg border border-border hover:bg-muted/30 transition-colors"
                    >
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <p className="font-semibold text-foreground">{claim.claim_number}</p>
                            <p className="text-sm text-muted-foreground mt-1">{claim.policyholder_address || "No address"}</p>
                          </div>
                          <Badge className={getStatusClassName(claim.status)}>
                            {claim.status?.replace("_", " ").toUpperCase() || "UNKNOWN"}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            {claim.claim_amount && (
                              <div className="flex items-center gap-1">
                                <DollarSign className="h-4 w-4" />
                                <span className="font-semibold text-foreground">${claim.claim_amount.toLocaleString()}</span>
                              </div>
                            )}
                            <div className="flex items-center gap-1">
                              <Calendar className="h-4 w-4" />
                              <span>{new Date(claim.created_at).toLocaleDateString()}</span>
                            </div>
                          </div>
                          <Link to={`/claims/${claim.id}`}>
                            <Button variant="outline" size="sm">
                              <Eye className="h-3 w-3 mr-1" />
                              View
                            </Button>
                          </Link>
                        </div>
                      </div>
                    ))
                  )}
                </TabsContent>

                <TabsContent value="communications" className="mt-6 space-y-4">
                  <p className="text-center text-muted-foreground py-8">No communications logged yet</p>
                </TabsContent>

                <TabsContent value="documents" className="mt-6 space-y-4">
                  <p className="text-center text-muted-foreground py-8">No documents uploaded yet</p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card className="sticky top-20">
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={handleSendEmail}
                disabled={!client?.email}
              >
                <Mail className="h-4 w-4 mr-2" />
                Send Email
              </Button>
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={handleCall}
                disabled={!client?.phone}
              >
                <Phone className="h-4 w-4 mr-2" />
                Call Client
              </Button>
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={handleSendMessage}
                disabled={!client?.phone}
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                Send Text Message
              </Button>
              <Separator className="my-4" />
              <Button 
                className="w-full bg-primary hover:bg-primary/90"
                onClick={handleCreateClaim}
              >
                <FileText className="h-4 w-4 mr-2" />
                Create New Claim
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <EditClientDialog
        isOpen={isEditDialogOpen}
        onClose={() => setIsEditDialogOpen(false)}
        client={client}
        onClientUpdated={() => {
          // If client was deleted, navigate back
          supabase
            .from("clients")
            .select("id")
            .eq("id", id!)
            .single()
            .then(({ data }) => {
              if (!data) {
                navigate("/clients");
                toast.success("Client deleted successfully");
              } else {
                fetchClient();
              }
            });
        }}
      />

      <Dialog open={isEmailDialogOpen} onOpenChange={setIsEmailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send Email to {client?.name}</DialogTitle>
            <DialogDescription>Send an email to {client?.email}</DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                placeholder="Email subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-body">Message</Label>
              <Textarea
                id="email-body"
                placeholder="Type your message here..."
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                className="min-h-[200px]"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button 
                variant="outline" 
                onClick={() => setIsEmailDialogOpen(false)} 
                disabled={sendingEmail}
              >
                Cancel
              </Button>
              <Button onClick={handleSendEmailSubmit} disabled={sendingEmail}>
                {sendingEmail ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Send Email
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ClientDetail;
