/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

export interface TemplateEntry {
  component: React.ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  to?: string
  displayName?: string
  previewData?: Record<string, any>
}

import { template as demoRequest } from './demo-request.tsx'
import { template as stakeholderVerifyAccount } from './stakeholder-verify-account.tsx'
import { template as tenantInvoice } from './tenant-invoice.tsx'
import { template as newHomeownerLead } from './new-homeowner-lead.tsx'
import { template as homeownerClaimPortalLink } from './homeowner-claim-portal-link.tsx'
import { template as homeownerLedgerInvite } from './homeowner-ledger-invite.tsx'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'demo-request': demoRequest,
  'stakeholder-verify-account': stakeholderVerifyAccount,
  'tenant-invoice': tenantInvoice,
  'new-homeowner-lead': newHomeownerLead,
  'homeowner-claim-portal-link': homeownerClaimPortalLink,
  'homeowner-ledger-invite': homeownerLedgerInvite,
}
