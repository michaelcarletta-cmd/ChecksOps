import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Mail, Send, Loader2, FileText, Paperclip, X, Plus, Monitor } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { DarwinInlineNudges } from "@/components/claim-detail/DarwinInlineNudges";
import { MergeFieldButtons } from "@/components/MergeFieldButtons";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface Recipient {
  email: string;
  name: string;
  type: string;
}

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string | null;
}

interface ClaimFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  file_size: number | null;
}

interface ReplyContext {
  recipientEmail: string;
  recipientName: string;
  recipientType: string;
  originalSubject: string;
  originalBody: string;
  originalDate: string;
}

interface EmailComposerProps {
  isOpen: boolean;
  onClose: () => void;
  claimId: string;
  claim: any;
  replyTo?: ReplyContext;
}

export function EmailComposer({
  isOpen,
  onClose,
  claimId,
  claim,
  replyTo
}: EmailComposerProps) {
  const [selectedRecipients, setSelectedRecipients] = useState<Recipient[]>([]);
  const [manualEmail, setManualEmail] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<ClaimFile[]>([]);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [sendViaOutlook, setSendViaOutlook] = useState(false);

  // Check if user has an active Outlook connection
  const { data: hasOutlookConnection } = useQuery({
    queryKey: ["outlook-connection-check"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      const { data } = await supabase
        .from("email_connections")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .limit(1);
      return (data?.length || 0) > 0;
    },
    enabled: isOpen,
  });

  // Auto-populate for replies or new emails
  useEffect(() => {
    if (isOpen) {
      if (replyTo) {
        // Set up reply context
        setSelectedRecipients([{
          email: replyTo.recipientEmail,
          name: replyTo.recipientName,
          type: replyTo.recipientType
        }]);
        setEmailSubject(replyTo.originalSubject.startsWith("Re:") ? replyTo.originalSubject : `Re: ${replyTo.originalSubject}`);
        setBody(`\n\n---\nOn ${replyTo.originalDate}, ${replyTo.recipientName} wrote:\n\n${replyTo.originalBody}`);
      } else if (claim?.claim_number && !emailSubject) {
        setEmailSubject(`Re: Claim #${claim.claim_number}`);
      }
    }
  }, [isOpen, claim?.claim_number, replyTo]);

  // Fetch email templates
  const { data: emailTemplates } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("id, name, subject, body, category")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data as EmailTemplate[];
    },
    enabled: isOpen,
  });

  // Fetch claim files for attachments
  const { data: claimFiles } = useQuery({
    queryKey: ["claim-files-for-email", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("id, file_name, file_path, file_type, file_size")
        .eq("claim_id", claimId)
        .order("file_name");
      if (error) throw error;
      return data as ClaimFile[];
    },
    enabled: isOpen,
  });

  // Fetch settlement data for merge fields
  const { data: settlement } = useQuery({
    queryKey: ["claim-settlement-email", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isOpen,
  });

  const formatCurrency = (amount: number | null | undefined) => {
    if (amount == null) return "$0.00";
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  // Replace merge fields with actual values
  const replaceMergeFields = (text: string) => {
    // Calculate totals
    const dwellingACV = (settlement?.replacement_cost_value || 0) - (settlement?.recoverable_depreciation || 0) - (settlement?.non_recoverable_depreciation || 0);
    const dwellingNet = dwellingACV - (settlement?.deductible || 0);
    const otherStructuresACV = (settlement?.other_structures_rcv || 0) - (settlement?.other_structures_recoverable_depreciation || 0) - (settlement?.other_structures_non_recoverable_depreciation || 0);
    const otherStructuresNet = otherStructuresACV - (settlement?.other_structures_deductible || 0);
    const pwiACV = (settlement?.pwi_rcv || 0) - (settlement?.pwi_recoverable_depreciation || 0) - (settlement?.pwi_non_recoverable_depreciation || 0);
    const pwiNet = pwiACV - (settlement?.pwi_deductible || 0);
    const totalRCV = (settlement?.replacement_cost_value || 0) + (settlement?.other_structures_rcv || 0) + (settlement?.pwi_rcv || 0);
    const totalNet = dwellingNet + otherStructuresNet + pwiNet;
    
    // Calculate total depreciation values
    const totalRecoverableDep = (settlement?.recoverable_depreciation || 0) + 
      (settlement?.other_structures_recoverable_depreciation || 0) + 
      (settlement?.pwi_recoverable_depreciation || 0);
    const totalNonRecoverableDep = (settlement?.non_recoverable_depreciation || 0) + 
      (settlement?.other_structures_non_recoverable_depreciation || 0) + 
      (settlement?.pwi_non_recoverable_depreciation || 0);

    return text
      // Claim fields
      .replace(/\{claim\.policyholder_name\}/g, claim.policyholder_name || '')
      .replace(/\{claim\.claim_number\}/g, claim.claim_number || '')
      .replace(/\{claim\.status\}/g, claim.status || '')
      .replace(/\{claim\.loss_type\}/g, claim.loss_type || '')
      .replace(/\{claim\.loss_date\}/g, claim.loss_date || '')
      .replace(/\{claim\.policy_number\}/g, claim.policy_number || '')
      .replace(/\{claim\.policyholder_email\}/g, claim.policyholder_email || '')
      .replace(/\{claim\.policyholder_phone\}/g, claim.policyholder_phone || '')
      .replace(/\{claim\.policyholder_address\}/g, claim.policyholder_address || '')
      .replace(/\{claim\.insurance_company\}/g, claim.insurance_company || '')
      // Dwelling settlement fields (support both short and long field names)
      .replace(/\{settlement\.dwelling_rcv\}/g, formatCurrency(settlement?.replacement_cost_value))
      .replace(/\{settlement\.dwelling_recoverable_dep\}/g, formatCurrency(settlement?.recoverable_depreciation))
      .replace(/\{settlement\.dwelling_recoverable_depreciation\}/g, formatCurrency(settlement?.recoverable_depreciation))
      .replace(/\{settlement\.dwelling_non_recoverable_dep\}/g, formatCurrency(settlement?.non_recoverable_depreciation))
      .replace(/\{settlement\.dwelling_non_recoverable_depreciation\}/g, formatCurrency(settlement?.non_recoverable_depreciation))
      .replace(/\{settlement\.dwelling_deductible\}/g, formatCurrency(settlement?.deductible))
      .replace(/\{settlement\.dwelling_acv\}/g, formatCurrency(dwellingACV))
      .replace(/\{settlement\.dwelling_net\}/g, formatCurrency(dwellingNet))
      // Other Structures settlement fields (support both short and long field names)
      .replace(/\{settlement\.other_structures_rcv\}/g, formatCurrency(settlement?.other_structures_rcv))
      .replace(/\{settlement\.other_structures_recoverable_dep\}/g, formatCurrency(settlement?.other_structures_recoverable_depreciation))
      .replace(/\{settlement\.other_structures_recoverable_depreciation\}/g, formatCurrency(settlement?.other_structures_recoverable_depreciation))
      .replace(/\{settlement\.other_structures_non_recoverable_dep\}/g, formatCurrency(settlement?.other_structures_non_recoverable_depreciation))
      .replace(/\{settlement\.other_structures_non_recoverable_depreciation\}/g, formatCurrency(settlement?.other_structures_non_recoverable_depreciation))
      .replace(/\{settlement\.other_structures_deductible\}/g, formatCurrency(settlement?.other_structures_deductible))
      .replace(/\{settlement\.other_structures_acv\}/g, formatCurrency(otherStructuresACV))
      .replace(/\{settlement\.other_structures_net\}/g, formatCurrency(otherStructuresNet))
      // PWI settlement fields (support both short and long field names)
      .replace(/\{settlement\.pwi_rcv\}/g, formatCurrency(settlement?.pwi_rcv))
      .replace(/\{settlement\.pwi_recoverable_dep\}/g, formatCurrency(settlement?.pwi_recoverable_depreciation))
      .replace(/\{settlement\.pwi_recoverable_depreciation\}/g, formatCurrency(settlement?.pwi_recoverable_depreciation))
      .replace(/\{settlement\.pwi_non_recoverable_dep\}/g, formatCurrency(settlement?.pwi_non_recoverable_depreciation))
      .replace(/\{settlement\.pwi_non_recoverable_depreciation\}/g, formatCurrency(settlement?.pwi_non_recoverable_depreciation))
      .replace(/\{settlement\.pwi_deductible\}/g, formatCurrency(settlement?.pwi_deductible))
      .replace(/\{settlement\.pwi_acv\}/g, formatCurrency(pwiACV))
      .replace(/\{settlement\.pwi_net\}/g, formatCurrency(pwiNet))
      // Totals
      .replace(/\{settlement\.total_rcv\}/g, formatCurrency(totalRCV))
      .replace(/\{settlement\.total_net\}/g, formatCurrency(totalNet))
      .replace(/\{settlement\.total_recoverable_dep\}/g, formatCurrency(totalRecoverableDep))
      .replace(/\{settlement\.total_non_recoverable_dep\}/g, formatCurrency(totalNonRecoverableDep))
      .replace(/\{settlement\.prior_offer\}/g, formatCurrency(settlement?.prior_offer));
  };

  const handleTemplateSelect = (templateId: string) => {
    if (templateId === "_none") {
      return;
    }
    const template = emailTemplates?.find(t => t.id === templateId);
    if (template) {
      setEmailSubject(replaceMergeFields(template.subject));
      setBody(replaceMergeFields(template.body));
    }
  };

  const toggleFileSelection = (file: ClaimFile) => {
    setSelectedFiles(prev => {
      const isSelected = prev.some(f => f.id === file.id);
      if (isSelected) {
        return prev.filter(f => f.id !== file.id);
      } else {
        return [...prev, file];
      }
    });
  };

  const removeFile = (fileId: string) => {
    setSelectedFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Fetch adjusters from claim_adjusters table
  const { data: adjusters } = useQuery({
    queryKey: ["claim-adjusters-email", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_adjusters")
        .select("id, adjuster_name, adjuster_email, company, is_primary")
        .eq("claim_id", claimId);
      if (error) throw error;
      return data;
    },
    enabled: isOpen,
  });

  // Build recipients list from claim data
  const availableRecipients: Recipient[] = [];
  
  if (claim.policyholder_email) {
    availableRecipients.push({
      email: claim.policyholder_email,
      name: claim.policyholder_name || "Policyholder",
      type: "policyholder"
    });
  }
  
  // Add adjusters from claim_adjusters table
  adjusters?.forEach((adjuster) => {
    if (adjuster.adjuster_email) {
      availableRecipients.push({
        email: adjuster.adjuster_email,
        name: adjuster.adjuster_name || "Adjuster",
        type: adjuster.is_primary ? "primary adjuster" : "adjuster"
      });
    }
  });

  // Add insurance company email
  if (claim.insurance_email) {
    availableRecipients.push({
      email: claim.insurance_email,
      name: claim.insurance_company || "Insurance Company",
      type: "insurance company"
    });
  }

  // Fetch contractors assigned to this claim
  const { data: contractors } = useQuery({
    queryKey: ["claim-contractors-email", claimId],
    queryFn: async () => {
      // First get contractor IDs for this claim
      const { data: assignments, error: assignmentError } = await supabase
        .from("claim_contractors")
        .select("contractor_id")
        .eq("claim_id", claimId);
      
      if (assignmentError) throw assignmentError;
      if (!assignments || assignments.length === 0) return [];
      
      const contractorIds = assignments.map(a => a.contractor_id);
      
      // Then fetch profiles for those contractors
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", contractorIds);
      
      if (profileError) throw profileError;
      return profiles || [];
    },
    enabled: isOpen,
  });

  // Add contractors to recipients
  contractors?.forEach((contractor: any) => {
    if (contractor.email) {
      availableRecipients.push({
        email: contractor.email,
        name: contractor.full_name || "Contractor",
        type: "contractor"
      });
    }
  });

  // Fetch referrer
  const { data: referrer } = useQuery({
    queryKey: ["claim-referrer", claim.referrer_id],
    queryFn: async () => {
      if (!claim.referrer_id) return null;
      const { data, error } = await supabase
        .from("referrers")
        .select("email, name")
        .eq("id", claim.referrer_id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: isOpen && !!claim.referrer_id,
  });

  // Add referrer to recipients
  if (referrer?.email) {
    availableRecipients.push({
      email: referrer.email,
      name: referrer.name,
      type: "referrer"
    });
  }

  const addRecipientFromDropdown = (email: string) => {
    if (email === "_select") return;
    const recipient = availableRecipients.find(r => r.email === email);
    if (recipient && !selectedRecipients.some(r => r.email === recipient.email)) {
      setSelectedRecipients(prev => [...prev, recipient]);
    }
  };

  const addManualEmail = () => {
    const email = manualEmail.trim();
    if (!email) return;
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast.error("Please enter a valid email address");
      return;
    }
    
    if (selectedRecipients.some(r => r.email === email)) {
      toast.error("This email is already added");
      return;
    }
    
    setSelectedRecipients(prev => [...prev, {
      email,
      name: email,
      type: "manual"
    }]);
    setManualEmail("");
  };

  const removeRecipient = (email: string) => {
    setSelectedRecipients(prev => prev.filter(r => r.email !== email));
  };

  const handleSend = async () => {
    if (selectedRecipients.length === 0 || !emailSubject || !body) {
      toast.error("Please add at least one recipient and fill in all fields");
      return;
    }

    setSending(true);
    try {
      // Build the claim-specific email address for CC
      const sanitizedPolicyNumber = claim.policy_number 
        ? claim.policy_number.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        : claim.id.slice(0, 8);
      const claimEmail = `claim-${sanitizedPolicyNumber}@claims.freedomclaims.work`;

      const recipientPayload = selectedRecipients.map(r => ({
        email: r.email,
        name: r.name,
        type: r.type
      }));

      const attachmentPayload = selectedFiles.map(f => ({
        filePath: f.file_path,
        fileName: f.file_name,
        fileType: f.file_type
      }));

      let data: any;
      let error: any;

      if (sendViaOutlook) {
        // Send via Outlook (Microsoft Graph API)
        const result = await supabase.functions.invoke("send-outlook-email", {
          body: {
            recipients: recipientPayload,
            subject: emailSubject,
            htmlBody: `<div style="font-family: Arial, sans-serif; white-space: pre-wrap;">${body}</div>`,
            claimId,
            claimEmailCc: claimEmail,
            attachments: attachmentPayload,
          }
        });
        data = result.data;
        error = result.error;
      } else {
        // Send via system (Resend)
        const result = await supabase.functions.invoke("send-email", {
          body: {
            recipients: recipientPayload,
            subject: emailSubject,
            body,
            claimId,
            claimEmailCc: claimEmail,
            attachments: attachmentPayload,
          }
        });
        data = result.data;
        error = result.error;
      }

      if (error) throw error;

      // Check attachment status in response
      const response = data as { 
        success: boolean; 
        attachmentCount: number; 
        attachmentsRequested: number;
        attachmentErrors?: string[];
      };
      
      if (selectedFiles.length > 0) {
        if (response.attachmentCount === response.attachmentsRequested) {
          toast.success(`Email sent to ${selectedRecipients.length} recipient(s) with ${response.attachmentCount} attachment(s)`);
        } else if (response.attachmentCount > 0) {
          toast.warning(`Email sent but only ${response.attachmentCount}/${response.attachmentsRequested} attachments were included`);
          if (response.attachmentErrors) {
            console.warn("Attachment errors:", response.attachmentErrors);
          }
        } else {
          toast.warning(`Email sent but attachments could not be included`);
          if (response.attachmentErrors) {
            console.warn("Attachment errors:", response.attachmentErrors);
          }
        }
      } else {
        toast.success(`Email sent to ${selectedRecipients.length} recipient(s)`);
      }
      
      onClose();
      setSelectedRecipients([]);
      setEmailSubject("");
      setBody("");
      setSelectedFiles([]);
    } catch (error: any) {
      console.error("Error sending email:", error);
      const errorMessage = await getFunctionErrorMessage(error, "Failed to send email");
      toast.error(errorMessage);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
          <DialogDescription>Send an email to one or more recipients</DialogDescription>
        </DialogHeader>
        
        {/* Darwin Strategic Nudges */}
        <DarwinInlineNudges claimId={claimId} context="email_composer" maxNudges={2} />
        
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Load from Template</Label>
            <Select onValueChange={handleTemplateSelect}>
              <SelectTrigger>
                <SelectValue placeholder="Select a template (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">-- No template --</SelectItem>
                {emailTemplates?.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      {template.name} {template.category && `(${template.category})`}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Recipients</Label>
            
            {/* Selected Recipients */}
            {selectedRecipients.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {selectedRecipients.map((recipient) => (
                  <Badge key={recipient.email} variant="secondary" className="flex items-center gap-1 pr-1">
                    <span className="max-w-[200px] truncate">
                      {recipient.name !== recipient.email ? `${recipient.name} <${recipient.email}>` : recipient.email}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-4 w-4 p-0 hover:bg-transparent"
                      onClick={() => removeRecipient(recipient.email)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            )}

            {/* Add from dropdown */}
            <Select onValueChange={addRecipientFromDropdown} value="_select">
              <SelectTrigger>
                <SelectValue placeholder="Add from claim contacts..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_select">-- Select a contact --</SelectItem>
                {availableRecipients
                  .filter(r => !selectedRecipients.some(sr => sr.email === r.email))
                  .map((recipient) => (
                    <SelectItem key={recipient.email} value={recipient.email}>
                      {recipient.name} ({recipient.type}) - {recipient.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            {/* Add manual email */}
            <div className="flex gap-2">
              <Input
                placeholder="Enter email address manually..."
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addManualEmail();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addManualEmail}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              placeholder="Email subject"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="body">Message</Label>
              <MergeFieldButtons compact onInsert={(field) => setBody(prev => prev + field)} />
            </div>
            <Textarea
              id="body"
              placeholder="Type your message here..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[150px]"
            />
          </div>

          {/* File Attachments Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Attachments</Label>
              <Button 
                type="button" 
                variant="outline" 
                size="sm"
                onClick={() => setShowFileSelector(!showFileSelector)}
              >
                <Paperclip className="h-4 w-4 mr-2" />
                {showFileSelector ? "Hide Files" : "Add Files"}
              </Button>
            </div>

            {/* Selected Files Display */}
            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedFiles.map(file => (
                  <Badge key={file.id} variant="secondary" className="flex items-center gap-1 pr-1">
                    <FileText className="h-3 w-3" />
                    <span className="max-w-[150px] truncate">{file.file_name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-4 w-4 p-0 hover:bg-transparent"
                      onClick={() => removeFile(file.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            )}

            {/* File Selector */}
            {showFileSelector && (
              <div className="border rounded-md p-2 bg-muted/30">
                <ScrollArea className="h-[150px]">
                  {claimFiles && claimFiles.length > 0 ? (
                    <div className="space-y-1">
                      {claimFiles.map(file => (
                        <div 
                          key={file.id}
                          className="flex items-center gap-2 p-2 rounded hover:bg-muted cursor-pointer"
                          onClick={() => toggleFileSelection(file)}
                        >
                          <Checkbox 
                            checked={selectedFiles.some(f => f.id === file.id)}
                            onCheckedChange={() => toggleFileSelection(file)}
                          />
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 truncate text-sm">{file.file_name}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatFileSize(file.file_size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No files uploaded to this claim yet
                    </p>
                  )}
                </ScrollArea>
              </div>
            )}
          </div>

          {/* Send via Outlook toggle */}
          {hasOutlookConnection && (
            <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
              <Checkbox
                id="send-via-outlook"
                checked={sendViaOutlook}
                onCheckedChange={(checked) => setSendViaOutlook(checked === true)}
              />
              <label htmlFor="send-via-outlook" className="flex items-center gap-2 text-sm cursor-pointer">
                <Monitor className="h-4 w-4 text-primary" />
                <span>Send via Outlook</span>
              </label>
              <span className="text-xs text-muted-foreground ml-auto">
                {sendViaOutlook ? "Email will be sent from your Outlook account" : "Email will be sent from Freedom Claims"}
              </span>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={sending || selectedRecipients.length === 0}>
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending{sendViaOutlook ? " via Outlook" : ""}...
                </>
              ) : (
                <>
                  {sendViaOutlook ? <Monitor className="h-4 w-4 mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                  Send{sendViaOutlook ? " via Outlook" : ""} {selectedRecipients.length > 0 && `(${selectedRecipients.length})`} {selectedFiles.length > 0 && `+ ${selectedFiles.length} files`}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
