import qrcode from 'qrcode-generator';
import {
  fail, json, nowIso, addMinutes, uuid, randomHex, randomString, hmacB64url, safeEqual,
  sanitize, validateAmount, validateUrl, readJson, round8,
} from './util.js';
import { themeFromSandbox } from './themes.js';
import { sendWebhook } from './webhook.js';

const CONFIRM_SECONDS = 8;
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const fakeSparkAddress = () => 'sm1' + randomString(141, BECH32);
export const fakeTransparentAddress = () => 'a' + randomString(33, BASE58);

export async function checkoutToken(env, p) {
  return hmacB64url(env.SECRET_KEY, `${p.id}:${p.created_at}`);
}

export async function verifyCheckoutToken(env, p, token) {
  return !!token && safeEqual(await checkoutToken(env, p), token);
}

const tokenFrom = (request, url) => request.headers.get('x-checkout-token') || url.searchParams.get('t') || '';

export function methods(p) {
  const out = [];
  if (p.spark_address) out.push({ method: 'spark', address: p.spark_address });
  if (p.transparent_address) out.push({ method: 'transparent', address: p.transparent_address });
  return out;
}

function displayStatus(p, status) {
  const recv = p.amount_received || 0;
  if ((status === 'pending' || status === 'confirming') && recv > 0 && recv < p.amount_firo) return 'partially_paid';
  return status;
}

function meta(p) {
  try { return p.metadata_json ? JSON.parse(p.metadata_json) : {}; } catch { return {}; }
}

export async function fmt(env, p, full = false) {
  const d = {
    payment_id: p.id,
    status: p.status,
    display_status: displayStatus(p, p.status),
    amount_firo: p.amount_firo,
    amount_received: p.amount_received,
    txid: p.txid,
    confirmations: p.confirmations,
    required_confirmations: p.required_confirmations,
    receiving_address: p.receiving_address,
    methods: methods(p),
    address_type: p.address_type || 'spark',
    order_id: p.order_id,
    order_description: p.order_description,
    collect_email: !!p.collect_email,
    email_collected: !!p.customer_email,
    cancel_url: p.cancel_url,
    success_url: p.success_url,
    created_at: p.created_at,
    expires_at: p.expires_at,
    confirmed_at: p.confirmed_at,
    amount_usd: null,
    checkout_token: await checkoutToken(env, p),
  };
  if (full) {
    d.customer_email = p.customer_email;
    d.vout = p.txid ? 0 : null;
    d.webhook_sent = !!p.webhook_sent;
    d.payer_note = meta(p).note || null;
  }
  return d;
}

export async function advance(env, ctx, p, sb) {
  if (p.status !== 'pending' && p.status !== 'confirming') return p;
  const now = Date.now();
  const before = JSON.stringify([p.status, p.confirmations, p.confirmed_at]);
  let event = null;
  const paid = (p.amount_received || 0) >= p.amount_firo - 1e-8;
  if (p.detected_at && paid) {
    const secs = (now - new Date(p.detected_at).getTime()) / 1000;
    const req = p.required_confirmations || 0;
    p.confirmations = Math.min(Math.max(req, 1), 1 + Math.floor(secs / CONFIRM_SECONDS));
    if (p.confirmations >= req) {
      p.status = 'confirmed';
      p.confirmed_at = new Date().toISOString();
      event = 'payment.confirmed';
    } else {
      p.status = 'confirming';
    }
  } else if (p.expires_at && new Date(p.expires_at).getTime() < now) {
    p.status = 'expired';
    event = 'payment.expired';
  }
  if (JSON.stringify([p.status, p.confirmations, p.confirmed_at]) !== before) {
    await env.DB.prepare('UPDATE payments SET status = ?, confirmations = ?, confirmed_at = ? WHERE id = ?')
      .bind(p.status, p.confirmations, p.confirmed_at, p.id).run();
    if (event) {
      const owner = sb || await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(p.sandbox_id).first();
      if (owner && owner.webhook_url) {
        const payload = event === 'payment.confirmed'
          ? {
            event, payment_id: p.id, order_id: p.order_id, amount_firo: p.amount_firo,
            amount_received: p.amount_received, txid: p.txid, confirmations: p.confirmations,
            customer_email: p.customer_email, confirmed_at: p.confirmed_at, metadata: meta(p),
          }
          : { event, payment_id: p.id, order_id: p.order_id, amount_firo: p.amount_firo, expired_at: new Date().toISOString(), metadata: meta(p) };
        ctx.waitUntil(sendWebhook(env, owner, event, payload, p.id).then(r => {
          if (r.ok && event === 'payment.confirmed') return env.DB.prepare('UPDATE payments SET webhook_sent = 1 WHERE id = ?').bind(p.id).run();
        }).catch(() => {}));
      }
    }
  }
  return p;
}

