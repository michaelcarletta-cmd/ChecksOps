import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface Props {
  homeowner_name?: string
  portal_url?: string
  is_pre_claim?: boolean
}

const Email = ({ homeowner_name, portal_url, is_pre_claim }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {is_pre_claim
        ? 'Send us your insurance check to start your claim'
        : 'View your claim ledger — every dollar and milestone'}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="320" style={{ display: 'block', height: 'auto' }} />
        </Section>
        <Heading style={h1}>
          {is_pre_claim ? 'Send us your insurance check' : 'Your claim ledger is ready'}
        </Heading>
        <Text style={text}>
          Hi {homeowner_name || 'there'} — {is_pre_claim
            ? 'use the secure link below to upload the front and back of your insurance check. Our team will attach it to your claim as soon as it arrives.'
            : `we've set up a private page for you. You can see every check we've received, every endorsement, every deposit, and every dollar released — updated live as things happen.`}
        </Text>

        {portal_url ? (
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button href={portal_url} style={button}>
              {is_pre_claim ? 'Upload my check' : 'Open my ledger'}
            </Button>
          </Section>
        ) : null}

        <Section style={card}>
          <Text style={row}><strong>Bookmark this email.</strong> Anyone with this link can view
          your ledger, so please don't forward it.</Text>
        </Section>

        <Hr style={hr} />
        <Text style={footer}>
          You're receiving this because your claim team invited you to view your {SITE_NAME} ledger.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, any>) =>
    d?.is_pre_claim
      ? 'Send us your insurance check'
      : 'Your ChecksOps claim ledger',
  displayName: 'Homeowner ledger invite',
  previewData: {
    homeowner_name: 'Alex',
    portal_url: 'https://checksops.com/ledger/example-token',
    is_pre_claim: false,
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px', maxWidth: '560px' }
const logoSection = { padding: '0 0 16px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 16px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 12px' }
const card = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px',
  margin: '16px 0',
}
const row = { fontSize: '13px', color: '#0f172a', margin: '0' }
const button = {
  backgroundColor: '#0f172a',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
}
const hr = { borderColor: '#e2e8f0', margin: '24px 0' }
const footer = { fontSize: '12px', color: '#64748b', margin: '0' }
