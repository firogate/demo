import { hmacHex, randomHex, stableStringify, uuid, nowIso } from './util.js';

const DAILY_LIMIT = 200;
const KEEP = 50;

export function webhookUrlAllowed(raw, selfHost = '') {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === selfHost || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || !h.includes('.')) return false;
  return true;
}

async function takeQuota(env, sb) {
  const day = new Date().toISOString().slice(0, 10);
  const res = await env.DB.prepare(`UPDATE sandboxes SET
      webhook_count = CASE WHEN webhook_day = ?1 THEN webhook_count + 1 ELSE 1 END,
      webhook_day = ?1
    WHERE id = ?2 AND (webhook_day IS NOT ?1 OR webhook_count < ?3)`)
    .bind(day, sb.id, DAILY_LIMIT).run();
  return res.meta.changes > 0;
}

async function log(env, sb, paymentId, event, result, body) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO webhook_log (id, sandbox_id, payment_id, event, status_code, ok, error, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uuid(), sb.id, paymentId || null, event, result.status_code ?? null, result.ok ? 1 : 0, result.error || null, body.slice(0, 4000), nowIso()),
    env.DB.prepare(`DELETE FROM webhook_log WHERE sandbox_id = ?1 AND id NOT IN
      (SELECT id FROM webhook_log WHERE sandbox_id = ?1 ORDER BY created_at DESC LIMIT ${KEEP})`).bind(sb.id),
  ]);
}

export async function sendWebhook(env, sb, event, base, paymentId = null) {
  if (!sb.webhook_url) return { ok: false, skipped: 'no_webhook' };
  const payload = { ...base, nonce: randomHex(16), timestamp: Math.floor(Date.now() / 1000) };
  const body = stableStringify(payload);
  if (!webhookUrlAllowed(sb.webhook_url)) {
    const r = { ok: false, error: 'Use a public https:// address.' };
    await log(env, sb, paymentId, event, r, body);
    return r;
  }
  if (!(await takeQuota(env, sb))) {
    const r = { ok: false, error: 'Daily webhook limit reached.' };
    await log(env, sb, paymentId, event, r, body);
    return r;
  }
  const signature = sb.webhook_secret ? await hmacHex(sb.webhook_secret, body) : '';
  let result;
  try {
    const res = await fetch(sb.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FiroGate-Event': event,
        'X-FiroGate-Signature': signature,
        'X-FiroGate-Nonce': payload.nonce,
        'X-FiroGate-Timestamp': String(payload.timestamp),
        'X-FiroGate-Demo': '1',
        'User-Agent': 'FiroGate-Demo/1.0',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
    result = { ok: res.status >= 200 && res.status < 300, status_code: res.status };
  } catch (e) {
    result = { ok: false, error: e && e.name === 'TimeoutError' ? 'No answer in 6 seconds.' : 'Could not reach the address.' };
  }
  await log(env, sb, paymentId, event, result, body);
  return result;
}
