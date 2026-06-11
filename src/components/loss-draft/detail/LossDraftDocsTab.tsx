import { useRef, useState } from "react";
import { ViewCheckImageButton } from "@/components/checks/ViewCheckImageButton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Upload, FileText, Trash2, Download } from "lucide-react";
import { format } from "date-fns";
import type { LossDraftDoc } from "@/hooks/queries/useLossDraft";

interface Props {
  lossDraftId: string;
  claimId: string;
  checkIntakeItemId?: string | null;
  docs: LossDraftDoc[];
  onChanged: () => void;
}

export function LossDraftDocsTab({ lossDraftId, claimId, checkIntakeItemId, docs, onChanged }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);

  const toggleDoc = async (docId: string, isSubmitted: boolean) => {
    if (!user?.id) return;
    try {
      const { error } = await supabase.rpc("loss_draft_toggle_document", {
        p_doc_id: docId,
        p_is_submitted: isSubmitted,
        p_actor_id: user.id,
      });
      if (error) throw error;
      onChanged();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleFileUpload = async (docId: string, file: File) => {
    if (!user?.id) return;
    setUploadingDocId(docId);
    try {
      const filePath = `${claimId}/${lossDraftId}/${docId}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("loss-draft-documents")
        .upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("loss_draft_documents")
        .update({
          file_path: filePath,
          file_name: file.name,
          is_submitted: true,
          submitted_at: new Date().toISOString(),
          submitted_by: user.id,
        })
        .eq("id", docId);
      if (updateError) throw updateError;

      toast({
        title: "Document uploaded",
        description: `${file.name} uploaded successfully.`,
      });
      onChanged();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingDocId(null);
    }
  };

  const handleFileDownload = async (doc: LossDraftDoc) => {
    if (!doc.file_path) return;
    try {
      const { data, error } = await supabase.storage
        .from("loss-draft-documents")
        .download(doc.file_path);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name || "document";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    }
  };

  const handleFileDelete = async (doc: LossDraftDoc) => {
    if (!doc.file_path) return;
    try {
      const { error: delError } = await supabase.storage
        .from("loss-draft-documents")
        .remove([doc.file_path]);
      if (delError) throw delError;

      const { error: updateError } = await supabase
        .from("loss_draft_documents")
        .update({ file_path: null, file_name: null })
        .eq("id", doc.id);
      if (updateError) throw updateError;

      toast({ title: "File removed" });
      onChanged();
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="p-4 space-y-3">
        {checkIntakeItemId && (
          <div className="flex justify-end">
            <ViewCheckImageButton 
              checkId={checkIntakeItemId}
              className="w-full text-xs h-8"
            />
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && uploadingDocId) {
              handleFileUpload(uploadingDocId, file);
            }
            e.target.value = "";
          }}
        />
        {docs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No document checklist generated yet.
          </p>
        ) : (
          docs.map(d => (
            <div
              key={d.id}
              className="min-w-0 overflow-hidden rounded-lg border p-2 space-y-1.5"
            >
              <div className="flex min-w-0 items-start gap-2">
                <Checkbox
                  className="mt-0.5 shrink-0"
                  checked={d.is_submitted}
                  onCheckedChange={(checked) => toggleDoc(d.id, !!checked)}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={`break-words text-xs leading-snug ${
                      d.is_submitted ? "line-through text-muted-foreground" : ""
                    }`}
                  >
                    {d.document_label}
                  </p>
                  <div className="flex flex-wrap items-center gap-1 mt-0.5">
                    {d.is_required && !d.is_submitted && (
                      <Badge variant="destructive" className="text-[9px] px-1">
                        Required
                      </Badge>
                    )}
                    {d.submitted_at && (
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(d.submitted_at), "M/d")}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="min-w-0 pl-6">
                {d.file_path ? (
                  <div className="flex min-w-0 items-center gap-1.5 rounded bg-accent/30 px-2 py-1">
                    <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[10px]">{d.file_name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 shrink-0"
                      onClick={() => handleFileDownload(d)}
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 text-destructive"
                      onClick={() => handleFileDelete(d)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-6 max-w-full gap-1 whitespace-normal break-words text-left text-[10px] leading-snug"
                    disabled={uploadingDocId === d.id}
                    onClick={() => {
                      setUploadingDocId(d.id);
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload className="h-3 w-3 shrink-0" />
                    {uploadingDocId === d.id ? "Uploading..." : "Upload File"}
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
