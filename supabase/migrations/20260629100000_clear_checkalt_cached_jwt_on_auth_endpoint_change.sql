-- PR switching authenticateCheckAlt() from /public/jwtauth/authenticate to
-- /public/fincapture/authenticate means any cached_jwt already sitting in
-- checkalt_config was minted by the old login service. getCheckAltJwt()
-- returns that cached token without re-authenticating until it expires, so
-- callers would keep using a token from the old endpoint for up to its
-- remaining ~50 minute window after this deploy. Clear it so the next call
-- is forced through the new endpoint immediately.
UPDATE public.checkalt_config
SET cached_jwt = NULL, cached_jwt_expires_at = NULL
WHERE singleton = true;
