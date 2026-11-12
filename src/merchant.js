import {
  fail, json, noContent, nowIso, uuid, randomHex, randomString, sha256Hex, sanitize, validateAmount, validateUrl,
  readJson, round8,
} from './util.js';
import { advanceMany, expireAll, newPayment, checkoutToken, refundTotals } from './payments.js';
import { PRESETS, SAFE_FONTS, SAFE_BUTTON_STYLES, DEFAULT_THEME_ID, validateThemeInput, resolveTheme, themeFromSandbox, themeSettings } from './themes.js';
import { checkScope, isDemoSparkKey, isDemoXpub, fakeTransparentAddress } from './sandbox.js';
import { sendWebhook, webhookUrlAllowed } from './webhook.js';
import { THUMBNAILS } from './generated.js';

const NOT_IN_DEMO = 'Not available in the demo.';

async function totals(env, sb) {
  const since = sb.analytics_reset_at || '0000';
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_firo),0) AS g, COALESCE(SUM(COALESCE(amount_received, amount_firo)),0) AS r
    FROM payments WHERE sandbox_id = ? AND status = 'confirmed' AND confirmed_at >= ?`).bind(sb.id, since).first();
  return { count: row.c, gross: round8(row.g), received: round8(row.r) };
}

async function update(env, sb, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE sandboxes SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => fields[k]), sb.id).run();
  Object.assign(sb, fields);
}

export const account = {
  async me({ env, sb }) {
    const t = await totals(env, sb);
    return json({
      id: sb.id, username: sb.username, email: null, email_verified: false, full_name: null, role: 'merchant', is_operator: false,
      plan: 'free', requests_total: 0, requests_used: 0, requests_left: 0,
      lifetime_gross_sales_firo: t.gross, lifetime_received_firo: t.received, lifetime_confirmed_payments: t.count,
      plan_expires_at: null, api_key: null, webhook_url: sb.webhook_url, has_2fa: false,
    });
  },

  async profile({ env, sb }) {
    const t = await totals(env, sb);
    return json({
      id: sb.id, username: sb.username, email: null, auth_provider: 'password', app_name: sb.app_name,
      app_name_locked: false, app_name_change_allowed: false, plan: 'free',
      requests_total: 0, requests_used: 0, requests_left: 0, rollover_requests: 0, rollover_expires_at: null, cycle_start_at: null, monthly_allowance: 0,
      lifetime_gross_sales_firo: t.gross, lifetime_received_firo: t.received, lifetime_confirmed_payments: t.count, lifetime_completed_orders: t.count,
      plan_expires_at: null, api_key: null, webhook_url: sb.webhook_url, has_webhook_secret: !!sb.webhook_secret,
      required_confirmations_policy: sb.required_confirmations_policy, payment_tolerance_firo: null, totp_enabled: false,
      role: 'merchant', is_operator: false, privacy_mode: false, created_via_onion: false, is_onion_session: false,
      show_market_price: !!sb.show_market_price, has_seen_onboarding: !!sb.has_seen_onboarding,
      is_testnet: false, network: 'mainnet', network_label: 'Demo', network_warning: null,
    });
  },

  async onboardingSeen({ env, sb }) { await update(env, sb, { has_seen_onboarding: 1 }); return json({ ok: true }); },
  async onboardingRestart({ env, sb }) { await update(env, sb, { has_seen_onboarding: 0 }); return json({ ok: true }); },

  async webhookSecret({ sb }) { return json({ secret: sb.webhook_secret || null }); },
  async accountNumber() { return json({ account_number: null }); },

  async setWebhook({ env, request, url, sb }) {
    const b = await readJson(request);
    let v = validateUrl(b.webhook_url, 'Webhook URL');
    if (v && !webhookUrlAllowed(v, url.hostname)) fail(422, 'Use a public https:// address.');
    await update(env, sb, { webhook_url: v });
    return json({ message: v ? 'Webhook URL saved.' : 'Webhook URL cleared.', webhook_url: v });
  },

  async paymentPolicy({ env, request, sb }) {
    const b = await readJson(request);
    const v = b.required_confirmations_policy;
    if (v !== null && v !== undefined && ![0, 1, 3, 6].includes(v)) fail(422, 'required_confirmations_policy must be one of 0, 1, 3, 6');
    await update(env, sb, { required_confirmations_policy: v ?? null });
    return json({ message: 'Payment policy updated', required_confirmations_policy: v ?? null, payment_tolerance_firo: null });
  },

  async regenerateSecret({ env, sb }) {
    const secret = 'whsec_' + randomHex(24);
    await update(env, sb, { webhook_secret: secret });
    return json({ webhook_secret: secret, message: "Save this secret it won't be shown again." });
  },

  async regenerateApiKey() { fail(410, 'Use API keys in Developers instead.'); },

  async passwordStatus() {
    return json({ has_password: true, has_firebase: false, is_account_number: false, password_changed_at: null });
  },
  async changePassword() { fail(403, 'The demo has no password. It signs you in with one tap.'); },

  async sales({ env, ctx, url, sb }) {
    const t = await totals(env, sb);
    const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE sandbox_id = ?').bind(sb.id).first('n');
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const rows = (await env.DB.prepare("SELECT * FROM payments WHERE sandbox_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT ?").bind(sb.id, limit).all()).results;
    return json({
      metrics: {
        total_confirmed_payments: t.count, total_completed_orders: t.count, gross_sales_firo: t.gross, received_firo: t.received,
        avg_order_value: t.count ? round8(t.gross / t.count) : 0,
        payment_success_rate_pct: all ? Math.round(t.count / all * 1000) / 10 : 0,
      },
      sales: rows.map(p => ({ payment_id: p.id, order_id: p.order_id, amount_firo: p.amount_firo, amount_received: p.amount_received, txid: p.txid, confirmed_at: p.confirmed_at })),
    });
  },

  async privacyStatus() { return json({ privacy_mode: false, is_onion_session: false, created_via_onion: false }); },

  async marketPrice({ env, request, sb }) {
    const b = await readJson(request);
    await update(env, sb, { show_market_price: b.show_market_price ? 1 : 0 });
    return json({ show_market_price: !!b.show_market_price });
  },

  async telegramStatus() {
    return json({ configured: false, bot_username: null, connected: false, notify_telegram: false, notify_on_payment: false });
  },
  async telegramConnect() { fail(503, NOT_IN_DEMO); },
  async telegramNotify() { fail(400, NOT_IN_DEMO); },

  async getAppName({ sb }) {
    const used = sb.app_name_change_count || 0;
    return json({
      app_name: sb.app_name || null, has_app_name: !!sb.app_name, can_set_now: true, changes_used: used,
      free_changes: 99, free_remaining: 99, cooldown_seconds: 0, cooldown_days: 0,
    });
  },

  async setAppName({ env, request, sb }) {
    const b = await readJson(request);
    let name = sanitize(b.app_name, 40) || '';
    name = name.replace(/<[^>]+>/g, '').replace(/[<>&"'\\/]/g, '').replace(/javascript:|data:|vbscript:/gi, '').trim();
    if (!/^[A-Za-z0-9 ._\-&'()]{2,40}$/.test(name)) fail(422, "App name must be 2–40 characters: letters, numbers, spaces and ._-&'() only.");
    await update(env, sb, { app_name: name, app_name_change_count: (sb.app_name_change_count || 0) + 1, app_name_last_changed_at: nowIso() });
    return json({ app_name: name, message: 'App name saved.' });
  },

  async getLogo({ sb }) { return json({ app_logo: sb.app_logo || null, has_logo: !!sb.app_logo }); },
  async setLogo({ env, request, sb }) {
    const b = await readJson(request);
    const v = String(b.logo || '').trim();
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 200000) fail(422, 'Logo must be a PNG, JPG or WebP under 150 KB.');
    await update(env, sb, { app_logo: v });
    return json({ app_logo: v, message: 'Logo saved.' });
  },
  async deleteLogo({ env, sb }) { await update(env, sb, { app_logo: null }); return json({ message: 'Logo removed.' }); },

  async testWebhook({ env, url, sb }) {
    if (!sb.webhook_url) fail(400, 'No webhook URL configured. Set one first.');
    if (!webhookUrlAllowed(sb.webhook_url, url.hostname)) return json({ ok: false, message: 'Use a public https:// address.' });
    const r = await sendWebhook(env, sb, 'test', {
      event: 'test', payment_id: 'test-00000000-0000-0000-0000-000000000000', status: 'test', amount: 0,
      message: 'FiroGate webhook test your endpoint is working.',
    });
    if (r.status_code) return json({ ok: r.ok, status_code: r.status_code, message: `Test delivered HTTP ${r.status_code}` });
    return json({ ok: false, message: r.error || 'Delivery failed' });
  },

  async reportsMine() { return json({ reports: [] }); },
  async reportsCreate() { fail(403, 'Support tickets are off in the demo.'); },

  async tfaStatus() { return json({ enabled: false, backup_codes_remaining: 0 }); },
  async tfaBlocked() { fail(403, 'Two-factor sign-in is off in the demo.'); },
};

const PERMISSION_CHOICES = ['create_invoice', 'read_invoice', 'read_analytics', 'manage_refunds', 'manage_recurring', 'wallet_connect'];

export const keys = {
  async list({ env, sb }) {
    const rows = (await env.DB.prepare('SELECT * FROM api_keys WHERE sandbox_id = ? ORDER BY created_at DESC').bind(sb.id).all()).results;
    return json({ keys: rows.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status, scopes: k.scopes, created_at: k.created_at, last_used: k.last_used, revoked_at: k.revoked_at })) });
  },
  async create({ env, request, sb }) {
    const b = await readJson(request);
    const perms = (Array.isArray(b.permissions) ? b.permissions : []).filter(p => PERMISSION_CHOICES.includes(p));
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE sandbox_id = ? AND status = 'active'").bind(sb.id).first('n');
    if (active >= 10) fail(400, 'Maximum 10 active keys allowed');
    const name = (String(b.name || 'Default').trim().slice(0, 64)) || 'Default';
    const raw = 'fg_demo_' + randomString(32);
    const k = { id: uuid(), name, prefix: raw.slice(0, 20) + '…', scopes: perms.length ? perms.sort().join(',') : '*', created_at: nowIso() };
    await env.DB.prepare('INSERT INTO api_keys (id, sandbox_id, name, prefix, key_hash, status, scopes, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(k.id, sb.id, k.name, k.prefix, await sha256Hex(raw), 'active', k.scopes, k.created_at).run();
    return json({ id: k.id, name: k.name, prefix: k.prefix, status: 'active', permissions: perms.length ? perms : ['*'], created_at: k.created_at, key: raw, warning: 'This key will only be shown once. Copy it now.' }, 201);
  },
  async rename({ env, request, sb, params }) {
    const b = await readJson(request);
    const name = String(b.name || '').trim().slice(0, 64) || 'Untitled';
    const r = await env.DB.prepare('UPDATE api_keys SET name = ? WHERE id = ? AND sandbox_id = ?').bind(name, params.id, sb.id).run();
    if (!r.meta.changes) fail(404, 'Not Found');
    return json({ ok: true, name });
  },
  async revoke({ env, sb, params }) {
    const k = await env.DB.prepare('SELECT status FROM api_keys WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!k) fail(404, 'Not Found');
    if (k.status === 'revoked') fail(400, 'Key already revoked');
    await env.DB.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(nowIso(), params.id).run();
    return json({ ok: true, id: params.id, status: 'revoked' });
  },
};

const linkDict = (l, base) => ({
  id: l.id, slug: l.slug, url: `${base}/pay/${l.slug}`, title: l.title, description: l.description, amount_firo: l.amount_firo,
  fixed_amount: !!l.fixed_amount, collect_email: !!l.collect_email, success_url: l.success_url, cancel_url: l.cancel_url,
  is_active: !!l.is_active, uses_count: l.uses_count, cancel_count: l.cancel_count || 0, max_uses: l.max_uses,
  created_at: l.created_at, expires_at: l.expires_at,
});

export async function linkCheckout(env, url, l, body) {
  const now = new Date();
  if (l.expires_at && new Date(l.expires_at) < now) fail(410, 'Payment link has expired');
  if (l.max_uses) {
    const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE sandbox_id = ? AND order_id = ? AND status = 'confirmed'").bind(l.sandbox_id, `LINK-${l.slug}`).first('n');
    if (used >= l.max_uses) fail(410, 'This payment link has reached its usage limit.');
  }
  const amount = l.fixed_amount && l.amount_firo ? l.amount_firo : Number(body.amount_firo || l.amount_firo || 0);
  if (!(amount > 0)) fail(422, 'amount_firo required');
  validateAmount(amount);
  const sb = await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(l.sandbox_id).first();
  if (!sb) fail(503, 'Merchant unavailable');
  const note = typeof body.note === 'string' ? sanitize(body.note, 280) : null;
  const p = await newPayment(env, sb, {
    amount_firo: round8(amount), order_id: `LINK-${l.slug}`, order_description: l.title,
    customer_email: sanitize(body.customer_email || body.email, 254), collect_email: !!l.collect_email,
    success_url: l.success_url, cancel_url: l.cancel_url, timeout_minutes: 30,
    metadata: { link_id: l.id, slug: l.slug, note },
  });
  await env.DB.prepare('UPDATE links SET uses_count = uses_count + 1 WHERE id = ?').bind(l.id).run();
  return { p, checkout_url: `${url.origin}/invoice/${p.id}?t=${await checkoutToken(env, p)}` };
}

export const links = {
  async list({ env, url, sb }) {
    const rows = (await env.DB.prepare('SELECT * FROM links WHERE sandbox_id = ? ORDER BY created_at DESC').bind(sb.id).all()).results;
    return json({ links: rows.map(l => linkDict(l, url.origin)) });
  },
  async create({ env, request, url, sb }) {
    if (!sb.spark_key && !sb.xpub) fail(409, 'Connect your wallet before creating payment links.');
    const b = await readJson(request);
    const title = sanitize(b.title, 128);
    if (!title) fail(422, 'title is required');
    if (b.amount_firo !== null && b.amount_firo !== undefined && b.amount_firo !== '') validateAmount(b.amount_firo);
    const success = validateUrl(b.success_url, 'success_url');
    const cancel = validateUrl(b.cancel_url, 'cancel_url');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE sandbox_id = ?').bind(sb.id).first('n');
    if (count >= 50) fail(429, 'Demo limit reached: 50 links per sandbox.');
    let slug;
    if (b.custom_slug) {
      const raw = String(b.custom_slug).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(raw)) fail(422, 'Custom slug must be 3–32 characters: letters, digits, hyphens only. Cannot start or end with a hyphen.');
      if (await env.DB.prepare('SELECT 1 FROM links WHERE slug = ?').bind(raw).first()) fail(409, `The slug '${raw}' is already taken. Please choose a different name.`);
      slug = raw;
    } else {
      slug = randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789');
    }
    let expires = null;
    if (b.expires_at) {
      const d = new Date(b.expires_at);
      if (isNaN(d)) fail(422, 'Invalid expires_at format');
      expires = d.toISOString();
    }
    const amount = b.amount_firo === null || b.amount_firo === undefined || b.amount_firo === '' ? null : round8(b.amount_firo);
    const l = {
      id: uuid(), sandbox_id: sb.id, slug, title, description: sanitize(b.description, 512), amount_firo: amount,
      fixed_amount: b.fixed_amount === false ? 0 : 1, collect_email: b.collect_email === false ? 0 : 1, success_url: success, cancel_url: cancel,
      is_active: 1, uses_count: 0, cancel_count: 0, max_uses: Number.isInteger(b.max_uses) ? b.max_uses : null, created_at: nowIso(), expires_at: expires,
    };
    await env.DB.prepare(`INSERT INTO links (id, sandbox_id, slug, title, description, amount_firo, fixed_amount, collect_email, success_url, cancel_url,
      is_active, uses_count, cancel_count, max_uses, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(l.id, l.sandbox_id, l.slug, l.title, l.description, l.amount_firo, l.fixed_amount, l.collect_email, l.success_url, l.cancel_url,
        l.is_active, 0, 0, l.max_uses, l.created_at, l.expires_at).run();
    return json(linkDict(l, url.origin), 201);
  },
  async toggle({ env, sb, params }) {
    const l = await env.DB.prepare('SELECT is_active FROM links WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!l) fail(404, 'Link not found');
    const v = l.is_active ? 0 : 1;
    await env.DB.prepare('UPDATE links SET is_active = ? WHERE id = ?').bind(v, params.id).run();
    return json({ id: params.id, is_active: !!v });
  },
  async remove({ env, sb, params }) {
    const r = await env.DB.prepare('DELETE FROM links WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).run();
    if (!r.meta.changes) fail(404, 'Link not found');
    return noContent();
  },
  async exportCsv({ env, sb }) {
    const rows = (await env.DB.prepare('SELECT * FROM payments WHERE sandbox_id = ? ORDER BY created_at DESC').bind(sb.id).all()).results;
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ['Payment ID,Order ID,Order Description,Amount FIRO,Amount Received FIRO,Status,Customer Email,TXID,Created At,Confirmed At'];
    for (const p of rows) {
      lines.push([p.id, p.order_id, p.order_description, p.amount_firo?.toFixed(8), p.amount_received?.toFixed(8), p.status, p.customer_email, p.txid, p.created_at, p.confirmed_at].map(esc).join(','));
    }
    return new Response('﻿' + lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="payments.csv"' } });
  },
  async notifySettings() { return json({ notify_on_payment: false }); },
  async notifySettingsSave() { return json({ ok: true }); },

  async publicGet({ env, params }) {
    const l = await env.DB.prepare('SELECT * FROM links WHERE slug = ?').bind(params.slug).first();
    if (!l || !l.is_active) fail(404, 'Payment link not found or inactive');
    if (l.expires_at && new Date(l.expires_at) < new Date()) fail(410, 'Payment link has expired');
    if (l.max_uses && l.uses_count >= l.max_uses) fail(410, 'This payment link has reached its usage limit.');
    return json({ title: l.title, description: l.description, amount_firo: l.amount_firo, fixed_amount: !!l.fixed_amount, collect_email: !!l.collect_email, merchant_id: l.sandbox_id, slug: l.slug });
  },
  async publicCheckout({ env, request, url, params }) {
    const l = await env.DB.prepare('SELECT * FROM links WHERE slug = ?').bind(params.slug).first();
    if (!l || !l.is_active) fail(404, 'Payment link not found or inactive');
    const { p, checkout_url } = await linkCheckout(env, url, l, await readJson(request));
    return json({ checkout_url, payment_id: p.id, receiving_address: p.receiving_address, amount_firo: p.amount_firo, expires_at: p.expires_at }, 201);
  },
};

const INTERVALS = { week: 7, month: 30, year: 365 };

function nextRun(iso, interval, anchorDay) {
  const d = new Date(iso);
  if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else {
    const m = d.getUTCMonth() + 1;
    const y = d.getUTCFullYear() + Math.floor(m / 12);
    const mm = m % 12;
    const last = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
    d.setUTCFullYear(y, mm, Math.min(anchorDay || d.getUTCDate(), last));
  }
  return d.toISOString();
}

async function planDict(env, url, p) {
  let last = null;
  if (p.last_link_id) {
    const slug = await env.DB.prepare('SELECT slug FROM links WHERE id = ?').bind(p.last_link_id).first('slug');
    if (slug) last = `${url.origin}/pay/${slug}`;
  }
  return {
    id: p.id, title: p.title, description: p.description, amount_firo: p.amount_firo, interval: p.interval, customer_email: p.customer_email,
    customer_name: p.customer_name, is_active: !!p.is_active, next_run_at: p.next_run_at, last_run_at: p.last_run_at,
    runs_count: p.runs_count || 0, max_runs: p.max_runs, last_error: null, last_pay_url: last, created_at: p.created_at,
  };
}

async function ownPlan(env, sb, id) {
  const p = await env.DB.prepare('SELECT * FROM plans WHERE id = ? AND sandbox_id = ?').bind(id, sb.id).first();
  if (!p) fail(404, 'Recurring payment not found');
  return p;
}

export const recurring = {
  async list({ env, url, sb, apiKey }) {
    checkScope(apiKey, 'manage_recurring');
    const rows = (await env.DB.prepare('SELECT * FROM plans WHERE sandbox_id = ? ORDER BY created_at DESC').bind(sb.id).all()).results;
    const out = [];
    for (const p of rows) out.push(await planDict(env, url, p));
    return json(out);
  },
  async create({ env, request, url, sb, apiKey }) {
    checkScope(apiKey, 'manage_recurring');
    const b = await readJson(request);
    const title = sanitize(b.title, 128);
    if (!title) fail(422, 'Add a name for this payment.');
    const amount = validateAmount(b.amount_firo);
    const interval = b.interval || 'month';
    if (!INTERVALS[interval]) fail(422, 'Choose weekly, monthly or yearly.');
    const email = String(b.customer_email || '').trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(email) || email.length > 254) fail(422, 'Enter a valid customer email.');
    if (b.max_runs != null && !(b.max_runs >= 1 && b.max_runs <= 1000)) fail(422, 'Number of payments must be between 1 and 1000.');
    let start = new Date();
    if (b.start_at) { start = new Date(b.start_at); if (isNaN(start)) fail(422, 'Invalid start date.'); }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM plans WHERE sandbox_id = ?').bind(sb.id).first('n');
    if (n >= 20) fail(409, 'Demo limit reached: 20 recurring payments.');
    const p = {
      id: uuid(), sandbox_id: sb.id, title, description: sanitize(b.description, 512), amount_firo: amount, interval, customer_email: email,
      customer_name: sanitize(b.customer_name, 128), is_active: 1, next_run_at: start.toISOString(), anchor_day: start.getUTCDate(),
      runs_count: 0, max_runs: b.max_runs ?? null, created_at: nowIso(), last_run_at: null, last_link_id: null,
    };
    await env.DB.prepare(`INSERT INTO plans (id, sandbox_id, title, description, amount_firo, interval, customer_email, customer_name, is_active,
      next_run_at, anchor_day, runs_count, max_runs, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(p.id, p.sandbox_id, p.title, p.description, p.amount_firo, p.interval, p.customer_email, p.customer_name, 1, p.next_run_at, p.anchor_day, 0, p.max_runs, p.created_at).run();
    return json(await planDict(env, url, p), 201);
  },
  async patch({ env, request, url, sb, params, apiKey }) {
    checkScope(apiKey, 'manage_recurring');
    const p = await ownPlan(env, sb, params.id);
    const b = await readJson(request);
    if (typeof b.is_active === 'boolean') {
      if (b.is_active && p.max_runs && p.runs_count >= p.max_runs) fail(409, 'All payments in this plan were already sent.');
      p.is_active = b.is_active ? 1 : 0;
      if (b.is_active && new Date(p.next_run_at) < new Date()) p.next_run_at = nowIso();
      await env.DB.prepare('UPDATE plans SET is_active = ?, next_run_at = ? WHERE id = ?').bind(p.is_active, p.next_run_at, p.id).run();
    }
    return json(await planDict(env, url, p));
  },
  async sendNow({ env, url, sb, params, apiKey }) {
    checkScope(apiKey, 'manage_recurring');
    const p = await ownPlan(env, sb, params.id);
    if (!p.is_active) fail(409, 'Turn this payment on first.');
    if (p.max_runs && p.runs_count >= p.max_runs) fail(409, 'All payments in this plan were already sent.');
    const linkId = uuid();
    const slug = randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789');
    const now = nowIso();
    await env.DB.prepare(`INSERT INTO links (id, sandbox_id, slug, title, description, amount_firo, fixed_amount, collect_email, is_active, max_uses, created_at)
      VALUES (?,?,?,?,?,?,1,0,1,1,?)`).bind(linkId, sb.id, slug, p.title, p.description, p.amount_firo, now).run();
    p.runs_count += 1;
    p.last_run_at = now;
    p.last_link_id = linkId;
    p.next_run_at = nextRun(p.next_run_at < now ? now : p.next_run_at, p.interval, p.anchor_day);
    if (p.max_runs && p.runs_count >= p.max_runs) p.is_active = 0;
    await env.DB.prepare('UPDATE plans SET runs_count = ?, last_run_at = ?, last_link_id = ?, next_run_at = ?, is_active = ? WHERE id = ?')
      .bind(p.runs_count, p.last_run_at, p.last_link_id, p.next_run_at, p.is_active, p.id).run();
    return json({ ...(await planDict(env, url, p)), emailed: false });
  },
  async remove({ env, sb, params, apiKey }) {
    checkScope(apiKey, 'manage_recurring');
    await ownPlan(env, sb, params.id);
    await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(params.id).run();
    return noContent();
  },
};

const refundDict = r => ({ id: r.id, payment_id: r.payment_id, amount_firo: r.amount_firo, txid: r.txid, reason: r.reason, created_at: r.created_at });

async function ownPayment(env, sb, id) {
  const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ? AND sandbox_id = ?').bind(id, sb.id).first();
  if (!p) fail(404, 'Payment not found');
  return p;
}

export const refunds = {
  async list({ env, sb, params, apiKey }) {
    checkScope(apiKey, 'read_invoice');
    const p = await ownPayment(env, sb, params.id);
    const rows = (await env.DB.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at DESC').bind(p.id).all()).results;
    const refunded = round8(rows.reduce((s, r) => s + r.amount_firo, 0));
    const paid = p.amount_received || p.amount_firo;
    return json({ payment_id: p.id, paid_firo: paid, refunded_firo: refunded, refundable_firo: Math.max(0, round8(paid - refunded)), refunds: rows.map(refundDict) });
  },
  async create({ env, ctx, request, sb, params, apiKey }) {
    checkScope(apiKey, 'manage_refunds');
    const p = await ownPayment(env, sb, params.id);
    if (p.status !== 'confirmed') fail(409, 'Only confirmed payments can be refunded.');
    const b = await readJson(request);
    const amount = round8(b.amount_firo);
    if (!(amount > 0)) fail(422, 'Refund amount must be more than 0.');
    const txid = String(b.txid || '').trim() || null;
    if (txid && !/^[0-9a-fA-F]{64}$/.test(txid)) fail(422, 'TX hash must be 64 hex characters.');
    const reason = sanitize(b.reason, 280);
    const already = (await refundTotals(env, [p.id]))[p.id] || 0;
    const paid = p.amount_received || p.amount_firo;
    const left = round8(paid - already);
    if (amount > left + 1e-8) fail(422, `You can refund up to ${Math.max(left, 0).toFixed(8)} FIRO for this payment.`);
    const r = { id: uuid(), payment_id: p.id, amount_firo: amount, txid, reason, created_at: nowIso() };
    await env.DB.prepare('INSERT INTO refunds (id, sandbox_id, payment_id, amount_firo, txid, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(r.id, sb.id, r.payment_id, r.amount_firo, r.txid, r.reason, r.created_at).run();
    const total = round8(already + amount);
    const full = total >= paid - 1e-8;
    if (sb.webhook_url) {
      ctx.waitUntil(sendWebhook(env, sb, 'payment.refunded', {
        event: 'payment.refunded', payment_id: p.id, order_id: p.order_id, refund_id: r.id, amount_firo: amount,
        refunded_total_firo: total, fully_refunded: full, txid, reason, refunded_at: r.created_at,
      }, p.id).catch(() => {}));
    }
    return json({ ...refundDict(r), refunded_total_firo: total, fully_refunded: full }, 201);
  },
  async remove({ env, sb, params, apiKey }) {
    checkScope(apiKey, 'manage_refunds');
    const r = await env.DB.prepare('DELETE FROM refunds WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).run();
    if (!r.meta.changes) fail(404, 'Refund not found');
    return noContent();
  },
  async summary({ env, url, sb, apiKey }) {
    checkScope(apiKey, 'read_analytics');
    const days = Math.max(1, Math.min(3650, parseInt(url.searchParams.get('days') || '30', 10) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const all = await env.DB.prepare('SELECT COALESCE(SUM(amount_firo),0) AS t, COUNT(*) AS c FROM refunds WHERE sandbox_id = ?').bind(sb.id).first();
    const per = await env.DB.prepare('SELECT COALESCE(SUM(amount_firo),0) AS t, COUNT(*) AS c FROM refunds WHERE sandbox_id = ? AND created_at >= ?').bind(sb.id, since).first();
    return json({ total_firo: round8(all.t), count: all.c, period_days: days, period_firo: round8(per.t), period_count: per.c });
  },
};

const dayStr = d => d.toISOString().slice(0, 10);

async function daily(env, sb, start, end) {
  const since = sb.analytics_reset_at && sb.analytics_reset_at > start ? sb.analytics_reset_at : start;
  const rows = (await env.DB.prepare(`SELECT substr(COALESCE(confirmed_at, created_at), 1, 10) AS d, status,
      SUM(amount_firo) AS g, SUM(COALESCE(amount_received, amount_firo)) AS r, COUNT(*) AS n
    FROM payments WHERE sandbox_id = ? AND COALESCE(confirmed_at, created_at) >= ? AND substr(COALESCE(confirmed_at, created_at), 1, 10) <= ?
      AND status IN ('confirmed','failed','expired','cancelled')
    GROUP BY d, status`).bind(sb.id, since, end).all()).results;
  const map = {};
  for (const r of rows) {
    const e = map[r.d] || (map[r.d] = { gross: 0, received: 0, orders: 0, successful: 0, failed: 0 });
    if (r.status === 'confirmed') { e.gross += r.g; e.received += r.r; e.orders += r.n; e.successful += r.n; }
    else e.failed += r.n;
  }
  return map;
}

function series(map, start, end) {
  const dates = [], sales = [], orders = [];
  for (let d = new Date(start + 'T00:00:00Z'); dayStr(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = dayStr(d);
    dates.push(k);
    sales.push(map[k] ? round8(map[k].gross) : 0);
    orders.push(map[k] ? map[k].orders : 0);
  }
  return { dates, sales, orders };
}

function sum(map) {
  const s = { gross: 0, received: 0, orders: 0, successful: 0, failed: 0 };
  for (const e of Object.values(map)) for (const k of Object.keys(s)) s[k] += e[k];
  return s;
}

const pct = (c, p) => (p ? Math.round((c - p) / p * 1000) / 10 : null);

export const analytics = {
  async user({ env, ctx, url, sb }) {
    await expireAll(env, ctx, sb);
    const period = ['today', '7d', '30d', '90d'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '7d';
    const len = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[period];
    const today = new Date();
    const end = dayStr(today);
    const start = dayStr(new Date(today.getTime() - (len - 1) * 86400000));
    const pEnd = dayStr(new Date(today.getTime() - len * 86400000));
    const pStart = dayStr(new Date(today.getTime() - (2 * len - 1) * 86400000));
    const cur = await daily(env, sb, start, end);
    const prev = await daily(env, sb, pStart, pEnd);
    const c = sum(cur), p = sum(prev);
    const att = c.successful + c.failed, patt = p.successful + p.failed;
    const rate = att ? Math.round(c.successful / att * 1000) / 10 : 0;
    const prate = patt ? Math.round(p.successful / patt * 1000) / 10 : 0;
    const src = (await env.DB.prepare('SELECT order_id, status FROM payments WHERE sandbox_id = ?').bind(sb.id).all()).results;
    let paylink = 0, direct = 0, failed = 0;
    for (const r of src) {
      if (['failed', 'cancelled', 'expired'].includes(r.status)) failed++;
      else if ((r.order_id || '').startsWith('LINK-')) paylink++;
      else direct++;
    }
    return json({
      gross_sales_firo: round8(c.gross), received_firo: round8(c.received), orders_count: c.orders, successful_payments: c.successful,
      failed_payments: c.failed, success_rate_pct: rate, avg_order_value: c.orders ? round8(c.gross / c.orders) : 0,
      deltas: { gross_sales_firo: pct(c.gross, p.gross), received_firo: pct(c.received, p.received), orders_count: pct(c.orders, p.orders), success_rate_pct: pct(rate, prate) },
      invoice_status: { total: paylink + direct + failed, paylink, direct, failed_cancelled: failed },
      chart: series(cur, start, end), period,
    });
  },
  async history({ env, url, sb }) {
    const days = Math.max(1, Math.min(1095, parseInt(url.searchParams.get('days') || '1095', 10) || 1095));
    const today = new Date();
    const end = dayStr(today);
    const start = dayStr(new Date(today.getTime() - (days - 1) * 86400000));
    return json(series(await daily(env, sb, start, end), start, end));
  },
  async hourly({ env, sb }) {
    const endHour = new Date(); endHour.setUTCMinutes(0, 0, 0);
    const startHour = new Date(endHour.getTime() - 23 * 3600000);
    const since = sb.analytics_reset_at && sb.analytics_reset_at > startHour.toISOString() ? sb.analytics_reset_at : startHour.toISOString();
    const rows = (await env.DB.prepare("SELECT confirmed_at, amount_firo FROM payments WHERE sandbox_id = ? AND status = 'confirmed' AND confirmed_at >= ?").bind(sb.id, since).all()).results;
    const labels = [], b = {};
    for (let t = startHour.getTime(); t <= endHour.getTime(); t += 3600000) {
      const k = new Date(t).toISOString().slice(0, 13) + ':00';
      labels.push(k); b[k] = { s: 0, o: 0 };
    }
    for (const r of rows) {
      const k = r.confirmed_at.slice(0, 13) + ':00';
      if (b[k]) { b[k].s = round8(b[k].s + r.amount_firo); b[k].o++; }
    }
    return json({ labels, sales: labels.map(k => b[k].s), orders: labels.map(k => b[k].o) });
  },
  async reset({ env, request, sb }) {
    const b = await readJson(request);
    if (b.confirm !== 'RESET') fail(422, 'Type "RESET" to confirm this cannot be undone.');
    await update(env, sb, { analytics_reset_at: nowIso() });
    return json({ ok: true, message: 'Analytics reset new data will start accumulating from today.' });
  },
};

export const theme = {
  async presets() {
    return json({
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, preview: { accent: p.accent, bg: p.bg, surface: p.surface, text: p.text } })),
      fonts: Object.keys(SAFE_FONTS), button_styles: SAFE_BUTTON_STYLES,
    });
  },
  async get({ sb }) {
    const t = themeSettings(sb);
    const resolved = themeFromSandbox(sb);
    return json({
      settings: {
        theme_id: t.theme_id || DEFAULT_THEME_ID, theme_accent: t.theme_accent || null, theme_bg: t.theme_bg || null, theme_surface: t.theme_surface || null,
        theme_text: t.theme_text || null, theme_radius: t.theme_radius || null, theme_font: t.theme_font || null, theme_button_style: t.theme_button_style || null,
        theme_checkout_title: t.theme_checkout_title || null, theme_checkout_subtitle: t.theme_checkout_subtitle || null,
        theme_success_msg: t.theme_success_msg || null, theme_cancel_msg: t.theme_cancel_msg || null,
        theme_qr_position: t.theme_qr_position || 'bottom', theme_cancel_position: t.theme_cancel_position || 'bottom',
        theme_bg_image: t.theme_bg_image || null, theme_bg_overlay: t.theme_bg_overlay || '70',
        checkout_layout: t.checkout_layout || 'stripe', theme_v2_colors: resolved.v2_colors || {},
      },
      resolved,
    });
  },
  async save({ env, request, sb }) {
    const b = await readJson(request);
    const safe = validateThemeInput(b);
    const t = themeSettings(sb);
    for (const [k, v] of Object.entries(safe)) if (b[k] !== undefined && b[k] !== null) t[k] = v;
    const raw = JSON.stringify(t);
    if (raw.length > 1000000) fail(422, 'Theme is too large.');
    await update(env, sb, { theme_json: raw });
    return json({ ok: true, resolved: themeFromSandbox(sb) });
  },
  async reset({ env, sb }) {
    const t = themeSettings(sb);
    const keep = { checkout_layout: t.checkout_layout, theme_qr_position: t.theme_qr_position, theme_cancel_position: t.theme_cancel_position, theme_bg_image: t.theme_bg_image, theme_bg_overlay: t.theme_bg_overlay };
    await update(env, sb, { theme_json: JSON.stringify({ ...keep, theme_id: DEFAULT_THEME_ID }) });
    return json({ ok: true, theme_id: DEFAULT_THEME_ID });
  },
  async preview({ request, sb }) {
    const safe = validateThemeInput(await readJson(request));
    const o = {};
    for (const [k, v] of Object.entries(safe)) if (v !== null) o[k.replace('theme_', '')] = v;
    return json({ resolved: resolveTheme(safe.theme_id || themeSettings(sb).theme_id || DEFAULT_THEME_ID, o) });
  },
  async thumbnails() { return json(THUMBNAILS); },
  async thumbnailUpload() { fail(403, 'Operator only.'); },
};

const REAL_KEY_HINT = 'This is a demo. Use a demo key, never your real one.';

async function xpubStatus(env, sb) {
  const out = {
    connected: !!sb.xpub, spark_connected: !!sb.spark_key, spark_enabled: !!sb.pay_spark_enabled,
    transparent_enabled: !!sb.pay_transparent_enabled, default_method: sb.pay_default_method || 'spark',
  };
  if (sb.xpub) Object.assign(out, { network: 'mainnet', first_address: sb.xpub_first, addresses_used: sb.xpub_next || 0, connected_at: sb.xpub_connected_at });
  return out;
}

function demoAddressFor(xpub, i) {
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let h = 0, out = 'a';
  const seed = xpub + ':' + i;
  for (let n = 0; n < 33; n++) {
    for (let j = 0; j < seed.length; j++) h = (h * 31 + seed.charCodeAt(j) + n) >>> 0;
    out += BASE58[h % 58];
  }
  return out;
}

export const wallet = {
  async xpubStatus({ env, sb, apiKey }) { checkScope(apiKey, 'wallet_connect'); return json(await xpubStatus(env, sb)); },
  async xpubPreview({ env, request, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    const v = String((await readJson(request)).xpub || '').trim();
    if (!(await isDemoXpub(env, v))) fail(422, REAL_KEY_HINT);
    return json({ network: 'mainnet', depth: 3, addresses: [0, 1, 2].map(i => demoAddressFor(v, i)) });
  },
  async xpubConnect({ env, request, sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    const v = String((await readJson(request)).xpub || '').trim();
    if (!(await isDemoXpub(env, v))) fail(422, REAL_KEY_HINT);
    await update(env, sb, { xpub: v, xpub_first: demoAddressFor(v, 0), xpub_next: sb.xpub === v ? sb.xpub_next : 0, xpub_connected_at: nowIso() });
    return json(await xpubStatus(env, sb), 201);
  },
  async xpubDisconnect({ env, sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    if (!sb.xpub) fail(404, 'No xpub connected.');
    await update(env, sb, { xpub: null, xpub_first: null, xpub_connected_at: null });
    return json(await xpubStatus(env, sb));
  },
  async methods({ env, request, sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    const b = await readJson(request);
    if (b.default_method != null && !['spark', 'transparent'].includes(b.default_method)) fail(422, 'Default must be spark or transparent.');
    const sparkOn = typeof b.spark_enabled === 'boolean' ? b.spark_enabled : !!sb.pay_spark_enabled;
    const transOn = typeof b.transparent_enabled === 'boolean' ? b.transparent_enabled : !!sb.pay_transparent_enabled;
    if (!((sparkOn && sb.spark_key) || (transOn && sb.xpub))) fail(409, 'Keep at least one connected method on.');
    const f = { pay_spark_enabled: sparkOn ? 1 : 0, pay_transparent_enabled: transOn ? 1 : 0 };
    if (b.default_method != null) f.pay_default_method = b.default_method;
    await update(env, sb, f);
    return json(await xpubStatus(env, sb));
  },
  async sparkStatus({ sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    if (!sb.spark_key) return json({ connected: false, enabled: true });
    return json({ connected: true, enabled: true, network: sb.spark_network || 'mainnet', label: null, view_key_suffix: sb.spark_key.slice(-8), connected_at: sb.spark_connected_at });
  },
  async sparkConnect({ env, request, sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    const b = await readJson(request);
    const v = String(b.view_key_hex || '').trim();
    if (!v) fail(422, 'view_key_hex is required');
    if (!(await isDemoSparkKey(env, v))) fail(422, REAL_KEY_HINT);
    await update(env, sb, { spark_key: v, spark_network: 'mainnet', spark_connected_at: nowIso() });
    return json({ connected: true, network: 'mainnet' }, 201);
  },
  async sparkDisconnect({ env, sb, apiKey }) {
    checkScope(apiKey, 'wallet_connect');
    if (!sb.spark_key) fail(404, 'No Spark connection found');
    await update(env, sb, { spark_key: null, spark_connected_at: null });
    return json({ disconnected: true });
  },
};

export async function webhookLog({ env, sb }) {
  const rows = (await env.DB.prepare('SELECT id, payment_id, event, status_code, ok, error, payload, created_at FROM webhook_log WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 20').bind(sb.id).all()).results;
  return json({ configured: !!sb.webhook_url, deliveries: rows.map(r => ({ ...r, ok: !!r.ok })) });
}

export async function merchantEvents({ env, ctx, sb }) {
  const rows = (await env.DB.prepare('SELECT * FROM payments WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 10').bind(sb.id).all()).results;
  await advanceMany(env, ctx, rows, sb);
  return new Response(`retry: 15000\n: demo\n\n`, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store' } });
}

export { fakeTransparentAddress };
