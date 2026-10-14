-- READ-ONLY review query. Not a migration; changes nothing.
--
-- Lists live tenant_partnerships rows (status = 'active' AND revoked_at IS
-- NULL) whose activation cannot be attributed to the invitee side, for the
-- owner to review before or after applying SQL 76.
--
-- The table has no accepted_by column. The only evidence is created_by (the
-- user who inserted the row), accepted_at, and whether invite_code is the
-- invitee's own Partner Code (current tenants.partner_code or an alias).
-- aws_connect_partner_by_code inserts with inviter = redeemer and
-- created_by = redeemer, and on reactivation keeps the original created_by.
--
-- consent_evidence:
--   invitee_member_created      created_by is a tenant_users member of the invitee
--   invitee_partner_code        created_by is on the inviter side, invite_code is
--                               the invitee's Partner Code (consent = code possession)
--   inviter_only_code_mismatch  created_by is on the inviter side and invite_code is
--                               NOT the invitee's Partner Code (direct/legacy insert)
--   unattributable              created_by is in neither tenant or is NULL
-- Rows other than invitee_member_created are returned; invitee_partner_code
-- rows are the expected product behavior, the rest need a decision.

WITH live AS (
  SELECT p.*
  FROM public.tenant_partnerships p
  WHERE p.status = 'active'
    AND p.revoked_at IS NULL
),
classified AS (
  SELECT
    l.id AS partnership_id,
    l.inviter_tenant_id,
    ti.name AS inviter_name,
    l.invitee_tenant_id,
    te.name AS invitee_name,
    l.created_by,
    l.created_at,
    l.accepted_at,
    l.invite_code,
    EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.user_id = l.created_by AND tu.tenant_id = l.inviter_tenant_id
    ) AS created_by_in_inviter,
    EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.user_id = l.created_by AND tu.tenant_id = l.invitee_tenant_id
    ) AS created_by_in_invitee,
    (
      upper(l.invite_code) = upper(coalesce(te.partner_code, ''))
      OR EXISTS (
        SELECT 1 FROM public.tenant_partner_code_aliases a
        WHERE a.tenant_id = l.invitee_tenant_id
          AND upper(a.code) = upper(l.invite_code)
      )
    ) AS invite_code_is_invitee_code
  FROM live l
  LEFT JOIN public.tenants ti ON ti.id = l.inviter_tenant_id
  LEFT JOIN public.tenants te ON te.id = l.invitee_tenant_id
)
SELECT
  c.*,
  CASE
    WHEN c.created_by_in_invitee THEN 'invitee_member_created'
    WHEN c.created_by_in_inviter AND c.invite_code_is_invitee_code THEN 'invitee_partner_code'
    WHEN c.created_by_in_inviter THEN 'inviter_only_code_mismatch'
    ELSE 'unattributable'
  END AS consent_evidence,
  c.accepted_at IS NULL AS accepted_at_missing
FROM classified c
WHERE NOT c.created_by_in_invitee
ORDER BY
  CASE
    WHEN c.created_by_in_inviter AND c.invite_code_is_invitee_code THEN 2
    ELSE 1
  END,
  c.created_at;
