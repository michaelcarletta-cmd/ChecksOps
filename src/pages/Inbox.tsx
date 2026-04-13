import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, FileSignature, ArrowRight, Clock, MessageSquare, Brain } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { InboxSMSQuickReply } from "@/components/inbox/InboxSMSQuickReply";
import { DarwinSMSActivityLog } from "@/components/inbox/DarwinSMSActivityLog";

const Inbox = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch all emails with claim information
  const { data: emails, isLoading: emailsLoading } = useQuery({
    queryKey: ["inbox-emails"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("emails")
        .select(`
          *,
          claims (
            id,
            claim_number,
            policyholder_name
          )
        `)
        .order("sent_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // Fetch all signature requests with claim information
  const { data: signatureRequests, isLoading: signaturesLoading } = useQuery({
    queryKey: ["inbox-signatures"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select(`
          *,
          claims (
            id,
            claim_number,
            policyholder_name
          ),
          signature_signers (
            id,
            signer_name,
            signer_email,
            status
          )
        `)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // Fetch SMS messages with claim information
  const { data: smsMessages, isLoading: smsLoading } = useQuery({
    queryKey: ["inbox-sms"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_messages")
        .select(`
          *,
          claims (
            id,
            claim_number,
            policyholder_name
          )
        `)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });


  // Count inbound SMS messages
  const inboundSmsCount = smsMessages?.filter(sms => sms.direction === 'inbound').length || 0;

  const isLoading = emailsLoading || signaturesLoading || smsLoading;

  const handleEmailClick = (claimId: string) => {
    navigate(`/claims/${claimId}`);
  };

  const handleSignatureClick = (claimId: string) => {
    navigate(`/claims/${claimId}`);
  };

  const getStatusBadge = (status: string) => {
    const statusColors: Record<string, string> = {
      pending: "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
      completed: "bg-green-500/20 text-green-500 border-green-500/30",
      declined: "bg-red-500/20 text-red-500 border-red-500/30",
    };

    return (
      <Badge className={`${statusColors[status] || "bg-muted"} border`}>
        {status}
      </Badge>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
        <p className="text-muted-foreground mt-2">
          Manage all emails, SMS messages, signature requests, and AI-drafted messages
        </p>
      </div>

      <Tabs defaultValue="sms" className="space-y-4">
        <TabsList className="flex flex-row w-full bg-muted/40 p-2 rounded-lg gap-1 overflow-x-auto scrollbar-hide">
          <TabsTrigger value="sms" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">
            <MessageSquare className="h-4 w-4 mr-2" />
            SMS {inboundSmsCount > 0 ? `(${inboundSmsCount} inbound)` : `(${smsMessages?.length || 0})`}
          </TabsTrigger>
          <TabsTrigger value="emails" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">
            <Mail className="h-4 w-4 mr-2" />
            Emails ({emails?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="signatures" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">
            <FileSignature className="h-4 w-4 mr-2" />
            Signature Requests ({signatureRequests?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="darwin-sms" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">
            <Brain className="h-4 w-4 mr-2" />
            Darwin SMS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sms" className="space-y-4">
          {!smsMessages || smsMessages.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center py-10">
                <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No SMS messages found</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {smsMessages.map((sms) => {
                const isInbound = sms.direction === 'inbound';
                const replyToNumber = isInbound ? sms.from_number : sms.to_number;
                return (
                  <Card
                    key={sms.id}
                    className={`bg-card border-border transition-colors ${isInbound ? 'border-l-4 border-l-green-500' : ''}`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <MessageSquare className={`h-4 w-4 ${isInbound ? 'text-green-500' : 'text-primary'}`} />
                            {isInbound ? (
                              <Badge className="bg-green-500/20 text-green-500 border-green-500/30 border text-xs">
                                Inbound
                              </Badge>
                            ) : (
                              <Badge className="bg-blue-500/20 text-blue-500 border-blue-500/30 border text-xs">
                                Outbound
                              </Badge>
                            )}
                            <span className="text-sm text-muted-foreground">
                              {isInbound ? `From: ${sms.from_number}` : `To: ${sms.to_number}`}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {format(new Date(sms.created_at), "MMM d, yyyy 'at' h:mm a")}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {sms.status}
                            </Badge>
                          </div>
                        </div>
                        {sms.claims && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge 
                              variant="outline" 
                              className="border-primary/30 text-primary cursor-pointer hover:bg-primary/10"
                              onClick={() => navigate(`/claims/${sms.claims.id}`)}
                            >
                              {sms.claims.claim_number || "No Claim #"}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => navigate(`/claims/${sms.claims.id}`)}
                            >
                              <ArrowRight className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-sm text-foreground whitespace-pre-wrap">{sms.message_body}</p>
                      </div>
                      {sms.claims && (
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">Claim: </span>
                          {sms.claims.policyholder_name}
                        </div>
                      )}
                      {sms.claims && (
                        <InboxSMSQuickReply
                          claimId={sms.claims.id}
                          toNumber={replyToNumber}
                          onSent={() => queryClient.invalidateQueries({ queryKey: ["inbox-sms"] })}
                        />
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="emails" className="space-y-4">
          {!emails || emails.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center py-10">
                <Mail className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No emails found</p>
              </CardContent>
            </Card>
          ) : (
          <div className="space-y-2">
              {emails.map((email) => {
                const isInbound = email.recipient_type === 'inbound';
                return (
                  <Card
                    key={email.id}
                    className="bg-card border-border hover:border-primary/50 cursor-pointer transition-colors"
                    onClick={() => email.claims && handleEmailClick(email.claims.id)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <Mail className={`h-4 w-4 ${isInbound ? 'text-green-500' : 'text-primary'}`} />
                            {isInbound && (
                              <Badge className="bg-green-500/20 text-green-500 border-green-500/30 border text-xs">
                                Inbound
                              </Badge>
                            )}
                            <CardTitle className="text-base text-foreground">
                              {email.subject}
                            </CardTitle>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span>
                              {isInbound ? 'From: ' : 'To: '}
                              {email.recipient_name || email.recipient_email}
                            </span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {format(new Date(email.sent_at || email.created_at), "MMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                        </div>
                        {email.claims && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge variant="outline" className="border-primary/30 text-primary">
                              {email.claims.claim_number || "No Claim #"}
                            </Badge>
                            <ArrowRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {email.claims && (
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">Claim: </span>
                          {email.claims.policyholder_name}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="signatures" className="space-y-4">
          {!signatureRequests || signatureRequests.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center py-10">
                <FileSignature className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No signature requests found</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {signatureRequests.map((request) => (
                <Card
                  key={request.id}
                  className="bg-card border-border hover:border-primary/50 cursor-pointer transition-colors"
                  onClick={() => request.claims && handleSignatureClick(request.claims.id)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <FileSignature className="h-4 w-4 text-primary" />
                          <CardTitle className="text-base text-foreground">
                            {request.document_name}
                          </CardTitle>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(request.created_at), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                          <span>•</span>
                          {getStatusBadge(request.status)}
                        </div>
                      </div>
                      {request.claims && (
                        <div className="flex items-center gap-2 text-sm">
                          <Badge variant="outline" className="border-primary/30 text-primary">
                            {request.claims.claim_number || "No Claim #"}
                          </Badge>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {request.claims && (
                      <div className="text-sm text-muted-foreground mb-2">
                        <span className="font-medium text-foreground">Claim: </span>
                        {request.claims.policyholder_name}
                      </div>
                    )}
                    {request.signature_signers && request.signature_signers.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-foreground">Signers:</p>
                        {request.signature_signers.map((signer: any) => (
                          <div key={signer.id} className="flex items-center justify-between text-sm">
                            <div className="flex-1">
                              <span className="text-foreground">{signer.signer_name}</span>
                              <span className="text-muted-foreground"> ({signer.signer_email})</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {getStatusBadge(signer.status)}
                              {signer.status === "pending" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const signUrl = `${window.location.origin}/sign?token=${signer.access_token}`;
                                    navigator.clipboard.writeText(signUrl);
                                    toast({
                                      title: "Link copied",
                                      description: "Signing link copied to clipboard",
                                    });
                                  }}
                                >
                                  Copy Link
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="darwin-sms" className="space-y-4">
          <DarwinSMSActivityLog />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Inbox;
