/**
 * Shared domain types for the Check Command Center.
 * Extracted from CheckCommandCenter.tsx (Phase 3 architecture split).
 */

export interface CheckPayee {
  id: string;
  check_id: string;
  payee_name: string;
  payee_type: string;
  endorsement_status: string;
  contact_email: string | null;
  contact_phone: string | null; // SMS removed from endorsements
  notification_sent_via: string | null;
  notification_sent_at: string | null;
  endorsed_at: string | null;
}

export interface CheckAltDepositSummary {
  id: string;
  status: string | null;
  checkalt_reference?: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  updated_at: string | null;
  last_status_payload?: Record<string, unknown> | null;
  status_unresolved?: boolean | null;
  provider_http_attempted_at?: string | null;
  failure_class?: string | null;
}

export interface CheckItem {
  id: string;
  claim_id: string | null;
  front_image_path: string;
  back_image_path: string | null;
  back_image_deposit_path?: string | null;
  carrier_name: string | null;
  check_number: string | null;
  amount: number | null;
  issue_date: string | null;
  expiration_days: number | null;
  detected_claim_number: string | null;
  payee_line: string | null;
  is_multi_payee: boolean;
  ocr_status: string;
  deposit_recommendation: string | null;
  deposit_recommendation_reasons: string[] | null;
  status: string;
  created_at: string;
  uploaded_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  endorsement_packet_path: string | null;
  endorsement_override: Record<string, unknown> | null;
  funds_type?: string | null;
  property_address?: string | null;
  payment_classification?: string | null;
  payee_address?: string | null;
  deposited_at?: string | null;
  deposited_by_tenant_id?: string | null;
  check_stage?: string | null;
  updated_at?: string | null;
  check_payees?: CheckPayee[];
  checkalt_deposits?: CheckAltDepositSummary[];
  partner_status?: string | null;
  partner_status_label?: string | null;
  partner_status_updated_at?: string | null;
  external_origin?: Record<string, unknown> | null;
  check_source?: string | null;
  cash_job_id?: string | null;
  cash_job_payment_class?: string | null;
}

export interface CheckEndorsementSummary {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signature_image_url?: string | null;
  signature_method?: string | null;
  signed_at: string | null;
  created_at?: string;
}

export interface AuditEntry {
  id: string;
  event_type: string;
  event_description: string | null;
  event_data: Record<string, unknown> | null;
  created_at: string;
  actor_id: string | null;
}

export interface ClaimOption {
  id: string;
  claim_number: string | null;
  policyholder_name: string | null;
}

export interface CheckGroup {
  key: string;
  claimNumber: string;
  policyholderName: string;
  checks: CheckItem[];
  totalAmount: number;
  latestCreatedAt: string;
}
