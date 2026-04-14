import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquare, Send, Phone, X, Plus, Users, FileText } from "lucide-react";
import { MergeFieldButtons } from "@/components/MergeFieldButtons";
import { format } from "date-fns";
import { formatPhoneNumber, parseLocalDate } from "@/lib/utils";

interface SMSMessage {
  id: string;
  from_number: string;
  to_number: string;
  message_body: string;
  status: string;
  direction: string;
  created_at: string;
  user_id: string;
}

interface Contact {
  label: string;
  phone: string;
  type: string;
}

interface SMSTemplate {
  id: string;
  name: string;
  body: string;
  category: string | null;
}

interface ClaimSMSProps {
  claimId: string;
  policyholderPhone?: string;
}

export function ClaimSMS({ claimId, policyholderPhone }: ClaimSMSProps) {
  const [messages, setMessages] = useState<SMSMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const smsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const insertAtCursor = useCallback((field: string) => {
    const ta = smsTextareaRef.current;
    if (ta) {
      const start = ta.selectionStart ?? newMessage.length;
      const end = ta.selectionEnd ?? newMessage.length;
      const val = newMessage.slice(0, start) + field + newMessage.slice(end);
      setNewMessage(val);
      requestAnimationFrame(() => { ta.focus(); const p = start + field.length; ta.setSelectionRange(p, p); });
    } else { setNewMessage(prev => prev + field); }
  }, [newMessage]);
  const [manualPhone, setManualPhone] = useState("");
  const [selectedRecipients, setSelectedRecipients] = useState<Contact[]>([]);
  const [availableContacts, setAvailableContacts] = useState<Contact[]>([]);
  const [claimData, setClaimData] = useState<any>(null);
  const [inspectionData, setInspectionData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const { toast } = useToast();

  // Fetch SMS templates
  const { data: templates } = useQuery({
    queryKey: ["sms-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_templates")
        .select("id, name, body, category")
        .eq("is_active", true)
        .order("category")
        .order("name");
      if (error) throw error;
      return data as SMSTemplate[];
    },
  });

  useEffect(() => {
    fetchMessages();
    fetchClaimContacts();
    
    // Subscribe to new SMS messages
    const channel = supabase
      .channel('sms-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'sms_messages',
          filter: `claim_id=eq.${claimId}`,
        },
        (payload) => {
          setMessages((current) => [payload.new as SMSMessage, ...current]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [claimId]);

  const fetchClaimContacts = async () => {
    try {
      // Fetch claim with related data
      const { data: claim, error: claimError } = await supabase
        .from("claims")
        .select(`
          policyholder_name,
          policyholder_phone,
          policyholder_email,
          policyholder_address,
          adjuster_name,
          adjuster_phone,
          referrer_id,
          claim_number,
          policy_number,
          loss_type,
          loss_date,
          insurance_company
        `)
        .eq("id", claimId)
        .single();

      if (claimError) throw claimError;
      setClaimData(claim);

      // Fetch the latest/upcoming inspection for this claim
      const { data: inspection } = await supabase
        .from("inspections")
        .select("inspection_date, inspection_time, inspector_name, inspection_type")
        .eq("claim_id", claimId)
        .order("inspection_date", { ascending: false })
        .limit(1)
        .single();
      
      if (inspection) {
        setInspectionData(inspection);
      }

      const contacts: Contact[] = [];

      // Add policyholder
      if (claim?.policyholder_phone) {
        contacts.push({
          label: claim.policyholder_name || "Policyholder",
          phone: claim.policyholder_phone,
          type: "policyholder"
        });
      }

      // Add adjuster
      if (claim?.adjuster_phone) {
        contacts.push({
          label: claim.adjuster_name || "Adjuster",
          phone: claim.adjuster_phone,
          type: "adjuster"
        });
      }

      // Fetch multiple adjusters
      const { data: adjusters } = await supabase
        .from("claim_adjusters")
        .select("adjuster_name, adjuster_phone")
        .eq("claim_id", claimId);

      if (adjusters) {
        adjusters.forEach(adj => {
          if (adj.adjuster_phone && !contacts.some(c => c.phone === adj.adjuster_phone)) {
            contacts.push({
              label: adj.adjuster_name || "Adjuster",
              phone: adj.adjuster_phone,
              type: "adjuster"
            });
          }
        });
      }

      // Fetch referrer
      if (claim?.referrer_id) {
        const { data: referrer } = await supabase
          .from("referrers")
          .select("name, phone")
          .eq("id", claim.referrer_id)
          .single();

        if (referrer?.phone) {
          contacts.push({
            label: referrer.name || "Referrer",
            phone: referrer.phone,
            type: "referrer"
          });
        }
      }

      // Fetch contractors assigned to claim
      const { data: claimContractors } = await supabase
        .from("claim_contractors")
        .select("contractor_id")
        .eq("claim_id", claimId);

      if (claimContractors && claimContractors.length > 0) {
        const contractorIds = claimContractors.map(cc => cc.contractor_id);
        const { data: contractors } = await supabase
          .from("profiles")
          .select("id, full_name, phone")
          .in("id", contractorIds);

        if (contractors) {
          contractors.forEach(contractor => {
            if (contractor.phone) {
              contacts.push({
                label: contractor.full_name || "Contractor",
                phone: contractor.phone,
                type: "contractor"
              });
            }
          });
        }
      }

      setAvailableContacts(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
    }
  };

  const applyTemplate = (templateId: string) => {
    const template = templates?.find(t => t.id === templateId);
    if (!template) {
      return;
    }

    let body = template.body;

    // Build a lookup map for all ${...} merge fields to actual claim data
    const fieldMap: Record<string, string> = {};

    if (claimData) {
      fieldMap["${policyholder}"] = claimData.policyholder_name || "";
      fieldMap["${policyholder_phone}"] = claimData.policyholder_phone || "";
      fieldMap["${policyholder_email}"] = claimData.policyholder_email || "";
      fieldMap["${property_address}"] = claimData.policyholder_address || "";
      fieldMap["${address.street}"] = claimData.policyholder_address || "";
      fieldMap["${address.city}"] = "";
      fieldMap["${claim.claim_number}"] = claimData.claim_number || "";
      fieldMap["${policy}"] = claimData.policy_number || "";
      fieldMap["${insurance_company}"] = claimData.insurance_company || "";
      fieldMap["${claim.loss_type}"] = claimData.loss_type || "";
      fieldMap["${claim.loss_date}"] = claimData.loss_date
        ? format(parseLocalDate(claimData.loss_date), "MM/dd/yyyy")
        : "";
      fieldMap["${claim.status}"] = claimData.status || "";
      fieldMap["${mortgage_company}"] = claimData.mortgage_company || "";
      fieldMap["${loan_number}"] = claimData.loan_number || "";
      fieldMap["${ssn_last_four}"] = claimData.ssn_last_four || "";
    }

    // Inspection fields
    if (inspectionData) {
      const formattedDate = inspectionData.inspection_date
        ? format(parseLocalDate(inspectionData.inspection_date), "MMMM d, yyyy")
        : "";
      let formattedTime = "";
      if (inspectionData.inspection_time) {
        const [hours, minutes] = inspectionData.inspection_time.split(':');
        const hour = parseInt(hours, 10);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const hour12 = hour % 12 || 12;
        formattedTime = `${hour12}:${minutes} ${ampm}`;
      }
      fieldMap["${inspection.date}"] = formattedDate;
      fieldMap["${inspection.time}"] = formattedTime;
      fieldMap["${inspection.inspector}"] = inspectionData.inspector_name || "";
    } else {
      fieldMap["${inspection.date}"] = "[NO INSPECTION SCHEDULED]";
      fieldMap["${inspection.time}"] = "";
      fieldMap["${inspection.inspector}"] = "";
    }

    // Settlement fields from claimData accounting if available
    if (claimData) {
      fieldMap["${settlement.total_rcv}"] = claimData.total_rcv != null ? `$${Number(claimData.total_rcv).toLocaleString()}` : "";
      fieldMap["${settlement.total_net}"] = claimData.total_net_claim != null ? `$${Number(claimData.total_net_claim).toLocaleString()}` : "";
      fieldMap["${settlement.total_deductible}"] = claimData.deductible != null ? `$${Number(claimData.deductible).toLocaleString()}` : "";
      fieldMap["${settlement.prior_offer}"] = claimData.prior_offer != null ? `$${Number(claimData.prior_offer).toLocaleString()}` : "";
      fieldMap["${settlement.total_checks}"] = claimData.total_checks_received != null ? `$${Number(claimData.total_checks_received).toLocaleString()}` : "";
      fieldMap["${settlement.outstanding}"] = claimData.outstanding != null ? `$${Number(claimData.outstanding).toLocaleString()}` : "";
    }

    // Replace all ${...} patterns using the field map
    body = body.replace(/\$\{[^}]+\}/g, (match) => {
      if (match in fieldMap) return fieldMap[match];
      return match; // leave unknown fields as-is
    });

    setNewMessage(body);
  };

  const fetchMessages = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sms_messages")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setMessages(data || []);
    } catch (error: any) {
      console.error("Error fetching SMS messages:", error);
      toast({
        title: "Error",
        description: "Failed to load SMS messages",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleContact = (contact: Contact) => {
    setSelectedRecipients(prev => {
      const exists = prev.some(r => r.phone === contact.phone);
      if (exists) {
        return prev.filter(r => r.phone !== contact.phone);
      } else {
        return [...prev, contact];
      }
    });
  };

  const addManualNumber = () => {
    if (!manualPhone.trim()) return;
    
    // Check if already added
    if (selectedRecipients.some(r => r.phone === manualPhone.trim())) {
      toast({
        title: "Already added",
        description: "This number is already in the recipients list",
      });
      return;
    }

    setSelectedRecipients(prev => [
      ...prev,
      { label: manualPhone.trim(), phone: manualPhone.trim(), type: "manual" }
    ]);
    setManualPhone("");
  };

  const removeRecipient = (phone: string) => {
    setSelectedRecipients(prev => prev.filter(r => r.phone !== phone));
  };

  const handleSendSMS = async () => {
    if (!newMessage.trim() || selectedRecipients.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one recipient and enter a message",
        variant: "destructive",
      });
      return;
    }

    setSending(true);
    try {
      // Send to all selected recipients
      const sendPromises = selectedRecipients.map(recipient =>
        supabase.functions.invoke("send-sms", {
          body: {
            claimId,
            toNumber: recipient.phone,
            messageBody: newMessage,
          },
        })
      );

      const results = await Promise.all(sendPromises);
      const errors = results.filter(r => r.error);

      if (errors.length > 0) {
        toast({
          title: "Partial Success",
          description: `Sent to ${results.length - errors.length} of ${results.length} recipients`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Success",
          description: `SMS sent to ${selectedRecipients.length} recipient${selectedRecipients.length > 1 ? 's' : ''}`,
        });
      }

      setNewMessage("");
      setSelectedRecipients([]);
    } catch (error: any) {
      console.error("Error sending SMS:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to send SMS",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const getContactTypeColor = (type: string) => {
    switch (type) {
      case "policyholder": return "bg-blue-500/10 text-blue-500 border-blue-500/20";
      case "adjuster": return "bg-purple-500/10 text-purple-500 border-purple-500/20";
      case "referrer": return "bg-green-500/10 text-green-500 border-green-500/20";
      case "contractor": return "bg-orange-500/10 text-orange-500 border-orange-500/20";
      default: return "bg-muted text-muted-foreground border-border";
    }
  };

  return (
    <div className="space-y-6">
      {/* Send SMS Form */}
      <Card className="p-6 border-border bg-card">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">Send Text Message</h3>
          </div>
          
          {/* Contact Selection */}
          {availableContacts.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                Select Recipients
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {availableContacts.map((contact) => {
                  const isSelected = selectedRecipients.some(r => r.phone === contact.phone);
                  return (
                    <div
                      key={contact.phone}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        isSelected 
                          ? "bg-primary/10 border-primary" 
                          : "bg-muted/30 border-border hover:bg-muted/50"
                      }`}
                      onClick={() => toggleContact(contact)}
                    >
                      <Checkbox checked={isSelected} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {contact.label}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {contact.phone}
                        </p>
                      </div>
                      <Badge variant="outline" className={`text-xs ${getContactTypeColor(contact.type)}`}>
                        {contact.type}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual Phone Entry */}
          <div className="space-y-2">
            <Label htmlFor="phone">Add Phone Number</Label>
            <div className="flex gap-2">
              <Phone className="h-4 w-4 mt-3 text-muted-foreground" />
              <Input
                id="phone"
                type="tel"
                placeholder="123-456-7890"
                value={manualPhone}
                onChange={(e) => setManualPhone(formatPhoneNumber(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && addManualNumber()}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addManualNumber}
                disabled={!manualPhone.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Selected Recipients */}
          {selectedRecipients.length > 0 && (
            <div className="space-y-2">
              <Label>Recipients ({selectedRecipients.length})</Label>
              <div className="flex flex-wrap gap-2">
                {selectedRecipients.map((recipient) => (
                  <Badge
                    key={recipient.phone}
                    variant="secondary"
                    className="flex items-center gap-1 pr-1"
                  >
                    <span className="truncate max-w-[150px]">
                      {recipient.label}
                    </span>
                    <Button
                      type="button"
                      onClick={() => removeRecipient(recipient.phone)}
                      variant="ghost"
                      size="icon"
                      className="ml-1 h-5 w-5 rounded p-0"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Template Selection */}
          {templates && templates.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Use Template
              </Label>
              <Select onValueChange={applyTemplate}>
                <SelectTrigger className="bg-muted/30">
                  <SelectValue placeholder="Select a template..." />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      <div className="flex items-center gap-2">
                        <span>{template.name}</span>
                        {template.category && (
                          <span className="text-xs text-muted-foreground">({template.category})</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="message">Message</Label>
              <div className="flex items-center gap-2">
                <MergeFieldButtons compact onInsert={insertAtCursor} />
                <span className="text-xs text-muted-foreground">
                  {newMessage.length} chars
                </span>
              </div>
            </div>
            <Textarea
              ref={smsTextareaRef}
              id="message"
              placeholder="Type your message here..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              rows={4}
              className="resize-none"
            />
          </div>

          <Button
            onClick={handleSendSMS}
            disabled={sending || !newMessage.trim() || selectedRecipients.length === 0}
            className="w-full"
          >
            <Send className="h-4 w-4 mr-2" />
            {sending ? "Sending..." : `Send SMS${selectedRecipients.length > 1 ? ` to ${selectedRecipients.length} recipients` : ''}`}
          </Button>
        </div>
      </Card>

      {/* Messages List */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-foreground">Message History</h3>
        
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading messages...</div>
        ) : messages.length === 0 ? (
          <Card className="p-8 text-center border-border bg-card">
            <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No messages yet</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <Card
                key={message.id}
                className={`p-4 border-border ${
                  message.direction === "outbound"
                    ? "bg-primary/5 ml-8"
                    : "bg-secondary/50 mr-8"
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {message.direction === "outbound" ? "To" : "From"}: {" "}
                      {message.direction === "outbound"
                        ? message.to_number
                        : message.from_number}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        message.status === "delivered"
                          ? "bg-green-500/10 text-green-600"
                          : message.status === "sent" || message.status === "queued"
                          ? "bg-blue-500/10 text-blue-600"
                          : message.status === "failed"
                          ? "bg-red-500/10 text-red-600"
                          : "bg-gray-500/10 text-gray-600"
                      }`}
                    >
                      {message.status === "queued" ? "Sent" : message.status}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-foreground mb-2">{message.message_body}</p>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(message.created_at), "MMM d, yyyy 'at' h:mm a")}
                </p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
