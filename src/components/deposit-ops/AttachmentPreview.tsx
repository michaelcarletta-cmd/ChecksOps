import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, Eye, FileCheck, Landmark, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";

const typeIcons: Record<string, typeof FileCheck> = {
  deposit_slip: FileCheck,
  stamped_receipt: CheckCircle2,
  bank_confirmation: Landmark,
};

interface Attachment {
  id: string;
  attachment_type: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  created_at: string;
}

export function AttachmentPreview({ depositItemId }: { depositItemId: string }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState("");

  const { data: attachments = [] } = useQuery({
    queryKey: ["deposit-attachments", depositItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_attachments")
        .select("*")
        .eq("deposit_item_id", depositItemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Attachment[];
    },
  });

  const handlePreview = async (att: Attachment) => {
    const { data } = await supabase.storage.from("deposit-attachments").createSignedUrl(att.file_path, 300);
    if (data?.signedUrl) {
      setPreviewUrl(data.signedUrl);
      setPreviewName(att.file_name);
    }
  };

  const handleDownload = async (att: Attachment) => {
    const { data } = await supabase.storage.from("deposit-attachments").createSignedUrl(att.file_path, 60);
    if (data?.signedUrl) {
      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.download = att.file_name;
      a.click();
    }
  };

  if (attachments.length === 0) return null;

  return (
    <>
      <div className="space-y-1">
        {attachments.map((att) => {
          const Icon = typeIcons[att.attachment_type] ?? FileCheck;
          return (
            <div key={att.id} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
                <Badge variant="outline" className="text-[9px] shrink-0">{att.attachment_type.replace(/_/g, " ")}</Badge>
                <span className="text-xs truncate">{att.file_name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{format(new Date(att.created_at), "MMM d")}</span>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => handlePreview(att)}>
                  <Eye className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => handleDownload(att)}>
                  <Download className="h-3 w-3" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!previewUrl} onOpenChange={() => setPreviewUrl(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="text-sm">{previewName}</DialogTitle>
          </DialogHeader>
          {previewUrl && (
            previewName.toLowerCase().endsWith(".pdf") ? (
              <iframe src={previewUrl} className="w-full h-[60vh] rounded border" />
            ) : (
              <img src={previewUrl} alt={previewName} className="max-w-full max-h-[60vh] object-contain mx-auto rounded" />
            )
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
