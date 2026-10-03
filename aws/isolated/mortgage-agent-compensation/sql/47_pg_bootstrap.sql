CREATE ROLE checksops;
CREATE ROLE authenticated;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS public;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text,
  slug text
);

CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  check_intake_item_id uuid,
  claim_id uuid,
  mortgage_company text,
  loan_number text,
  status text NOT NULL DEFAULT 'requested',
  assigned_employee_id uuid,
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  work_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  check_intake_item_id uuid,
  claim_id uuid,
  mortgage_request_id uuid,
  event_type text NOT NULL,
  unit_price_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'recorded',
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('request.is_platform_owner', true), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.is_platform_owner()
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid
$$;
