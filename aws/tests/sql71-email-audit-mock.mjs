/**
 * Mock SQL 71 peek/reserve/finalize RPCs used by the canonical #255 mailer.
 * Lineage A tests that only stub INSERT INTO email_send_log must include this.
 */
export const sql71EmailAuditHandle = ({ logs = new Map(), failPeek = false, failReserve = false } = {}) => {
  const handle = (compact, params = []) => {
    const sql = String(compact || '');
    if (failPeek && sql.includes('aws_email_send_log_peek')) {
      return { rows: [{ doc: { ok: false, error: 'idempotency_unavailable' } }] };
    }
    if (sql.includes('aws_email_send_log_peek')) {
      const key = String(params[0] || '');
      return { rows: [{ doc: { ok: true, row: logs.get(key) || null } }] };
    }
    if (failReserve && sql.includes('aws_email_send_log_reserve')) {
      return { rows: [{ doc: { ok: false, error: 'idempotency_unavailable' } }] };
    }
    if (sql.includes('aws_email_send_log_reserve')) {
      const key = String(params[5] || '');
      if (key && logs.has(key)) {
        return {
          rows: [{
            doc: {
              ok: true,
              claimed: false,
              duplicate: true,
              row: logs.get(key),
            },
          }],
        };
      }
      const row = {
        id: params[0],
        status: 'pending',
        provider_message_id: null,
        recipient_email: params[2],
        tenant_id: params[3],
        template_name: params[1],
        idempotency_key: key,
        metadata: { claimed: true },
      };
      if (key) logs.set(key, row);
      return { rows: [{ doc: { ok: true, claimed: true, duplicate: false, id: params[0], row } }] };
    }
    if (sql.includes('aws_mark_endorsement_request_sent')) {
      return {
        rows: [{
          doc: {
            ok: true,
            status: 'sent',
            request_sent_at: '2026-09-12T17:00:00.000Z',
            token: params[2] || 'abc',
          },
        }],
      };
    }
    if (sql.includes('aws_email_send_log_finalize')) {
      const id = String(params[0]);
      let row = null;
      for (const existing of logs.values()) {
        if (String(existing.id) === id) {
          existing.status = params[1];
          existing.provider_message_id = params[2];
          existing.error_message = params[3];
          try {
            existing.metadata = typeof params[4] === 'string' ? JSON.parse(params[4]) : (params[4] || existing.metadata);
          } catch { /* keep */ }
          row = existing;
          break;
        }
      }
      if (!row) {
        row = {
          id,
          status: params[1],
          provider_message_id: params[2],
          error_message: params[3],
        };
      }
      if (row.idempotency_key) logs.set(row.idempotency_key, row);
      return { rows: [{ doc: { ok: true, row } }] };
    }
    return null;
  };
  return handle;
};
