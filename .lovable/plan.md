# Implementation: Usage Log & Team Caps

## 1. Backend: Usage Logging & Team Management
- **Database Schema**:
  - New table `tenant_usage_logs` for tracking billing events (checks, payments, OCR).
  - New columns in `tenants`: `vendor_cap`, `sales_rep_cap`, `subcontractor_cap` (default 5).
- **Automation**:
  - Triggers on `claim_checks`, `moov_invoices`, and `check_intake_items` to automatically populate the usage log.
  - RPC/Function `check_team_member_cap` to enforce limits.

## 2. Frontend: Usage Visibility
- **Usage Log Tab**: Added a new "Usage Log" tab to the **Payments** page.
  - Monthly filtering (last 12 months).
  - List of usage events with types (Check Processing, OCR, Invoice Payment, etc.).
  - Summary tiles for monthly total cents and event count.

## 3. Frontend: Cap Configuration
- **Branding & Identity**: Added "Team Caps" section to **Company Settings**.
  - Tenants can configure their own caps for Vendors, Sales Reps, and Subcontractors.
  - Real-time updates to the tenant configuration.

## 4. Design Integration
- Harmonized with **WalletOps** design: gradient heroes, SectionCard components, and semantic icons.
