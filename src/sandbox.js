import {
  fail, json, nowIso, addHours, uuid, randomHex, randomString, hmacB64url, hmacHex, safeEqual, sha256Hex, cookie, round8,
} from './util.js';
import { fakeSparkAddress, fakeTransparentAddress, paymentStmt } from './payments.js';

export const COOKIE = 'fgd';
const LIFETIME_HOURS = 24;
const STARTS_PER_HOUR = 6;
const MAX_SANDBOXES = 3000;

async function sign(env, id) { return hmacB64url(env.SECRET_KEY, `sandbox:${id}`, 18); }

export async function sessionCookie(env, id, url) {
  const v = `${id}.${await sign(env, id)}`;
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LIFETIME_HOURS * 3600}${secure}`;
}

export const clearCookie = url => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`;

export async function sandboxFromCookie(env, request) {
  const raw = cookie(request, COOKIE);
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const id = raw.slice(0, i);
  if (!safeEqual(raw.slice(i + 1), await sign(env, id))) return null;
  const sb = await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(id).first();
  if (!sb || sb.expires_at < nowIso()) return null;
  return sb;
}

export async function resolveAuth(env, request) {
  const key = request.headers.get('x-api-key');
  if (key) {
    if (key.length < 10) return null;
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").bind(await sha256Hex(key)).first();
    if (row) {
      const sb = await env.DB.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(row.sandbox_id).first();
      if (sb && sb.expires_at >= nowIso()) {
        await env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').bind(nowIso(), row.id).run();
        return { sb, apiKey: row };
      }
    }
  }
  const sb = await sandboxFromCookie(env, request);
  return sb ? { sb, apiKey: null } : null;
}

export function checkScope(apiKey, perm) {
  if (!apiKey) return;
  const scopes = (apiKey.scopes || '*').trim();
  if (scopes === '*') return;
  if (!scopes.split(',').map(s => s.trim()).includes(perm)) fail(403, `API key does not have the '${perm}' permission`);
}

const SPARK_KEY_HEX = 264;
const XPUB_VERSION = [0x04, 0x88, 0xb2, 0x1e];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

async function tag(env, kind, data) {
  return (await hmacHex(env.SECRET_KEY, `demo-key:${kind}:${data}`)).slice(0, 16);
}

async function sha256d(bytes) {
  const a = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', a));
}

function b58encode(bytes) {
  let n = BigInt('0x' + (bytesToHex(bytes) || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Uint8Array.from([...new Array(lead).fill(0), ...(n === 0n ? [] : hexToBytes(hex))]);
}

export async function demoSparkKey(env) {
  const body = randomHex((SPARK_KEY_HEX - 16) / 2);
  return body + await tag(env, 'spark', body);
}

export async function isDemoSparkKey(env, k) {
  if (typeof k !== 'string' || k.length !== SPARK_KEY_HEX || !/^[0-9a-f]+$/i.test(k)) return false;
  const body = k.slice(0, -16).toLowerCase();
  return safeEqual(k.slice(-16).toLowerCase(), await tag(env, 'spark', body));
}

export async function demoXpub(env) {
  const key = hexToBytes((Math.random() < 0.5 ? '02' : '03') + randomHex(32));
  const chain = hexToBytes(await tag(env, 'xpub', bytesToHex(key)) + randomHex(24));
  const payload = Uint8Array.from([...XPUB_VERSION, 3, ...hexToBytes(randomHex(4)), 0x80, 0, 0, 0, ...chain, ...key]);
  const check = (await sha256d(payload)).slice(0, 4);
  return b58encode(Uint8Array.from([...payload, ...check]));
}

export async function isDemoXpub(env, k) {
  if (typeof k !== 'string' || !k.startsWith('xpub') || k.length < 100 || k.length > 120) return false;
  const raw = b58decode(k);
  if (!raw || raw.length !== 82) return false;
  const payload = raw.slice(0, 78);
  const check = (await sha256d(payload)).slice(0, 4);
  if (bytesToHex(check) !== bytesToHex(raw.slice(78))) return false;
  if (bytesToHex(payload.slice(0, 4)) !== bytesToHex(XPUB_VERSION)) return false;
  const key = payload.slice(45, 78);
  return safeEqual(bytesToHex(payload.slice(13, 21)), await tag(env, 'xpub', bytesToHex(key)));
}

export async function startDemo({ env, request, url }) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const ipHash = await sha256Hex(`${env.SECRET_KEY}:${ip}`);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM starts WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first('n');
  if (recent >= STARTS_PER_HOUR) fail(429, 'Too many demos started. Try again in an hour.');
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM sandboxes').first('n');
  if (total >= MAX_SANDBOXES) fail(503, 'The demo is busy right now. Try again later.');

  const old = await sandboxFromCookie(env, request);
  if (old) await deleteSandboxes(env, [old.id]);

  const id = uuid();
  const now = nowIso();
  const sb = {
    id, created_at: now, expires_at: addHours(now, LIFETIME_HOURS), username: 'demo-' + randomString(6, 'abcdefghijkmnpqrstuvwxyz23456789'),
    app_name: 'Aurora Coffee', spark_key: await demoSparkKey(env), spark_network: 'mainnet', spark_connected_at: now,
    webhook_secret: 'whsec_' + randomHex(24),
  };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sandboxes (id, created_at, expires_at, username, app_name, spark_key, spark_network, spark_connected_at, webhook_secret)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(sb.id, sb.created_at, sb.expires_at, sb.username, sb.app_name, sb.spark_key, sb.spark_network, sb.spark_connected_at, sb.webhook_secret),
    env.DB.prepare('INSERT INTO starts (ip_hash, created_at) VALUES (?, ?)').bind(ipHash, now),
  ]);
  await seed(env, sb);
  return new Response(null, {
    status: 303,
    headers: { Location: '/dashboard', 'Set-Cookie': await sessionCookie(env, id, url), 'Cache-Control': 'no-store' },
  });
}

