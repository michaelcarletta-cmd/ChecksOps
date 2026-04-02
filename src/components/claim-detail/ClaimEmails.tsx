import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Mail, Send, Loader2, MailOpen, Reply, Paperclip, Download, FileText, Image as ImageIcon } from "lucide-react";
import { OutlookEmailSync } from "./OutlookEmailSync";
import { Badge } from "@/components/ui/badge";
import { EmailComposer } from "@/components/EmailComposer";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface ReplyContext {
  recipientEmail: string;
  recipientName: string;
  recipientType: string;
  originalSubject: string;
  originalBody: string;
  originalDate: string;
}

// Decode base64 to UTF-8 string properly
function base64ToUtf8(base64: string): string {
  try {
    const cleaned = base64.replace(/[\r\n\s]/g, '');
    const binaryString = atob(cleaned);
    // Convert binary string to Uint8Array for proper UTF-8 decoding
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    // Use TextDecoder for proper UTF-8 handling
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    console.error('Base64 UTF-8 decode error:', e);
    return base64;
  }
}

// Clean up email text for display
function cleanEmailText(text: string): string {
  return text
    // Convert Windows line endings to Unix
    .replace(/\r\n/g, '\n')
    // Remove PNG binary data sections (raw image data that leaked into text)
    // Match from PNG header markers through to end of binary data
    .replace(/\x89PNG[\s\S]*?(?:IEND|$)/g, '[Image]')
    .replace(/PNG\s*\n?\s*IHDR[\s\S]*?(?:IEND|$)/g, '[Image]')
    // Remove lines that are mostly non-printable characters (binary data)
    .replace(/^[^\x20-\x7E\n]*[\x00-\x1F\x7F-\xFF]{10,}[^\x20-\x7E\n]*$/gm, '')
    // Remove gibberish sequences (20+ non-ASCII chars in a row)
    .replace(/[^\x20-\x7E\n\r\t]{20,}/g, '')
    // Remove image placeholders like [A computer and phone with a screen...]
    .replace(/\[[^\]]*Description automatically generated\][^\n]*/g, '')
    // Remove CID image references
    .replace(/\[cid:[^\]]+\]/g, '')
    // Remove mailto: links embedded in text
    .replace(/<mailto:[^>]+>/g, '')
    // Remove http/https links embedded in text  
    .replace(/<https?:\/\/[^>]+>/g, '')
    // Clean up multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    // Clean up multiple [Image] placeholders
    .replace(/(\[Image\]\s*)+/g, '[Image]\n')
    .trim();
}

// Check if text is readable (mostly printable ASCII)
function isReadableText(text: string): boolean {
  if (!text || text.length < 10) return false;
  // Count printable characters (space through tilde, plus common whitespace)
  const printable = text.match(/[\x20-\x7E\n\r\t]/g);
  const ratio = printable ? printable.length / text.length : 0;
  return ratio > 0.85; // At least 85% printable characters
}

