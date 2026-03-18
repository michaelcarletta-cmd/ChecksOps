
alter table public.claim_roof_measurements
  add column if not exists suggested_roof_polygon_geojson jsonb,
  add column if not exists suggested_roof_polygon_source text,
  add column if not exists suggested_roof_polygon_confidence numeric,
  add column if not exists suggested_roof_outline_notes text,
  add column if not exists user_drawn_planar_area_sqft integer,
  add column if not exists user_drawn_roof_area_sqft integer,
  add column if not exists user_drawn_squares numeric,
  add column if not exists user_drawn_at timestamptz,
  add column if not exists user_drawn_by uuid,
  add column if not exists roof_mass_count integer,
  add column if not exists roof_mass_polygons jsonb,
  add column if not exists imagery_analysis jsonb,
  add column if not exists calibration_adjustment_factor numeric;

create table if not exists public.claim_roof_outline_edits (
  id uuid primary key default gen_random_uuid(),
  roof_measurement_id uuid not null references public.claim_roof_measurements(id) on delete cascade,
  prior_polygon_geojson jsonb,
  new_polygon_geojson jsonb,
  prior_planar_area_sqft integer,
  new_planar_area_sqft integer,
  edit_source text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.claim_roof_outline_edits enable row level security;

create policy "Staff can manage roof outline edits" on public.claim_roof_outline_edits
  for all to authenticated
  using (true)
  with check (true);
