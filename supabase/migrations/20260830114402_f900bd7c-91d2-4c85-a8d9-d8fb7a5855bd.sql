CREATE TABLE IF NOT EXISTS public.platform_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  message text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  refresh_instructions text,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_announcements_severity_check CHECK (severity IN ('info','maintenance','critical'))
);

CREATE INDEX IF NOT EXISTS platform_announcements_active_idx ON public.platform_announcements (is_active, starts_at DESC);

GRANT SELECT ON public.platform_announcements TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_announcements TO authenticated;
GRANT ALL ON public.platform_announcements TO service_role;

ALTER TABLE public.platform_announcements ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(coalesce((SELECT email FROM auth.users WHERE id = auth.uid()), '')) = 'checksopsadmin@gmail.com'
$$;

DROP POLICY IF EXISTS "Anyone can read active announcements" ON public.platform_announcements;
CREATE POLICY "Anyone can read active announcements"
ON public.platform_announcements FOR SELECT
TO anon, authenticated
USING (is_active = true);

DROP POLICY IF EXISTS "Platform owner manages announcements" ON public.platform_announcements;
CREATE POLICY "Platform owner manages announcements"
ON public.platform_announcements FOR ALL
TO authenticated
USING (public.is_platform_owner())
WITH CHECK (public.is_platform_owner());

CREATE TRIGGER update_platform_announcements_updated_at
BEFORE UPDATE ON public.platform_announcements
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();