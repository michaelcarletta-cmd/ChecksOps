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

export const TEMPLATES: Record<string, TemplateEntry> = {
  'demo-request': demoRequest,
  'stakeholder-verify-account': stakeholderVerifyAccount,
  'tenant-invoice': tenantInvoice,
}
