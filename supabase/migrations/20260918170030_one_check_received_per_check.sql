-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Product invariant: one homeowner_ledger_events.check_received
-- per physical check (non-null check_id). The product never needs
-- more than one Funds Received event for the same check.
--
-- If duplicate identities exist: STOP. No data repair.
-- If the expected name exists with the wrong definition: STOP.

CREATE OR REPLACE FUNCTION public.check_received_index_matches(p_indexdef text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_indexdef IS NOT NULL
    AND lower(p_indexdef) ~ 'unique'
    AND lower(p_indexdef) ~ 'on (public\.)?homeowner_ledger_events'
    AND COALESCE(
      (regexp_match(
        lower(regexp_replace(p_indexdef, '\s+', ' ', 'g')),
        'on (?:public\.)?homeowner_ledger_events(?: using [\w.]+)? \(([^)]+)\)'
      ))[1],
      ''
    ) = 'check_id'
    AND regexp_replace(
      COALESCE(
        (regexp_match(
          lower(regexp_replace(p_indexdef, '\s+', ' ', 'g')),
          'where (.+)$'
        ))[1],
        ''
      ),
      '[() ]+',
      ' ',
      'g'
    ) ~ 'event_type = ''check_received'''
    AND regexp_replace(
      COALESCE(
        (regexp_match(
          lower(regexp_replace(p_indexdef, '\s+', ' ', 'g')),
          'where (.+)$'
        ))[1],
        ''
      ),
      '[() ]+',
      ' ',
      'g'
    ) ~ 'check_id is not null';
$$;

DO $$
DECLARE
  v_dupes integer := 0;
  v_indexdef text;
BEGIN
  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT check_id
    FROM public.homeowner_ledger_events
    WHERE event_type = 'check_received'
      AND check_id IS NOT NULL
    GROUP BY check_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'check_received_index_guard: % duplicate check_received group(s) exist; stop before apply — no data deleted',
      v_dupes;
  END IF;

  SELECT indexdef INTO v_indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_homeowner_ledger_one_check_received';

  IF v_indexdef IS NOT NULL AND NOT public.check_received_index_matches(v_indexdef) THEN
    RAISE EXCEPTION
      'check_received_index_guard: idx_homeowner_ledger_one_check_received exists but definition does not match UNIQUE(check_id) WHERE event_type = ''check_received'' AND check_id IS NOT NULL; live indexdef=%',
      v_indexdef;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_homeowner_ledger_one_check_received
  ON public.homeowner_ledger_events (check_id)
  WHERE event_type = 'check_received' AND check_id IS NOT NULL;
