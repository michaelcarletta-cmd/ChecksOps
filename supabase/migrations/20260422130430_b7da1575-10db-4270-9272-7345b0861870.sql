
CREATE OR REPLACE FUNCTION public.get_all_insurance_carriers()
RETURNS TABLE(carrier_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT insurance_company
  FROM claims
  WHERE insurance_company IS NOT NULL AND insurance_company != ''
  ORDER BY insurance_company;
$$;