// Decode base64 encoded email body (for legacy incorrectly stored emails)
function decodeEmailBody(body: string): string {
  if (!body) return '';
  
  // Check if body contains MIME boundary markers (multipart message)
  const boundaryMatch = body.match(/--([-_A-Za-z0-9]+)/);
  
  if (boundaryMatch) {
    const boundary = boundaryMatch[0];
    
    // First, check if content BEFORE the first boundary is base64 (common pattern)
    const firstBoundaryIndex = body.indexOf(boundary);
    if (firstBoundaryIndex > 50) {
      const contentBeforeBoundary = body.substring(0, firstBoundaryIndex).trim();
      // Check if this looks like base64 (no obvious plain text markers)
      const cleanedPreBoundary = contentBeforeBoundary.replace(/[\r\n\s]/g, '');
      if (/^[A-Za-z0-9+/=]+$/.test(cleanedPreBoundary) && cleanedPreBoundary.length > 50) {
        try {
          const decoded = base64ToUtf8(cleanedPreBoundary);
          if (isReadableText(decoded)) {
            return cleanEmailText(decoded);
          }
        } catch (e) {
          // Not valid base64, continue with other methods
        }
      }
    }
    
    const parts = body.split(new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    
    // Try to find text/plain section in MIME parts
    for (const part of parts) {
      if (part.includes('Content-Type: text/plain') || part.includes('content-type: text/plain')) {
        const encodingMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : '';
        
        // Split on double newline to separate headers from content
        const contentParts = part.split(/\r?\n\r?\n/);
        if (contentParts.length > 1) {
          let content = contentParts.slice(1).join('\n\n').trim();
          // Remove any trailing boundary markers
          content = content.replace(/\r?\n--[-_A-Za-z0-9]+--?\s*$/g, '').trim();
          
          if (encoding === 'base64') {
            const decoded = base64ToUtf8(content);
            if (isReadableText(decoded)) {
              return cleanEmailText(decoded);
            }
          } else if (isReadableText(content)) {
            return cleanEmailText(content);
          }
        }
      }
    }
    
    // If we have content before the first boundary that's readable, use it
    if (firstBoundaryIndex > 0) {
      const contentBefore = body.substring(0, firstBoundaryIndex).trim();
      if (isReadableText(contentBefore)) {
        return cleanEmailText(contentBefore);
      }
    }
  }
  
  // Check if body looks like pure base64 (no MIME structure, no readable text)
  if (!isReadableText(body)) {
    const cleaned = body.replace(/[\r\n\s]/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 100 && cleaned.length % 4 === 0) {
      try {
        const decoded = base64ToUtf8(cleaned);
        if (decoded && !decoded.includes('\x00') && isReadableText(decoded)) {
          return cleanEmailText(decoded);
        }
      } catch (e) {
        // Not valid base64
      }
    }
  }
  
  // Check for Content-Transfer-Encoding header in the body
  if (body.includes('Content-Transfer-Encoding: base64') || body.includes('Content-Transfer-Encoding:base64')) {
    const base64Match = body.match(/Content-Transfer-Encoding:\s*base64\s*\r?\n\r?\n([A-Za-z0-9+/=\s]+)/i);
    if (base64Match) {
      const decoded = base64ToUtf8(base64Match[1]);
      if (isReadableText(decoded)) {
        return cleanEmailText(decoded);
      }
    }
  }
  
  return cleanEmailText(body);
}

interface ClaimEmailsProps {
  claimId: string;
  claim: any;
}

export const ClaimEmails = ({ claimId, claim }: ClaimEmailsProps) => {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [replyContext, setReplyContext] = useState<ReplyContext | undefined>(undefined);

  const handleReply = (email: any) => {
    setReplyContext({
      recipientEmail: email.recipient_email,
      recipientName: email.recipient_name || email.recipient_email,
      recipientType: email.recipient_type || 'manual',
      originalSubject: email.subject,
      originalBody: email.decodedBody,
      originalDate: format(new Date(email.sent_at), "MMM d, yyyy 'at' h:mm a")
    });
    setIsComposerOpen(true);
  };

  const handleComposeNew = () => {
    setReplyContext(undefined);
    setIsComposerOpen(true);
  };

  const handleCloseComposer = () => {
    setIsComposerOpen(false);
    setReplyContext(undefined);
  };

  const { data: emails, isLoading } = useQuery({
    queryKey: ["emails", claimId],
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const allEmails: any[] = [];
      let offset = 0;
      const batchSize = 1000;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from("emails")
          .select("*")
          .eq("claim_id", claimId)
          .order("sent_at", { ascending: false })
          .range(offset, offset + batchSize - 1);
        if (error) throw error;
        if (data && data.length > 0) {
          allEmails.push(...data);
          offset += batchSize;
          hasMore = data.length === batchSize;
        } else {
          hasMore = false;
        }
      }
      return allEmails;
    },
  });

  // Fetch email attachments (files linked to emails or source=email_attachment)
  const { data: emailAttachments } = useQuery({
    queryKey: ["email-attachments", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("id, file_name, file_path, file_type, file_size, email_id, uploaded_at")
        .eq("claim_id", claimId)
        .eq("source", "email_attachment")
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // Group attachments by email_id
  const attachmentsByEmail = useMemo(() => {
    const map = new Map<string, typeof emailAttachments>();
    emailAttachments?.forEach(file => {
      if (file.email_id) {
        const existing = map.get(file.email_id) || [];
        existing.push(file);
        map.set(file.email_id, existing);
      }
    });
    return map;
  }, [emailAttachments]);

  // Decode email bodies and deduplicate (prefer outlook_sync with full body over truncated inbound)
  const decodedEmails = useMemo(() => {
    if (!emails) return [];
    
    // Normalize subject for comparison (strip Re:/Fwd:/RE:/FW: prefixes and non-alphanumeric)
    const normalizeSubject = (s: string) => 
      (s || '').replace(/^(re|fwd|fw|forward):\s*/gi, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    
    // Enrich truncated inbound emails with fuller body from outlook_sync when available
    // Only enrich if the outlook_sync version actually contains the inbound body (same email, just fuller)
    return emails.map((email: any) => {
      let body = email.body;
      
      // If this is a short inbound email, look for a fuller outlook_sync version that contains the same content
      if (email.recipient_type === 'inbound' && body && body.length < 300) {
        const inboundSubjectNorm = normalizeSubject(email.subject);
        const bodyStart = body.substring(0, Math.min(40, body.length)).trim();
        const fullerVersion = emails.find((other: any) => {
          if (other.id === email.id || other.recipient_type !== 'outlook_sync') return false;
          const otherSubjectNorm = normalizeSubject(other.subject);
          const subjectMatch = inboundSubjectNorm.includes(otherSubjectNorm) || otherSubjectNorm.includes(inboundSubjectNorm);
          // The fuller version must contain the beginning of the inbound body to be the same email
          return subjectMatch && other.body && other.body.length > body.length && other.body.includes(bodyStart);
        });
        if (fullerVersion) {
          body = fullerVersion.body;
        }
      }
      
      return {
        ...email,
        decodedBody: decodeEmailBody(body)
      };
    });
  }, [emails]);

  const handleDownloadAttachment = async (filePath: string, fileName: string) => {
    try {
      const { data, error } = await supabase.storage
        .from('claim-files')
        .download(filePath);
      if (error || !data) return;
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download error:', e);
    }
  };

  const isImageType = (fileType: string | null) => {
    return fileType?.startsWith('image/');
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="text-lg font-semibold">Email Communications</h3>
        <div className="flex items-center gap-2">
          <OutlookEmailSync claimId={claimId} />
          <Button 
            className="bg-primary hover:bg-primary/90"
            onClick={handleComposeNew}
          >
            <Send className="h-4 w-4 mr-2" />
            Compose Email
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : decodedEmails && decodedEmails.length > 0 ? (
        <div className="space-y-3">
          {decodedEmails.map((email) => {
            const isInbound = email.recipient_type === 'inbound';
            return (
              <div key={email.id} className={`p-4 rounded-lg border transition-colors ${isInbound ? 'border-green-500/30 bg-green-500/5 hover:bg-green-500/10' : 'border-border hover:bg-muted/30'}`}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {isInbound ? (
                      <MailOpen className="h-4 w-4 text-green-600" />
                    ) : (
                      <Mail className="h-4 w-4 text-primary" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-foreground">{email.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {isInbound ? 'From' : 'To'}: {email.recipient_name || email.recipient_email} ({email.recipient_email})
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(email.sent_at), "MMM d, yyyy 'at' h:mm a")}
                    </span>
                    {isInbound ? (
                      <Badge variant="outline" className="text-xs bg-green-500/10 text-green-700 border-green-500/30">
                        Inbound
                      </Badge>
                    ) : email.recipient_type && (
                      <Badge variant="outline" className="text-xs">
                        {email.recipient_type}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-3">
                  {email.decodedBody}
                </div>
                {/* Email Attachments */}
                {attachmentsByEmail.get(email.id)?.length ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Paperclip className="h-3 w-3" />
                      {attachmentsByEmail.get(email.id)!.length} Attachment{attachmentsByEmail.get(email.id)!.length > 1 ? 's' : ''}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {attachmentsByEmail.get(email.id)!.map(file => (
                        <div key={file.id} className="flex items-center gap-2 p-2 rounded-md border bg-background hover:bg-muted/50 transition-colors">
                          {isImageType(file.file_type) ? (
                            <ImageIcon className="h-4 w-4 text-primary flex-shrink-0" />
                          ) : (
                            <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                          <span className="text-xs truncate flex-1">{file.file_name}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => handleDownloadAttachment(file.file_path, file.file_name)}
                          >
                            <Download className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReply(email)}
                  >
                    <Reply className="h-4 w-4 mr-2" />
                    Reply
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          No emails logged yet. Click "Compose Email" to send one.
        </div>
      )}

      <EmailComposer
        isOpen={isComposerOpen}
        onClose={handleCloseComposer}
        claimId={claimId}
        claim={claim}
        replyTo={replyContext}
      />
    </div>
  );
};