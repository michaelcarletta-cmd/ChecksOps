
-- Add is_manual flag to claim_events for user-created timeline entries
ALTER TABLE public.claim_events ADD COLUMN IF NOT EXISTS is_manual boolean DEFAULT false;
ALTER TABLE public.claim_events ADD COLUMN IF NOT EXISTS is_editable boolean DEFAULT false;

-- Estimate builder line items table
CREATE TABLE public.darwin_estimate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'General',
  trade text,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text DEFAULT 'EA',
  unit_price numeric NOT NULL DEFAULT 0,
  rcv_total numeric GENERATED ALWAYS AS (quantity * unit_price) STORED,
  depreciation_pct numeric DEFAULT 0,
  depreciation_amount numeric GENERATED ALWAYS AS (quantity * unit_price * COALESCE(depreciation_pct, 0) / 100) STORED,
  acv_total numeric GENERATED ALWAYS AS (quantity * unit_price * (1 - COALESCE(depreciation_pct, 0) / 100)) STORED,
  include_overhead boolean DEFAULT false,
  include_profit boolean DEFAULT false,
  overhead_pct numeric DEFAULT 10,
  profit_pct numeric DEFAULT 10,
  source text DEFAULT 'manual',
  source_analysis_id uuid,
  is_suggested boolean DEFAULT false,
  is_accepted boolean DEFAULT true,
  code_reference text,
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.darwin_estimate_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage estimate lines"
  ON public.darwin_estimate_lines
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_darwin_estimate_lines_claim ON public.darwin_estimate_lines(claim_id);