const PRODUCTS = [['Espresso beans 1kg', 4.2], ['Monthly hosting', 12.5], ['Logo design', 38], ['Ebook bundle', 2.4], ['VPN 1 year', 9.9],
  ['Concert ticket', 16], ['Domain renewal', 3.1], ['Online course', 24], ['T-shirt', 5.6], ['Server credits', 18.75]];
const EMAILS = ['sara@example.com', 'omar@example.com', 'lee@example.com', 'nina@example.com', null, null];

async function seed(env, sb) {
  const now = Date.now();
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const stmts = [];
  let order = 2100;
  const refundables = [];
  for (let d = 20; d >= 0; d--) {
    const n = 1 + Math.floor(Math.random() * 3) + Math.floor((20 - d) / 7);
    for (let i = 0; i < n; i++) {
      order++;
      const [name, base] = pick(PRODUCTS);
      const amount = round8(base * pick([1, 1, 1, 2, 3]));
      let t = now - d * 86400000 - Math.floor(Math.random() * 12 * 3600000);
      if (t > now - 600000) t = now - 600000 - Math.floor(Math.random() * 3600000);
      const created = new Date(t).toISOString();
      const r = Math.random();
      const status = r < 0.78 ? 'confirmed' : r < 0.9 ? 'expired' : 'cancelled';
      const spark = fakeSparkAddress();
      const p = {
        id: uuid(), sandbox_id: sb.id, created_at: created, expires_at: new Date(t + 1800000).toISOString(), status,
        amount_firo: amount, amount_received: status === 'confirmed' ? amount : null,
        txid: status === 'confirmed' ? randomHex(32) : null, confirmations: status === 'confirmed' ? 6 : 0, required_confirmations: 2,
        detected_at: status === 'confirmed' ? created : null,
        confirmed_at: status === 'confirmed' ? new Date(t + 240000 + Math.floor(Math.random() * 300000)).toISOString() : null,
        address_type: 'spark', receiving_address: spark, spark_address: spark, transparent_address: null,
        order_id: `ORD-${order}`, order_description: name, customer_email: pick(EMAILS), collect_email: 1,
        success_url: null, cancel_url: null, metadata_json: null, extend_count: 0, webhook_sent: 0,
      };
      stmts.push(p);
      if (status === 'confirmed' && order % 17 === 0) refundables.push(p);
    }
  }
  const batch = stmts.map(p => paymentStmt(env, p));
  for (const p of refundables) {
    batch.push(env.DB.prepare('INSERT INTO refunds (id, sandbox_id, payment_id, amount_firo, txid, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uuid(), sb.id, p.id, round8(p.amount_firo / 2), null, 'Damaged item', new Date(new Date(p.confirmed_at).getTime() + 86400000).toISOString()));
  }
  const links = [['Espresso beans 1kg', 4.2, 37], ['Monthly hosting', 12.5, 12], ['Tip jar', null, 58]];
  for (const [title, amount, uses] of links) {
    batch.push(env.DB.prepare(`INSERT INTO links (id, sandbox_id, slug, title, amount_firo, fixed_amount, uses_count, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(uuid(), sb.id, randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789'), title, amount, amount === null ? 0 : 1, uses, new Date(now - 30 * 86400000).toISOString()));
  }
  const plans = [['Office coffee supply', 18, 'week', 'office@example.com', 'Bright Labs'], ['Website hosting', 12.5, 'month', 'sam@example.com', 'Sam Lee']];
  for (const [title, amount, interval, email, name] of plans) {
    batch.push(env.DB.prepare(`INSERT INTO plans (id, sandbox_id, title, amount_firo, interval, customer_email, customer_name, next_run_at, runs_count, anchor_day, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(uuid(), sb.id, title, amount, interval, email, name, new Date(now + (3 + Math.floor(Math.random() * 10)) * 86400000).toISOString(),
        1 + Math.floor(Math.random() * 5), new Date(now).getUTCDate(), new Date(now - 40 * 86400000).toISOString()));
  }
  if (batch.length) await env.DB.batch(batch);
}

export async function endDemo({ env, url, request }) {
  const sb = await sandboxFromCookie(env, request);
  if (sb) await deleteSandboxes(env, [sb.id]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
}

const TABLES = ['payments', 'refunds', 'links', 'plans', 'api_keys', 'webhook_log'];

export async function deleteSandboxes(env, ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const qs = chunk.map(() => '?').join(',');
    await env.DB.batch([
      ...TABLES.map(t => env.DB.prepare(`DELETE FROM ${t} WHERE sandbox_id IN (${qs})`).bind(...chunk)),
      env.DB.prepare(`DELETE FROM sandboxes WHERE id IN (${qs})`).bind(...chunk),
    ]);
  }
}

export async function cleanup(env) {
  const now = nowIso();
  for (let round = 0; round < 20; round++) {
    const rows = (await env.DB.prepare('SELECT id FROM sandboxes WHERE expires_at < ? LIMIT 200').bind(now).all()).results;
    if (!rows.length) break;
    await deleteSandboxes(env, rows.map(r => r.id));
  }
  await env.DB.prepare('DELETE FROM starts WHERE created_at < ?').bind(new Date(Date.now() - 86400000).toISOString()).run();
}

export async function sessionInfo({ sb }) {
  return json({ username: sb.username, created_at: sb.created_at, expires_at: sb.expires_at });
}

export async function demoKeys({ env }) {
  return json({ spark_view_key: await demoSparkKey(env), xpub: await demoXpub(env), note: 'Demo keys only work in the FiroGate demo.' });
}

export { fakeTransparentAddress };
