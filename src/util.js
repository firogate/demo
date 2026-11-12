const enc = new TextEncoder();

export class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : 'error');
    this.status = status;
    this.detail = detail;
  }
}

export const fail = (status, detail) => { throw new HttpError(status, detail); };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export const noContent = () => new Response(null, { status: 204 });

export const nowIso = () => new Date().toISOString();
export const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
export const addHours = (iso, h) => addMinutes(iso, h * 60);

export const uuid = () => crypto.randomUUID();

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(n, alphabet = ALNUM) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(secret, text) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacB64url(secret, text, bytes = 12) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text))).slice(0, bytes);
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sanitize(s, max) {
  if (s == null) return null;
  const v = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
  return v || null;
}

export function validateAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(422, 'Amount must be greater than 0');
  if (n > 1000000) fail(422, 'Amount is too large');
  return Math.round(n * 1e8) / 1e8;
}

export function validateUrl(v, label = 'URL') {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let u;
  try { u = new URL(s); } catch { fail(422, `${label} must be a valid URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(422, `${label} must start with https://`);
  if (s.length > 2048) fail(422, `${label} is too long`);
  return s;
}

export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

export function bool(v) { return !!v; }

export function round8(n) { return Math.round((Number(n) || 0) * 1e8) / 1e8; }

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
