import { useEffect, useState } from "react";

type DepositImageViewerProps = {
  open: boolean;
  imageUrl: string | null;
  title?: string;
  onClose: () => void;
};

export function DepositImageViewer({
  open,
  imageUrl,
  title = "Mobile Deposit View",
  onClose,
}: DepositImageViewerProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) {
      setZoom(1);
    }
  }, [open]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) {
      window.addEventListener("keydown", onKeyDown);
    }
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="text-sm font-medium">{title}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
          >
            Zoom Out
          </button>
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
            onClick={() => setZoom(1)}
          >
            Reset
          </button>
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
            onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
          >
            Zoom In
          </button>
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-auto p-6">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Final mobile deposit image"
            className="max-w-full max-h-full object-contain select-none"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "center center",
            }}
          />
        ) : (
          <div className="text-sm text-white/70">
            No deposit image available.
          </div>
        )}
      </div>
    </div>
  );
}
