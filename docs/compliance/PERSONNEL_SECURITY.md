# Personnel and endpoint security policy

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Effective:** 2026-11-06 • Matrix rows CC1.4, CC1.5, CC6.2 in `docs/compliance/SOC2_CONTROL_MATRIX.md`

Applies to employees, contractors and anyone else given access to ChecksOps systems or customer
data ("personnel"). Records with names go in the compliance records outside this repository; the
evidence calendar logs only the date and where each record is kept.

## 1. Before access

1. **Background check** for anyone who will have access to production or customer data, before
   access is granted, to the extent the law allows.
2. **Confidentiality agreement** signed before access.
3. **Acknowledgment** of the WISP and this policy, signed before access.

## 2. Access

1. Access is requested in writing and approved by the Qualified Individual, with the least access
   the role needs.
2. Every person has their own named accounts. Shared logins are not allowed. The AWS root account is
   for break-glass use only.
3. Production AWS access requires MFA.
4. Access is reviewed quarterly (evidence calendar row A-1).

## 3. Training

1. Security and privacy training at onboarding and every year (row T-1).
2. Phishing simulation twice a year (row T-2).
3. People who handle ACH or deposits also take the training required by
   `docs/ACH_RISK_FRAUD_MONITORING.md` and `docs/AML_PROGRAM.md`.

## 4. Endpoints

Every laptop or desktop used to reach ChecksOps systems must have:

1. full-disk encryption on;
2. a screen lock of 10 minutes or less;
3. automatic operating system and browser updates;
4. the operating system's built-in malware protection on;
5. no customer data stored locally except while actively working on it.

**OWNER TO CONFIRM** how this is checked (a device-management tool, or a signed self-attestation
recorded quarterly with the access review).

## 5. Leaving

1. All access (application, Cognito, AWS IAM, GitHub, email, vendor consoles) removed within
   24 hours of the last day, or immediately on involuntary departure (row A-2).
2. Company devices returned or wiped.
3. Any shared secret the person could see is rotated.

## 6. Violations

Violations of this policy may lead to loss of access and disciplinary action up to termination.
