import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { CheckImagesViewer } from "./CheckImagesViewer";
import { toStorageObjectPath } from "@/lib/storagePath";
import { isAwsStaging } from "@/lib/awsStaging";

/**
 * Reusable "View Check Images" button.
 * Fetches both front + back image paths, generates signed URLs,
 * and opens a viewer that lets the user toggle between Front / Back.
 *
 * Available at every stage including AFTER deposit — front + back are
 * preserved on the check record so users can always re-access them.
 */
export function ViewCheckImageButton({
  checkId,
  frontImagePath,
  backImagePath,
  backImageOriginalPath,
  backImageDepositPath,
  checkNumber,
  size = "sm",
  variant = "outline",
  label = "View Check Images",
  className,
}: {
  checkId?: string | null;
  frontImagePath?: string | null;
  backImagePath?: string | null;
  /** Optional: clean rear image path (preferred for view). */
  backImageOriginalPath?: string | null;
  /** Optional: deposit-ready rear image (shown only when explicitly requested elsewhere). */
  backImageDepositPath?: string | null;
  checkNumber?: string | null;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "secondary";
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!checkId && !frontImagePath && !backImagePath && !backImageOriginalPath) return;
    setLoading(true);
    try {
      // AWS staging has no get-check-image-urls Edge Function; sign via Storage API.
      if (checkId && !isAwsStaging()) {
        const { data, error } = await supabase.functions.invoke("get-check-image-urls", {
          body: { checkId },
        });
        if (error) throw error;

        const front = (data as any)?.frontUrl ?? null;
        // Prefer the authoritative clean original back image when available.
        const back = (data as any)?.backOriginalUrl ?? (data as any)?.backUrl ?? null;

        if (!front && !back) {
          toast({
            title: "No images on file",
            description: "This check has no images stored.",
            variant: "destructive",
          });
          return;
        }

        setFrontUrl(front);
        setBackUrl(back);
        setOpen(true);
        return;
      }

      let fPath = frontImagePath ?? null;
      // Default viewer should show the clean back-of-check when we have it.
      // Deposit-ready artifacts are shown only in explicit deposit views.
      let bPath = backImageOriginalPath ?? backImagePath ?? null;

      if (!fPath && !bPath) {
        toast({
          title: "No images on file",
          description: "This check has no images stored.",
          variant: "destructive",
        });
        return;
      }

      const sign = async (p: string | null) => {
        const objectPath = toStorageObjectPath(p);
        if (!objectPath) return null;
        const { data, error } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(objectPath, 3600);
        if (error) throw error;
        return data?.signedUrl ?? null;
      };

      const [fUrl, bUrl] = await Promise.all([sign(fPath), sign(bPath)]);
      setFrontUrl(fUrl);
      setBackUrl(bUrl);
      setOpen(true);
    } catch (e: any) {
      toast({
        title: "Could not open images",
        description: e?.message ?? "Failed to load check images",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={loading || (!checkId && !frontImagePath && !backImagePath)}
        onClick={handleClick}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Eye className="h-3.5 w-3.5 mr-1.5" />
        )}
        {label}
      </Button>
      <CheckImagesViewer
        open={open}
        frontUrl={frontUrl}
        backUrl={backUrl}
        title={`Check${checkNumber ? ` #${checkNumber}` : ""}`}
        onClose={() => {
          setOpen(false);
          setFrontUrl(null);
          setBackUrl(null);
        }}
      />
    </>
  );
}
