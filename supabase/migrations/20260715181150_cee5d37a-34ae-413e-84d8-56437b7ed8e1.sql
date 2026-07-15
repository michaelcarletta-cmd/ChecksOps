
CREATE OR REPLACE FUNCTION public.prevent_mortgage_agent_role_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  conflicting_role text;
BEGIN
  IF NEW.role = 'mortgage_agent'::app_role THEN
    SELECT role::text INTO conflicting_role
    FROM public.user_roles
    WHERE user_id = NEW.user_id
      AND role IN ('staff'::app_role, 'admin'::app_role)
    LIMIT 1;
    IF conflicting_role IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot assign mortgage_agent role: user already has % role. Mortgage agents must not have staff or admin roles or per-task access scoping is bypassed.', conflicting_role
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.role IN ('staff'::app_role, 'admin'::app_role) THEN
    IF EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = NEW.user_id AND role = 'mortgage_agent'::app_role
    ) THEN
      RAISE EXCEPTION 'Cannot assign % role: user has mortgage_agent role. Remove mortgage_agent first, or use a different user account.', NEW.role
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_mortgage_agent_role_conflict ON public.user_roles;
CREATE TRIGGER trg_prevent_mortgage_agent_role_conflict
BEFORE INSERT OR UPDATE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_mortgage_agent_role_conflict();
