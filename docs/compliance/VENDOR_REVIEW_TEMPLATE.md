# Vendor review template (row S-1)

**Owner:** the Qualified Individual (`docs/WISP.md` §1) — security@checksops.com
**Drafted:** 2026-11-09
**Matrix rows:** CC9.2 (vendor inventory, contracts and annual review), CC3.4 (risk from vendor
changes). **Risk register:** R8. **Evidence calendar:** row S-1, annually per vendor, next due
2026-12-31.

One record per vendor per year. The vendor list is `docs/compliance/SYSTEM_DESCRIPTION.md` §4
(subservice organizations, carve-out method) and `docs/WISP.md` §3.6. What to ask each vendor for,
and where, is in `docs/compliance/VENDOR_REQUESTS_2026.md`.

## Where filled records go

A filled record names the reviewer, quotes or summarizes a report that the vendor releases under
NDA, and describes contract terms. Under the evidence calendar's rule
(`docs/compliance/EVIDENCE_CALENDAR.md`, "Where records go"), it is **not stored in this
repository**:

- **The filled record, the vendor's report, the bridge letter and the signed contract, DPA or
  addendum** go to the restricted compliance folder (or the compliance tool, once one is chosen).
  Name the record `YYYY-MM-DD-S-1-<vendor>.md` (or `.pdf`) so it sorts with the other records.
- **In this repository**, add one line per vendor to the Log in `docs/compliance/EVIDENCE_CALENDAR.md`:
  date reviewed, row `S-1`, who (role, not name), and the vendor, the report type and period,
  "exceptions: none" or "exceptions: yes, see record", the decision, and where the record is
  stored. Never the report's content, the exception text, contract terms or anyone's name.
- If a review leads to a change in ChecksOps (a CUEC not met, a missing addendum, a new
  compensating control), open a PR or ticket for it and cite it in both the record and the log
  line.

## How to fill it in

1. Read the report's opinion and period first. A qualified or adverse opinion, a scope that does
   not include the service ChecksOps uses, or a period that ended more than 12 months ago is a
   finding on its own.
2. Read the report's section on complementary user entity controls (CUECs). Copy **every** CUEC
   into table 5, not only the ones that look relevant, and say how ChecksOps meets each one or
   why it does not apply. The suggested CUECs in `VENDOR_REQUESTS_2026.md` are a starting point;
   the report's own list governs.
3. Read the vendor's own carve-outs (its subservice organizations). If the vendor relies on
   another provider for something ChecksOps depends on (a cloud host, a sponsor bank), note it in
   section 4.
4. Read the testing results. Copy each exception with the auditor's description and the vendor's
   response into table 6, and decide its impact on ChecksOps.
5. Check the contract status (section 7) against what is on file, not against memory.
6. Decide (section 8) and sign (section 9).

If a vendor has no SOC report, use a security questionnaire (WISP §5) or another independent report
(ISO 27001 certificate with its statement of applicability, PCI DSS attestation of compliance) and
say in section 3 what was used instead and why it is enough.

---

## Record

### 1. Vendor

| Field | Value |
|---|---|
| Vendor (legal entity) | |
| Service used by ChecksOps | |
| Where ChecksOps calls it | (code paths, AWS secret names, consoles) |
| Review year | |
| Previous review | (date and record location, or "first review") |

### 2. Data shared and criticality

| Field | Value |
|---|---|
| Data sent to or held by the vendor | (from `docs/WISP.md` §3.6; update if it changed) |
| Customer data? Personal data? Bank or identity data? | |
| Criticality | High / Medium / Low |
| Why | (what stops, and for whom, if the vendor is breached or unavailable; see R8) |
| Fallback if unavailable | (e.g. `ops/status-notice.md`, manual process, none) |

Criticality guide: **High** if the vendor holds customer data or bank and identity data, or if its
outage stops money movement or sign-in. **Medium** if it holds limited personal data or its outage
stops a feature without losing data. **Low** if it holds no customer data.

### 3. Assurance report

| Field | Value |
|---|---|
| Report type | SOC 2 Type II / SOC 2 Type I / SOC 1 Type II / SOC 3 / ISO 27001 / questionnaire / other |
| Trust services criteria covered | (Security, Availability, Confidentiality, Processing Integrity, Privacy) |
| Period covered | (from – to) |
| Service auditor | (firm name) |
| Opinion | Unqualified / qualified / adverse / disclaimer |
| Services and regions in scope | (confirm the service ChecksOps uses is listed) |
| Date received, and how | (portal, account contact; NDA signed on) |
| Stored at | (restricted folder path) |

### 4. Bridge letter and vendor's own carve-outs

| Field | Value |
|---|---|
| Months between the report's period end and this review | |
| Bridge (gap) letter | Received, covering to (date) / requested on (date) / not needed (under 3 months) |
| Material changes the letter discloses | |
| Vendor's subservice organizations relevant to ChecksOps | (e.g. its cloud host, sponsor bank) and whether the report carves them out |

### 5. Complementary user entity controls (CUECs)

Every CUEC listed in the vendor's report, and how ChecksOps meets it.

| # | CUEC as written in the report | How ChecksOps meets it (control and evidence) | Met? |
|---|---|---|---|
| 1 | | | Yes / Partly / No / N/A (why) |
| 2 | | | |

Any "Partly" or "No" needs a follow-up in section 8 with an owner and a date.

### 6. Exceptions noted in the report

| # | Control and exception (as the auditor describes it) | Vendor's response | Impact on ChecksOps | Action |
|---|---|---|---|---|
| 1 | | | None / Low / Medium / High, and why | |

Write "None noted" if the report has no exceptions.

### 7. Contract, DPA and addendum

| Field | Value |
|---|---|
| Agreement in force | (name and date of the master or customer agreement, or online terms version) |
| Data processing addendum (DPA) | On file (date) / not on file / not offered |
| Security or GLBA addendum (WISP §3.6 "written addenda") | On file (date) / not on file |
| Breach notification commitment | (hours or days, and to whom) |
| Right to receive future SOC reports | Yes / No |
| Data return and deletion on termination | |
| Subprocessor list and change notice | |
| Stored at | (restricted folder path) |

### 8. Decision

| Field | Value |
|---|---|
| Decision | Continue / continue with follow-ups / replace / stop using |
| Follow-ups | (each with an owner, a target date and its PR or ticket) |
| Residual risk change for R8 | (none, or the new likelihood and impact) |
| Next review due | (12 months, or sooner if the bridge letter or a follow-up requires it) |

### 9. Sign-off

| Field | Value |
|---|---|
| Prepared by (role) | |
| Reviewed and approved by (role) | Qualified Individual |
| Date signed | |
| Signature | |
