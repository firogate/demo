import { fail, json, nowIso, randomHex, readJson } from './util.js';
import { advance } from './payments.js';

const STATES = ['payment_unconfirmed', 'not_minted', 'mint_unconfirmed', 'minted_verified', 'partly_minted', 'mint_unverified', 'spent_without_mint'];
const FEE_SATS = 4800;
const MINT_BLOCK_SECONDS = 15;
const FINAL_DEPTH = 6;
const KINDS = ['full', 'partial', 'other'];

const sats = v => Math.round((Number(v) || 0) * 1e8);

async function isCheckOn(env, sb) {
  const r = await env.DB.prepare('SELECT check_on FROM spark_mint_prefs WHERE sandbox_id = ?').bind(sb.id).first();
  return r ? !!r.check_on : true;
}

function rowFor(p, mint, now) {
  const amount = sats(p.amount_received);
  const base = {
    payment_id: p.id, order_id: p.order_id, txid: p.txid, vout: 0, txid_url: null, amount_sats: amount,
    confirmations: p.confirmations || 0, state: 'not_minted', final: false, spend_txid: null, spend_confirmations: 0,
    mint_txid: null, mint_url: null, minted_verified_sats: 0, minted_unmatched_sats: 0, fee_sats: 0, change_sats: 0,
    detail: null, state_changed_at: p.confirmed_at || p.detected_at || p.created_at,
  };
  if (p.status !== 'confirmed') return { ...base, state: 'payment_unconfirmed' };
  if (!mint) return base;
  const age = Math.max(0, (now - new Date(mint.created_at).getTime()) / 1000);
  const conf = age < MINT_BLOCK_SECONDS ? 0 : Math.min(FINAL_DEPTH, 1 + Math.floor((age - MINT_BLOCK_SECONDS) / 8));
  const out = { ...base, spend_txid: mint.mint_txid, mint_txid: mint.mint_txid, spend_confirmations: conf, fee_sats: FEE_SATS, state_changed_at: mint.created_at };
  if (mint.kind === 'other') {
    return { ...out, state: 'mint_unverified', minted_unmatched_sats: Math.max(0, amount - FEE_SATS) };
  }
  if (mint.kind === 'partial') {
    const minted = Math.floor(amount * 0.6);
    return { ...out, state: 'partly_minted', minted_verified_sats: minted, change_sats: Math.max(0, amount - minted - FEE_SATS), final: conf >= FINAL_DEPTH };
  }
  return { ...out, state: conf < 1 ? 'mint_unconfirmed' : 'minted_verified', minted_verified_sats: Math.max(0, amount - FEE_SATS), final: conf >= FINAL_DEPTH };
}

async function rows(env, ctx, sb) {
  const res = await env.DB.prepare(`SELECT * FROM payments WHERE sandbox_id = ? AND transparent_address IS NOT NULL
    AND address_type = 'transparent' AND amount_received > 0 ORDER BY created_at DESC`).bind(sb.id).all();
  const pays = res.results || [];
  for (const p of pays) if (p.status === 'pending' || p.status === 'confirming') await advance(env, ctx, p, sb);
  const mints = (await env.DB.prepare('SELECT * FROM spark_mints WHERE sandbox_id = ?').bind(sb.id).all()).results || [];
  const byPay = Object.fromEntries(mints.map(m => [m.payment_id, m]));
  const on = await isCheckOn(env, sb);
  const now = Date.now();
  return pays.filter(p => on || byPay[p.id]).map(p => rowFor(p, byPay[p.id], now));
}

export const sparkMints = {
  async status({ env, ctx, sb }) {
    const list = await rows(env, ctx, sb);
    const counts = Object.fromEntries(STATES.map(s => [s, 0]));
    let received = 0, minted = 0, fees = 0;
    for (const r of list) {
      counts[r.state] += 1;
      received += r.amount_sats;
      minted += r.minted_verified_sats;
      fees += r.fee_sats;
    }
    return json({
      check_enabled: await isCheckOn(env, sb), xpub_connected: !!sb.xpub, view_key_connected: !!sb.spark_key,
      node_ready: true, checked_at: nowIso(), counts, received_sats: received, minted_verified_sats: minted, fee_sats: fees,
    });
  },

  async settings({ env, request, sb }) {
    const b = await readJson(request);
    if (typeof b.check_enabled !== 'boolean') fail(422, 'check_enabled must be true or false.');
    await env.DB.prepare('INSERT INTO spark_mint_prefs (sandbox_id, check_on) VALUES (?, ?) ON CONFLICT(sandbox_id) DO UPDATE SET check_on = excluded.check_on')
      .bind(sb.id, b.check_enabled ? 1 : 0).run();
    return json({ check_enabled: b.check_enabled });
  },

  async inputs({ env, ctx, url, sb }) {
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
    const state = url.searchParams.get('state');
    if (state && !STATES.includes(state)) fail(422, 'Unknown state.');
    const list = (await rows(env, ctx, sb)).filter(r => !state || r.state === state);
    return json({ total: list.length, offset, limit, items: list.slice(offset, offset + limit) });
  },

  async payment({ env, ctx, params, sb }) {
    const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!p) fail(404, 'Payment not found');
    const transparent = p.address_type === 'transparent' && !!p.transparent_address;
    const items = transparent ? (await rows(env, ctx, sb)).filter(r => r.payment_id === p.id) : [];
    return json({ transparent, check_enabled: await isCheckOn(env, sb), items });
  },

  async simulateMint({ env, ctx, request, params, sb }) {
    const b = await readJson(request);
    const kind = KINDS.includes(b.kind) ? b.kind : 'full';
    const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ? AND sandbox_id = ?').bind(params.id, sb.id).first();
    if (!p) fail(404, 'Payment not found');
    if (p.address_type !== 'transparent') fail(409, 'Only transparent payments can be minted.');
    await advance(env, ctx, p, sb);
    if (p.status !== 'confirmed') fail(409, 'Wait until the payment is confirmed.');
    const done = await env.DB.prepare('SELECT 1 FROM spark_mints WHERE payment_id = ?').bind(p.id).first();
    if (done) fail(409, 'Already minted.');
    await env.DB.prepare('INSERT INTO spark_mints (payment_id, sandbox_id, kind, mint_txid, created_at) VALUES (?,?,?,?,?)')
      .bind(p.id, sb.id, kind, randomHex(32), nowIso()).run();
    return json({ ok: true, kind });
  },
};