export async function advanceMany(env, ctx, rows, sb) {
  for (const p of rows) await advance(env, ctx, p, sb);
  return rows;
}

export function requiredConfirmations(sb) {
  const v = sb.required_confirmations_policy;
  return v === null || v === undefined ? 2 : v;
}

export async function newPayment(env, sb, f) {
  const sparkOn = !!sb.spark_key && sb.pay_spark_enabled;
  const transOn = !!sb.xpub && sb.pay_transparent_enabled;
  if (!sparkOn && !transOn) fail(409, 'Connect your wallet before creating payments.');
  const spark = sparkOn ? fakeSparkAddress() : null;
  const trans = transOn ? fakeTransparentAddress() : null;
  if (transOn) await env.DB.prepare('UPDATE sandboxes SET xpub_next = xpub_next + 1 WHERE id = ?').bind(sb.id).run();
  const useTrans = transOn && (!sparkOn || sb.pay_default_method === 'transparent');
  const created = nowIso();
  const p = {
    id: uuid(), sandbox_id: sb.id, created_at: created,
    expires_at: addMinutes(created, Math.max(5, Math.min(1440, f.timeout_minutes || 20))),
    status: 'pending', amount_firo: f.amount_firo, amount_received: null, txid: null, confirmations: 0,
    required_confirmations: f.required_confirmations ?? requiredConfirmations(sb),
    detected_at: null, confirmed_at: null,
    address_type: useTrans ? 'transparent' : 'spark',
    receiving_address: useTrans ? trans : spark, spark_address: spark, transparent_address: trans,
    order_id: f.order_id ?? null, order_description: f.order_description ?? null, customer_email: f.customer_email ?? null,
    collect_email: f.collect_email === false ? 0 : 1, success_url: f.success_url ?? null, cancel_url: f.cancel_url ?? null,
    metadata_json: f.metadata ? JSON.stringify(f.metadata) : null, extend_count: 0, webhook_sent: 0,
  };
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE sandbox_id = ?').bind(sb.id).first('n');
  if (count >= 1000) fail(429, 'Demo limit reached: 1000 payments per sandbox.');
  await insertPayment(env, p);
  return p;
}

export async function insertPayment(env, p) {
  await paymentStmt(env, p).run();
}

export function paymentStmt(env, p) {
  return env.DB.prepare(`INSERT INTO payments (id, sandbox_id, created_at, expires_at, status, amount_firo, amount_received, txid,
    confirmations, required_confirmations, detected_at, confirmed_at, address_type, receiving_address, spark_address,
    transparent_address, order_id, order_description, customer_email, collect_email, success_url, cancel_url, metadata_json,
    extend_count, webhook_sent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(p.id, p.sandbox_id, p.created_at, p.expires_at, p.status, p.amount_firo, p.amount_received, p.txid,
      p.confirmations, p.required_confirmations, p.detected_at, p.confirmed_at, p.address_type, p.receiving_address,
      p.spark_address, p.transparent_address, p.order_id, p.order_description, p.customer_email, p.collect_email,
      p.success_url, p.cancel_url, p.metadata_json, p.extend_count, p.webhook_sent);
}

export async function refundTotals(env, ids) {
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT payment_id, SUM(amount_firo) AS total FROM refunds WHERE payment_id IN (${chunk.map(() => '?').join(',')}) GROUP BY payment_id`)
      .bind(...chunk).all();
    for (const r of rows.results) out[r.payment_id] = round8(r.total);
  }
  return out;
}

function checkoutBase(url) { return url.origin; }

