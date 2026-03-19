export type PaymentDirectionRequestStatus =
  | "pending"
  | "answered"
  | "expired"
  | "cancelled";

export type PaymentDirectionDecision =
  | "pay_contractor"
  | "pay_insured"
  | null;

export type PaymentDirectionAnswerSource =
  | "email"
  | "sms"
  | "portal"
  | "manual"
  | null;

export type DepositStatus =
  | "pending"
  | "deposited"
  | "cleared";

export type ClaimCheckRecord = {
  id: string;
  claim_id: string;
  amount?: number | null;
  check_number?: string | null;
  contractor_name?: string | null;
  endorsement_status: string | null;
  payment_direction_status: string | null;
  deposit_status: string | null;
  cleared_status: string | null;
};

export type CheckPaymentDirectionRecord = {
  id: string;
  claim_id: string;
  check_id: string;
  request_status: PaymentDirectionRequestStatus;
  decision: PaymentDirectionDecision;
  contractor_name?: string | null;
  requested_at: string;
  answered_at?: string | null;
  expires_at?: string | null;
  answer_source?: PaymentDirectionAnswerSource;
  answer_notes?: string | null;
  secure_token: string;
  created_at: string;
  updated_at: string;
};

export type ClaimDisbursementRecord = {
  id: string;
  claim_id: string;
  check_id: string;
  payment_direction_id?: string | null;
  recipient_type: "contractor" | "insured";
  recipient_name?: string | null;
  amount?: number | null;
  method: "manual" | "ach" | "check" | "wire";
  status: "draft" | "pending" | "sent" | "cleared" | "failed" | "cancelled";
  notes?: string | null;
  created_at: string;
  updated_at: string;
};
