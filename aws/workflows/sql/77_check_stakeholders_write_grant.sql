-- Let the API link an organization's own saved stakeholders to its own checks.
-- POST /data/write (write-check-workflow.mjs executeCheckStakeholders) inserts
-- and deletes public.check_stakeholders rows; the AWS restore granted SELECT only.
-- RLS (aws_write_check_stakeholders) and the API's own checks stay the boundary.
-- No UPDATE: a link is only added or removed.
GRANT SELECT, INSERT, DELETE ON TABLE public.check_stakeholders TO checksops, authenticated;
