import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  FileText,
  Upload,
  Download,
  Eye,
  Trash2,
  Loader2,
  FileSignature,
  Send,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";

interface CheckFilesSectionProps {
  checkIntakeItemId: string;
}

interface CheckFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  file_size: number | null;
  category: string;
  source: string;
  description: string | null;
  signature_request_id: string | null;
  created_at: string;
}

const BUCKET = "claim-files";

export function CheckFilesSection({ checkIntakeItemId }: CheckFilesSectionProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(
    null,
  );

  const { data: files = [], isLoading } = useQuery({
    queryKey: ["check-files", checkIntakeItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_files")
        .select("*")
        .eq("check_intake_item_id", checkIntakeItemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CheckFile[];
    },
  });

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const path = `check-intake/${checkIntakeItemId}/files/${Date.now()}-${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });
        if (upErr) throw upErr;

        const { error: insErr } = await supabase.from("check_files").insert({
          check_intake_item_id: checkIntakeItemId,
          file_name: file.name,
          file_path: path,
          file_type: file.type || null,
          file_size: file.size,
          category: "other",
          source: "manual",
          uploaded_by: user?.id ?? null,
        });
        if (insErr) throw insErr;
      }
      toast({ title: "Uploaded" });
      qc.invalidateQueries({ queryKey: ["check-files", checkIntakeItemId] });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (file: CheckFile) => {
      await supabase.storage.from(BUCKET).remove([file.file_path]);
      const { error } = await supabase
        .from("check_files")
        .delete()
        .eq("id", file.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "File deleted" });
      qc.invalidateQueries({ queryKey: ["check-files", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not delete",
        description: err.message,
        variant: "destructive",
      }),
  });

  const sendToHomeownerMutation = useMutation({
    mutationFn: async (file: CheckFile) => {
      const { data, error } = await supabase.functions.invoke(
        "send-file-to-homeowner",
        { body: { check_file_id: file.id } },
      );
      if (error) {
        const details = (error as any).context
          ? await (error as any).context.text().catch(() => "")
          : (error as Error).message;
        throw new Error(details || (error as Error).message);
      }
      return data;
    },
    onSuccess: () => {
      toast({
        title: "Sent to homeowner",
        description: "Timeline updated and email sent from notify@checksops.com.",
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not send",
        description: err.message,
        variant: "destructive",
      }),
  });

  const openSigned = async (file: CheckFile, download = false) => {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(file.file_path, 300);
    if (error || !data?.signedUrl) {
      toast({
        title: "Could not open file",
        description: error?.message,
        variant: "destructive",
      });
      return;
    }
    if (download) {
      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.download = file.file_name;
      a.click();
    } else {
      setPreview({ url: data.signedUrl, name: file.file_name });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Files ({files.length})
          </CardTitle>
          <div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1" />
              )}
              Upload
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Signed Direction-to-Pay PDFs are saved here automatically. You can also
          upload any supporting documents related to this check.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground border rounded-md py-6">
            No files yet.
          </div>
        ) : (
          files.map((file) => {
            const isSigned =
              file.category === "signed_dtp" || file.source === "system";
            return (
              <div
                key={file.id}
                className="flex items-center gap-2 border rounded-md p-2 hover:bg-muted/40 transition-colors"
              >
                {isSigned ? (
                  <FileSignature className="h-4 w-4 text-primary shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">
                      {file.file_name}
                    </p>
                    {isSigned && (
                      <Badge variant="secondary" className="text-[9px]">
                        signed DTP
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {format(new Date(file.created_at), "MMM d, yyyy h:mm a")}
                    {file.file_size
                      ? ` · ${(file.file_size / 1024).toFixed(0)} KB`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => openSigned(file)}
                    title="Preview"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => openSigned(file, true)}
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-destructive"
                    onClick={() => {
                      if (confirm(`Delete "${file.file_name}"?`)) {
                        deleteMutation.mutate(file);
                      }
                    }}
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={!!preview} onOpenChange={() => setPreview(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.name}</DialogTitle>
          </DialogHeader>
          {preview &&
            (preview.name.toLowerCase().endsWith(".pdf") ? (
              <iframe
                src={preview.url}
                className="w-full h-[70vh] rounded border"
              />
            ) : (
              <img
                src={preview.url}
                alt={preview.name}
                className="max-w-full max-h-[70vh] object-contain mx-auto rounded"
              />
            ))}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
