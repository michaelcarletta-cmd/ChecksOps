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
  document_name?: string
  document_url?: string
  note?: string
  sender_name?: string
}

const Email = ({ homeowner_name, portal_url, document_name, document_url, note, sender_name }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`A new document was shared with you: ${document_name || 'document'}`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="180" style={{ display: 'block', height: 'auto' }} />
        </Section>
        <Heading style={h1}>A new document was shared with you</Heading>
        <Text style={text}>
          Hi {homeowner_name || 'there'} — {sender_name || 'your claim team'} shared a document with you:
        </Text>
        <Section style={card}>
          <Text style={{ ...row, fontWeight: 'bold' }}>{document_name || 'Document'}</Text>
          {note ? <Text style={{ ...row, marginTop: 8 }}>{note}</Text> : null}
        </Section>

        {document_url ? (
          <Section style={{ textAlign: 'center', margin: '20px 0' }}>
            <Button href={document_url} style={button}>Open document</Button>
          </Section>
        ) : null}

        {portal_url ? (
          <Text style={text}>
            You can also open it any time from your claim portal:{' '}
            <a href={portal_url} style={{ color: '#0f172a' }}>{portal_url}</a>
          </Text>
        ) : null}

        <Hr style={hr} />
        <Text style={footer}>Sent securely by {SITE_NAME}.</Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, any>) =>
    d?.document_name ? `New document: ${d.document_name}` : 'A new document was shared with you',
  displayName: 'Homeowner document shared',
  previewData: {
    homeowner_name: 'Alex',
    document_name: 'Third Party Authorization.pdf',
    portal_url: 'https://checksops.com/ledger/example-token',
    document_url: 'https://example.com/doc.pdf',
    note: 'Please review at your convenience.',
    sender_name: 'Freedom Adjusters',
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
