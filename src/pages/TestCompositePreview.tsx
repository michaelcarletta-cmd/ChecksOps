import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function TestCompositePreview() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function getUrl() {
      const { data, error } = await supabase.storage
        .from("claim-files")
        .createSignedUrl("test/test-check-back_endorsed.svg", 600);
      if (error) setError(error.message);
      else setUrl(data.signedUrl);
    }
    getUrl();
  }, []);

  if (error) return <div className="p-8 text-red-500">Error: {error}</div>;
  if (!url) return <div className="p-8">Loading...</div>;

  return (
    <div className="min-h-screen bg-background p-4">
      <h1 className="text-xl font-bold text-foreground mb-4">Composite Endorsement Preview (Test)</h1>
      <div className="border border-border rounded-lg overflow-auto bg-white">
        <img src={url} alt="Composited check back" className="w-full" />
      </div>
    </div>
  );
}
