
-- Table to store 4-digit PINs for client portal login
CREATE TABLE public.client_portal_pins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pin TEXT NOT NULL,
  client_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT pin_format CHECK (pin ~ '^\d{4}$'),
  UNIQUE(pin)
);

-- Enable RLS
ALTER TABLE public.client_portal_pins ENABLE ROW LEVEL SECURITY;

-- Only admins/staff can manage PINs
CREATE POLICY "Staff and admins can manage PINs"
ON public.client_portal_pins
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
);

-- Users can read their own PIN
CREATE POLICY "Users can read own PIN"
ON public.client_portal_pins
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_client_portal_pins_updated_at
BEFORE UPDATE ON public.client_portal_pins
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
