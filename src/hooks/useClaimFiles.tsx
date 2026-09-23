import { useState, useEffect } from "react";
import { supabase } from "@/integrations/aws/client";

export interface ClaimFileOption {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  folder_id: string | null;
  folder_name?: string;
  uploaded_at: string | null;
}

export const useClaimFiles = (claimId: string, filterPdf: boolean = true) => {
  const [files, setFiles] = useState<ClaimFileOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFiles = async () => {
      setLoading(true);
      try {
        // Fetch folders first
        const { data: foldersData } = await supabase
          .from('claim_folders')
          .select('id, name')
          .eq('claim_id', claimId);

        const folderMap = new Map(foldersData?.map(f => [f.id, f.name]) || []);

        // Fetch files
        const { data: filesData } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, file_type, folder_id, uploaded_at')
          .eq('claim_id', claimId)
          .order('uploaded_at', { ascending: false });

        let result = (filesData || []).map(f => ({
          ...f,
          folder_name: f.folder_id ? folderMap.get(f.folder_id) : undefined
        }));

        // Filter to PDFs only if requested
        if (filterPdf) {
          result = result.filter(f => 
            f.file_name?.toLowerCase().endsWith('.pdf')
          );
        }

        setFiles(result);
      } catch (error) {
        console.error('Error fetching claim files:', error);
      } finally {
        setLoading(false);
      }
    };

    if (claimId) {
      fetchFiles();
    }
  }, [claimId, filterPdf]);

  const downloadFileAsBase64 = async (filePath: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase.storage
        .from('claim-files')
        .download(filePath);

      if (error || !data) return null;

      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(data);
      });
    } catch (error) {
      console.error('Error downloading file:', error);
      return null;
    }
  };

  return { files, loading, downloadFileAsBase64 };
};
