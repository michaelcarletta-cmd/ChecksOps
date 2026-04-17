-- 1ESX roof report orders linked to claims
CREATE TABLE IF NOT EXISTS public.onesx_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  onesx_order_id text UNIQUE,
  status text NOT NULL DEFAULT 'submitting',
  report_types text[] NOT NULL DEFAULT '{}',
  address text,
  latitude numeric,
  longitude numeric,
  number_of_facets integer,
  primary_pitch text,
  secondary_pitch text,
  expedited_delivery boolean NOT NULL DEFAULT false,
  notes text,
  total numeric,
  payment_status text,
  payment_message text,
  meta_data jsonb NOT NULL DEFAULT '{}',
  request_payload jsonb,
  response_payload jsonb,
  callback_payload jsonb,
  report_files jsonb NOT NULL DEFAULT '[]',
  last_status_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_onesx_orders_claim ON public.onesx_orders(claim_id);
CREATE INDEX IF NOT EXISTS idx_onesx_orders_status ON public.onesx_orders(status);
CREATE INDEX IF NOT EXISTS idx_onesx_orders_onesx_id ON public.onesx_orders(onesx_order_id);

ALTER TABLE public.onesx_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view 1esx orders" ON public.onesx_orders;
CREATE POLICY "Admins can view 1esx orders"
  ON public.onesx_orders FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can create 1esx orders" ON public.onesx_orders;
CREATE POLICY "Admins can create 1esx orders"
  ON public.onesx_orders FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can update 1esx orders" ON public.onesx_orders;
CREATE POLICY "Admins can update 1esx orders"
  ON public.onesx_orders FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can delete 1esx orders" ON public.onesx_orders;
CREATE POLICY "Admins can delete 1esx orders"
  ON public.onesx_orders FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- updated_at trigger (uses existing helper function)
DROP TRIGGER IF EXISTS trg_onesx_orders_updated_at ON public.onesx_orders;
CREATE TRIGGER trg_onesx_orders_updated_at
  BEFORE UPDATE ON public.onesx_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();