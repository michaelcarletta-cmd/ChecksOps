ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS actum_environment TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS actum_test_parent_id TEXT,
  ADD COLUMN IF NOT EXISTS actum_test_sub_id_ppd TEXT,
  ADD COLUMN IF NOT EXISTS actum_test_sub_id_ccd TEXT,
  ADD COLUMN IF NOT EXISTS actum_test_syspass TEXT,
  ADD COLUMN IF NOT EXISTS actum_test_username TEXT,
  ADD COLUMN IF NOT EXISTS actum_test_password TEXT;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_actum_environment_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_actum_environment_check CHECK (actum_environment IN ('test','production'));