function filters(url, sb) {
  const where = ['sandbox_id = ?'];
  const args = [sb.id];
  const status = url.searchParams.get('status');
  if (status) { where.push('status = ?'); args.push(status); }
  const from = url.searchParams.get('date_from');
  if (from) { where.push('created_at >= ?'); args.push(parseDate(from, false)); }
  const to = url.searchParams.get('date_to');
  if (to) { where.push('created_at <= ?'); args.push(parseDate(to, true)); }
  const search = url.searchParams.get('search');
  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    where.push('(id LIKE ? OR order_id LIKE ? OR customer_email LIKE ? OR txid LIKE ?)');
    args.push(s, s, s, s);
  }
  return { sql: where.join(' AND '), args };
}

function parseDate(s, endOfDay) {
  const v = s.trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z') : v);
  if (isNaN(d)) fail(422, endOfDay ? 'invalid date_to' : 'invalid date_from');
  return d.toISOString();
}

export async function expireAll(env, ctx, sb) {
  const rows = await env.DB.prepare(`SELECT * FROM payments WHERE sandbox_id = ? AND status IN ('pending','confirming') LIMIT 200`).bind(sb.id).all();
  await advanceMany(env, ctx, rows.results, sb);
}

export const merchantRoutes = {
  async create({ env, request, url, sb }) {
    const b = await readJson(request);
    const f = {
      amount_firo: validateAmount(b.amount_firo),
      order_id: sanitize(b.order_id, 256),
      order_description: sanitize(b.order_description, 512),
      customer_email: sanitize(b.customer_email, 254),
      success_url: validateUrl(b.success_url, 'success_url'),
      cancel_url: validateUrl(b.cancel_url, 'cancel_url'),
      required_confirmations: Number.isInteger(b.required_confirmations) ? Math.max(0, Math.min(6, b.required_confirmations)) : null,
      timeout_minutes: Number.isInteger(b.timeout_minutes) ? b.timeout_minutes : 20,
      collect_email: b.collect_email !== false,
      metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : null,
    };
    if (f.metadata && JSON.stringify(f.metadata).length > 4000) fail(422, 'metadata is too large');
    if (f.order_id) {
      const dup = await env.DB.prepare(`SELECT * FROM payments WHERE sandbox_id = ? AND order_id = ? AND status IN ('pending','confirming','confirmed') ORDER BY created_at DESC LIMIT 1`)
        .bind(sb.id, f.order_id).first();
      if (dup) {
        return json({
          payment_id: dup.id, checkout_url: `${checkoutBase(url)}/invoice/${dup.id}?t=${await checkoutToken(env, dup)}`,
          receiving_address: dup.receiving_address, address_type: dup.address_type, amount_firo: dup.amount_firo,
          status: dup.status, expires_at: dup.expires_at, idempotent: true,
        });
      }
    }
    if (f.required_confirmations === null) delete f.required_confirmations;
    const p = await newPayment(env, sb, f);
    return json({
      payment_id: p.id,
      checkout_url: `${checkoutBase(url)}/invoice/${p.id}?t=${await checkoutToken(env, p)}`,
      receiving_address: p.receiving_address,
      address_type: p.address_type,
      amount_firo: p.amount_firo,
      order_id: p.order_id,
      expires_at: p.expires_at,
      required_confirmations: p.required_confirmations,
      status: p.status,
    }, 201);
  },

  async list({ env, ctx, url, sb }) {
    const { sql, args } = filters(url, sb);
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE ${sql}`).bind(...args).first('n');
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const rows = (await env.DB.prepare(`SELECT * FROM payments WHERE ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all()).results;
    await advanceMany(env, ctx, rows, sb);
    const refunded = await refundTotals(env, rows.map(r => r.id));
    const out = [];
    for (const p of rows) out.push({ ...(await fmt(env, p, true)), refunded_firo: refunded[p.id] || 0 });
    return json(out, 200, { 'X-Total-Count': String(total || 0), 'Access-Control-Expose-Headers': 'X-Total-Count' });
  },

  async search({ env, url, sb }) {
    const term = (url.searchParams.get('q') || '').trim();
    if (term.length < 2) return json([]);
    const s = `%${term}%`;
    const rows = (await env.DB.prepare(`SELECT * FROM payments WHERE sandbox_id = ? AND (id LIKE ? OR txid LIKE ? OR order_id LIKE ?) ORDER BY created_at DESC LIMIT 10`)
      .bind(sb.id, s, s, s).all()).results;
    const t = term.toLowerCase();
    return json(rows.map(p => ({
      payment_id: p.id, txid: p.txid, order_id: p.order_id, amount_firo: p.amount_firo, status: p.status, created_at: p.created_at,
      match_on: (p.txid || '').toLowerCase().includes(t) ? 'txid' : (p.order_id || '').toLowerCase().includes(t) ? 'order' : 'id',
    })));
  },

  async exportCsv({ env, ctx, url, sb }) {
    const { sql, args } = filters(url, sb);
    const rows = (await env.DB.prepare(`SELECT * FROM payments WHERE ${sql} ORDER BY created_at DESC LIMIT 10000`).bind(...args).all()).results;
    await advanceMany(env, ctx, rows.filter(r => r.status === 'pending' || r.status === 'confirming'), sb);
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['payment_id', 'created_at', 'confirmed_at', 'status', 'amount_firo', 'amount_received', 'txid', 'confirmations', 'order_id', 'order_description', 'customer_email', 'vendor_id'].join(',')];
    for (const p of rows) {
      lines.push([p.id, p.created_at, p.confirmed_at || '', p.status, p.amount_firo, p.amount_received ?? '', p.txid || '', p.confirmations || 0,
        p.order_id || '', (p.order_description || '').replace(/\n/g, ' '), p.customer_email || '', meta(p).vendor_id || ''].map(esc).join(','));
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payments_${stamp}.csv"` },
    });
  },

  async summary({ env, url, sb }) {
    const where = ["sandbox_id = ?", "status = 'confirmed'"];
    const args = [sb.id];
    const from = url.searchParams.get('date_from');
    if (from) { where.push('created_at >= ?'); args.push(parseDate(from, false)); }
    const to = url.searchParams.get('date_to');
    if (to) { where.push('created_at <= ?'); args.push(parseDate(to, true)); }
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_firo),0) AS g, COALESCE(SUM(amount_received),0) AS r FROM payments WHERE ${where.join(' AND ')}`).bind(...args).first();
    const by = (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM payments WHERE sandbox_id = ? GROUP BY status').bind(sb.id).all()).results;
    return json({
      confirmed_count: row.c, total_gross_sales: round8(row.g), total_received: round8(row.r),
      by_status: Object.fromEntries(by.map(r => [r.status, r.n])),
    });
  },

  async byVendor({ env, sb }) {
    const rows = (await env.DB.prepare("SELECT amount_firo, amount_received, metadata_json FROM payments WHERE sandbox_id = ? AND status = 'confirmed'").bind(sb.id).all()).results;
    const vendors = {};
    for (const p of rows) {
      const vid = String(meta(p).vendor_id || 'unassigned');
      const v = vendors[vid] || (vendors[vid] = { vendor_id: vid, count: 0, total_gross_sales: 0, total_received: 0 });
      v.count++; v.total_gross_sales += p.amount_firo || 0; v.total_received += p.amount_received || 0;
    }
    for (const v of Object.values(vendors)) { v.total_gross_sales = round8(v.total_gross_sales); v.total_received = round8(v.total_received); }
    return json({ vendors: Object.values(vendors) });
  },

  async get({ env, ctx, sb, params }) {
    const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!p) fail(404, 'Payment not found');
    await advance(env, ctx, p, sb);
    const refunded = await refundTotals(env, [p.id]);
    return json({ ...(await fmt(env, p, true)), refunded_firo: refunded[p.id] || 0 });
  },

  async simulate({ env, ctx, request, sb, params }) {
    const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!p) fail(404, 'Payment not found');
    const b = await readJson(request);
    return json(await simulatePayment(env, ctx, p, b.mode === 'half' ? 'half' : 'full'));
  },
};

export async function simulatePayment(env, ctx, p, mode) {
  await advance(env, ctx, p);
  if (p.status !== 'pending' && p.status !== 'confirming') fail(409, `Payment is ${p.status}.`);
  if ((p.amount_received || 0) >= p.amount_firo - 1e-8) fail(409, 'Already paid.');
  const add = mode === 'half' ? round8(p.amount_firo / 2) : round8(p.amount_firo - (p.amount_received || 0));
  p.amount_received = round8(Math.min(p.amount_firo, (p.amount_received || 0) + add));
  p.txid = p.txid || randomHex(32);
  p.detected_at = nowIso();
  p.status = 'confirming';
  p.confirmations = 0;
  await env.DB.prepare('UPDATE payments SET amount_received = ?, txid = ?, detected_at = ?, status = ?, confirmations = 0 WHERE id = ?')
    .bind(p.amount_received, p.txid, p.detected_at, p.status, p.id).run();
  return { ok: true, payment_id: p.id, amount_received: p.amount_received, txid: p.txid, status: p.status };
}

async function publicPayment(env, ctx, request, url, id) {
  const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'Payment not found');
  if (!(await verifyCheckoutToken(env, p, tokenFrom(request, url)))) fail(403, 'Invalid checkout token');
  await advance(env, ctx, p);
  return p;
}

export const publicRoutes = {
  async status({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    const sb = await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(p.sandbox_id).first();
    const r = await fmt(env, p);
    r.is_plan_purchase = false;
    r.merchant_app_name = (sb && sb.app_name) || '';
    r.merchant_logo = (sb && sb.app_logo) || '';
    r.show_market_price = !!(sb && sb.show_market_price);
    r.brand_primary = null; r.brand_bg = null; r.brand_text = null;
    r.theme = sb ? themeFromSandbox(sb) : null;
    r.is_testnet = false;
    r.node_online = true;
    return json(r);
  },

  async email({ env, ctx, request, url, params }) {
    const b = await readJson(request);
    const email = sanitize((b.email || '').trim(), 254);
    if (!email || !email.includes('@')) fail(422, 'Valid email required');
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status === 'confirmed' || p.status === 'expired') fail(400, `Payment is ${p.status}`);
    await env.DB.prepare('UPDATE payments SET customer_email = ? WHERE id = ?').bind(email, p.id).run();
    return json({ message: 'Email saved', step: 'payment' });
  },

  async method({ env, ctx, request, url, params }) {
    const b = await readJson(request);
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status !== 'pending' && p.status !== 'confirming') fail(400, "This payment can't be changed now.");
    const chosen = methods(p).find(m => m.method === b.method);
    if (!chosen) fail(422, "This payment method isn't available.");
    await env.DB.prepare('UPDATE payments SET address_type = ?, receiving_address = ? WHERE id = ?').bind(chosen.method, chosen.address, p.id).run();
    return json({ method: chosen.method, receiving_address: chosen.address });
  },

  async verifyHash({ env, ctx, request, url, params }) {
    const b = await readJson(request);
    const tx = sanitize((b.txhash || '').trim(), 64);
    if (!tx || tx.length < 32) fail(422, 'Valid TX hash required');
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status === 'confirmed') return json({ status: 'confirmed', message: 'Payment already confirmed.' });
    return json({ status: 'not_found', message: 'Demo mode: use the Simulate payment button instead.' });
  },

  async extend({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status !== 'pending' && p.status !== 'confirming') fail(400, `Cannot extend payment is ${p.status}`);
    if ((p.extend_count || 0) >= 3) fail(400, 'Maximum 3 extensions allowed per payment');
    const base = Math.max(new Date(p.expires_at).getTime(), Date.now());
    const exp = new Date(base + 600000).toISOString();
    const used = (p.extend_count || 0) + 1;
    await env.DB.prepare('UPDATE payments SET expires_at = ?, extend_count = ? WHERE id = ?').bind(exp, used, p.id).run();
    return json({ extended: true, new_expires_at: exp, extensions_used: used, extensions_left: 3 - used, message: `+10 minutes added. ${3 - used} extension(s) remaining.` });
  },

  async receipt({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status !== 'confirmed') fail(400, 'Receipt only available for confirmed payments');
    return json({
      payment_id: p.id, order_id: p.order_id, order_description: p.order_description, amount_firo: p.amount_firo,
      amount_received: p.amount_received, txid: p.txid, confirmations: p.confirmations, confirmed_at: p.confirmed_at,
      customer_email: p.customer_email, explorer_url: null, is_testnet: false, network: 'demo',
    });
  },

  async qr({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status === 'confirmed' || p.status === 'expired' || p.status === 'cancelled') fail(400, `QR code not available - payment is ${p.status}`);
    const q = new URLSearchParams({ amount: p.amount_firo.toFixed(8) });
    if (p.order_description) q.set('label', p.order_description.slice(0, 50));
    if (p.order_id) q.set('message', `Order: ${p.order_id.slice(0, 30)}`);
    const uri = `firo:${p.receiving_address}?${q.toString()}`;
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    return json({
      qr_data: 'data:image/svg+xml;base64,' + btoa(svg),
      firo_uri: uri, address: p.receiving_address, amount: p.amount_firo, payment_id: p.id,
    });
  },

  async cancel({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    if (p.status !== 'pending' && p.status !== 'confirming') fail(400, `Cannot cancel payment - status is ${p.status}`);
    await env.DB.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").bind(p.id).run();
    const sb = await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(p.sandbox_id).first();
    if (sb && sb.webhook_url) {
      ctx.waitUntil(sendWebhook(env, sb, 'payment.cancelled', {
        event: 'payment.cancelled', payment_id: p.id, order_id: p.order_id, amount_firo: p.amount_firo,
        cancelled_at: nowIso(), metadata: meta(p),
      }, p.id).catch(() => {}));
    }
    const slug = meta(p).slug;
    let redirect = '/dashboard';
    if (slug) {
      await env.DB.prepare('UPDATE links SET cancel_count = cancel_count + 1 WHERE slug = ?').bind(slug).run();
      redirect = `/pay/${slug}?cancelled=1`;
    } else if (p.cancel_url) {
      redirect = `${p.cancel_url}${p.cancel_url.includes('?') ? '&' : '?'}status=cancelled&payment_id=${p.id}`;
    }
    return json({ cancelled: true, redirect_url: redirect, message: 'Payment cancelled' });
  },

  async simulate({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    const b = await readJson(request);
    return json(await simulatePayment(env, ctx, p, b.mode === 'half' ? 'half' : 'full'));
  },

  async webhookResult({ env, ctx, request, url, params }) {
    const p = await publicPayment(env, ctx, request, url, params.id);
    const sb = await env.DB.prepare('SELECT webhook_url FROM sandboxes WHERE id = ?').bind(p.sandbox_id).first();
    const d = await env.DB.prepare("SELECT event, status_code, ok, error, created_at FROM webhook_log WHERE payment_id = ? AND event = 'payment.confirmed' ORDER BY created_at DESC LIMIT 1").bind(p.id).first();
    return json({
      status: p.status,
      configured: !!(sb && sb.webhook_url),
      delivery: d ? { event: d.event, status_code: d.status_code, ok: !!d.ok, error: d.error, created_at: d.created_at } : null,
    });
  },

  async events({ env, ctx, url, params }) {
    const first = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(params.id).first();
    if (!first) fail(404, 'Payment not found');
    if (!(await verifyCheckoutToken(env, first, url.searchParams.get('t') || ''))) fail(403, 'Invalid checkout token');
    await advance(env, ctx, first);

    const TERMINAL = { confirmed: 'payment.confirmed', expired: 'payment.expired', cancelled: 'payment.cancelled' };
    const terminalEvent = p => ({ type: TERMINAL[p.status], payment_id: p.id, status: p.status, txid: p.txid, confirmations: p.confirmations, confirmed_at: p.confirmed_at });
    const send = ev => `data: ${JSON.stringify(ev)}\n\n`;

    if (TERMINAL[first.status]) {
      return new Response('retry: 4000\n' + send(terminalEvent(first)), { headers: SSE_HEADERS });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const te = new TextEncoder();
    const write = s => writer.write(te.encode(s));
    const loop = (async () => {
      try {
        await write('retry: 3000\n' + send({
          type: 'payment.status', payment_id: first.id, status: first.status, amount_firo: first.amount_firo,
          confirmations: first.confirmations, required_confirmations: first.required_confirmations,
          expires_at: first.expires_at, txid: first.txid,
        }));
        let last = `${first.status}:${first.confirmations}:${first.amount_received || 0}`;
        for (let i = 0; i < 14; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(first.id).first();
          if (!p) break;
          await advance(env, ctx, p);
          const now = `${p.status}:${p.confirmations}:${p.amount_received || 0}`;
          if (now !== last) {
            last = now;
            if (TERMINAL[p.status]) { await write(send(terminalEvent(p))); break; }
            if (p.status === 'confirming') {
              await write(send({ type: 'payment.detected', payment_id: p.id, txid: p.txid, confirmations: p.confirmations, amount_received: p.amount_received }));
            }
          } else if (i % 5 === 4) {
            await write(': hb\n\n');
          }
        }
      } catch {
      } finally {
        try { await writer.close(); } catch {}
      }
    })();
    ctx.waitUntil(loop);
    return new Response(readable, { headers: SSE_HEADERS });
  },
};

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' };
