import { HttpError, json, fail } from './util.js';
import SCHEMA from '../schema.sql';
import { resolveAuth, checkScope, startDemo, endDemo, cleanup, sessionInfo, demoKeys, sandboxFromCookie } from './sandbox.js';
import { merchantRoutes as pay, publicRoutes as pub } from './payments.js';
import { account, keys, links, recurring, refunds, analytics, theme, wallet, merchantEvents, webhookLog } from './merchant.js';
import { pages, html } from './pages.js';

const PUBLIC = 'public';
const SESSION = 'session';

const routes = [];
const add = (method, pattern, auth, handler, scope = null) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, names, auth, handler, scope });
};

add('GET', '/', PUBLIC, pages.home);
add('POST', '/start', PUBLIC, startDemo);
add('GET', '/dashboard', PUBLIC, pages.dashboard);
add('GET', '/dashboard/:tab', PUBLIC, pages.dashboard);
add('GET', '/invoice/:id', PUBLIC, pages.invoice);
add('GET', '/checkout/:id', PUBLIC, pages.checkoutRedirect);
add('GET', '/pay/:slug', PUBLIC, pages.paylink);
add('GET', '/docs', PUBLIC, pages.docs);
add('GET', '/about', PUBLIC, pages.about);
add('GET', '/changelog', PUBLIC, pages.changelog);
add('GET', '/theme-preview', PUBLIC, pages.themePreview);
for (const p of ['/login', '/register', '/report', '/admin']) add('GET', p, PUBLIC, pages.toHome);
add('GET', '/health', PUBLIC, () => json({ status: 'ok', node: 'online', db: 'ok', mode: 'demo' }));
add('GET', '/api/health', PUBLIC, () => json({ status: 'ok', mode: 'demo' }));
add('GET', '/api/price', PUBLIC, price);
add('POST', '/api/i18n/set', PUBLIC, () => json({ ok: true }));

add('GET', '/api/demo/session', SESSION, sessionInfo);
add('GET', '/api/demo/keys', PUBLIC, demoKeys);
add('POST', '/api/demo/simulate/:id', PUBLIC, pub.simulate);
add('GET', '/api/demo/webhook-result/:id', PUBLIC, pub.webhookResult);
add('GET', '/api/demo/webhooks', SESSION, webhookLog);

add('GET', '/api/auth/me', SESSION, account.me);
add('POST', '/api/auth/refresh', PUBLIC, async ({ env, request }) => (await sandboxFromCookie(env, request)) ? json({ ok: true }) : json({ detail: 'Not authenticated' }, 401));
add('POST', '/api/auth/logout', PUBLIC, endDemo);
for (const p of ['/api/auth/login', '/api/auth/register', '/api/auth/login-number', '/api/auth/register-number', '/api/auth/fb/google']) {
  add('POST', p, PUBLIC, () => fail(403, 'The demo signs you in with one tap.'));
}
add('GET', '/api/auth/2fa/status', SESSION, account.tfaStatus);
for (const p of ['/api/auth/2fa/setup', '/api/auth/2fa/verify', '/api/auth/2fa/disable', '/api/auth/recovery/regenerate-codes']) add('POST', p, SESSION, account.tfaBlocked);

add('GET', '/api/users/profile', SESSION, account.profile);
add('POST', '/api/users/onboarding/seen', SESSION, account.onboardingSeen);
add('POST', '/api/users/onboarding/restart', SESSION, account.onboardingRestart);
add('GET', '/api/users/webhook-secret', SESSION, account.webhookSecret);
add('GET', '/api/users/account-number', SESSION, account.accountNumber);
add('PATCH', '/api/users/webhook', SESSION, account.setWebhook);
add('PATCH', '/api/users/payment-policy', SESSION, account.paymentPolicy);
add('POST', '/api/users/regenerate-api-key', SESSION, account.regenerateApiKey);
add('POST', '/api/users/regenerate-webhook-secret', SESSION, account.regenerateSecret);
add('GET', '/api/users/password-status', SESSION, account.passwordStatus);
add('POST', '/api/users/change-password', SESSION, account.changePassword);
add('GET', '/api/users/sales', SESSION, account.sales);
add('GET', '/api/users/privacy-status', SESSION, account.privacyStatus);
add('PATCH', '/api/users/market-price-setting', SESSION, account.marketPrice);
add('GET', '/api/users/telegram-status', SESSION, account.telegramStatus);
add('POST', '/api/users/telegram-connect', SESSION, account.telegramConnect);
add('DELETE', '/api/users/telegram-connect', SESSION, () => json({ message: 'Telegram disconnected.' }));
add('PATCH', '/api/users/telegram-notify', SESSION, account.telegramNotify);
add('GET', '/api/users/app-name', SESSION, account.getAppName);
add('POST', '/api/users/app-name', SESSION, account.setAppName);
add('GET', '/api/users/app-logo', SESSION, account.getLogo);
add('POST', '/api/users/app-logo', SESSION, account.setLogo);
add('DELETE', '/api/users/app-logo', SESSION, account.deleteLogo);
add('POST', '/api/users/test-webhook', SESSION, account.testWebhook);

add('GET', '/api/reports/mine', PUBLIC, account.reportsMine);
add('POST', '/api/reports', PUBLIC, account.reportsCreate);

add('GET', '/api/keys', SESSION, keys.list);
add('POST', '/api/keys', SESSION, keys.create);
add('PATCH', '/api/keys/:id', SESSION, keys.rename);
add('DELETE', '/api/keys/:id', SESSION, keys.revoke);

add('POST', '/api/payments/create', 'merchant', pay.create, 'create_invoice');
add('POST', '/api/payments', 'merchant', pay.create, 'create_invoice');
add('GET', '/api/payments', 'merchant', pay.list, 'read_invoice');
add('GET', '/api/payments/search', 'merchant', pay.search, 'read_invoice');
add('GET', '/api/payments/export', 'merchant', pay.exportCsv, 'read_invoice');
add('GET', '/api/payments/summary', 'merchant', pay.summary, 'read_analytics');
add('GET', '/api/payments/by-vendor', 'merchant', pay.byVendor, 'read_analytics');
add('GET', '/api/payments/public/:id', PUBLIC, pub.status);
add('POST', '/api/payments/public/:id/email', PUBLIC, pub.email);
add('POST', '/api/payments/public/:id/method', PUBLIC, pub.method);
add('POST', '/api/payments/public/:id/verify-hash', PUBLIC, pub.verifyHash);
add('POST', '/api/payments/public/:id/extend', PUBLIC, pub.extend);
add('GET', '/api/payments/public/:id/receipt', PUBLIC, pub.receipt);
add('GET', '/api/payments/public/:id/qr', PUBLIC, pub.qr);
add('POST', '/api/payments/public/:id/cancel', PUBLIC, pub.cancel);
add('GET', '/api/payments/:id/refunds', 'merchant', refunds.list);
add('POST', '/api/payments/:id/refunds', 'merchant', refunds.create);
add('POST', '/api/payments/:id/simulate', 'merchant', pay.simulate, 'create_invoice');
add('GET', '/api/payments/:id', 'merchant', pay.get, 'read_invoice');
add('DELETE', '/api/refunds/:id', 'merchant', refunds.remove);
add('GET', '/api/refunds/summary', 'merchant', refunds.summary);

add('GET', '/api/recurring', 'merchant', recurring.list);
add('POST', '/api/recurring', 'merchant', recurring.create);
add('PATCH', '/api/recurring/:id', 'merchant', recurring.patch);
add('POST', '/api/recurring/:id/send-now', 'merchant', recurring.sendNow);
add('DELETE', '/api/recurring/:id', 'merchant', recurring.remove);

add('GET', '/api/payment-links', SESSION, links.list);
add('POST', '/api/payment-links', SESSION, links.create);
add('PATCH', '/api/payment-links/:id/toggle', SESSION, links.toggle);
add('DELETE', '/api/payment-links/:id', SESSION, links.remove);
add('GET', '/api/payment-links/export/csv', SESSION, links.exportCsv);
add('GET', '/api/payment-links/notifications/settings', SESSION, links.notifySettings);
add('PATCH', '/api/payment-links/notifications/settings', SESSION, links.notifySettingsSave);
add('GET', '/api/payment-links/public/:slug', PUBLIC, links.publicGet);
add('POST', '/api/payment-links/public/:slug/checkout', PUBLIC, links.publicCheckout);

add('GET', '/api/analytics/user', SESSION, analytics.user);
add('GET', '/api/analytics/user/history', SESSION, analytics.history);
add('GET', '/api/analytics/user/hourly', SESSION, analytics.hourly);
add('POST', '/api/analytics/user/reset', SESSION, analytics.reset);

add('GET', '/api/theme/presets', PUBLIC, theme.presets);
add('GET', '/api/theme', SESSION, theme.get);
add('PUT', '/api/theme', SESSION, theme.save);
add('DELETE', '/api/theme', SESSION, theme.reset);
add('POST', '/api/theme/preview', SESSION, theme.preview);
add('GET', '/api/theme/thumbnails', PUBLIC, theme.thumbnails);
add('POST', '/api/theme/thumbnail/:id', SESSION, theme.thumbnailUpload);

add('GET', '/api/xpub/status', 'merchant', wallet.xpubStatus);
add('POST', '/api/xpub/preview', 'merchant', wallet.xpubPreview);
add('POST', '/api/xpub/connect', 'merchant', wallet.xpubConnect);
add('PATCH', '/api/xpub/methods', 'merchant', wallet.methods);
add('POST', '/api/xpub/disconnect', 'merchant', wallet.xpubDisconnect);
add('GET', '/spark/status', 'merchant', wallet.sparkStatus);
add('POST', '/spark/connect', 'merchant', wallet.sparkConnect);
add('POST', '/spark/disconnect', 'merchant', wallet.sparkDisconnect);

add('GET', '/api/events/payment/:id', PUBLIC, pub.events);
add('GET', '/api/events/merchant', SESSION, merchantEvents);

async function price({ ctx }) {
  const cache = caches.default;
  const key = new Request('https://demo.cache/firo-price');
  let hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  try {
    const r = await fetch('https://api.mexc.com/api/v3/ticker/price?symbol=FIROUSDT', { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const p = parseFloat(d.price);
    if (!(p > 0)) throw new Error('bad price');
    const res = json({ price: p, symbol: 'FIRO/USDT', source: 'MEXC' }, 200, { 'Cache-Control': 'public, max-age=60' });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch {
    return json({ price: null, error: 'Price unavailable' }, 503);
  }
}

function match(method, path) {
  let allowed = false;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return allowed ? 'method' : null;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

function sameOrigin(request, url) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  if (request.headers.get('x-api-key')) return true;
  const origin = request.headers.get('Origin');
  if (!origin) return !request.headers.get('Cookie');
  return origin === url.origin;
}

let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    const statements = SCHEMA.split(';').map(x => x.trim()).filter(Boolean).map(x => env.DB.prepare(x));
    schemaReady = env.DB.batch(statements).catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/') && !path.startsWith('/static/')) path = path.slice(0, -1);
  if (path.startsWith('/static/') || path === '/favicon.ico' || path === '/robots.txt') {
    if (path === '/favicon.ico') url.pathname = '/static/favicon.ico';
    const res = await env.ASSETS.fetch(new Request(url.toString(), request));
    const out = new Response(res.body, res);
    if (res.ok && url.searchParams.has('v')) out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return out;
  }
  if (path.startsWith('/_pages/')) return html('Not found', 404);

  await ensureSchema(env);
  const found = match(request.method, path);
  if (!found) return path.startsWith('/api/') ? json({ detail: 'Not Found' }, 404) : html('Not found', 404);
  if (found === 'method') return json({ detail: 'Method Not Allowed' }, 405);
  if (!sameOrigin(request, url)) return json({ detail: 'Cross-site request blocked' }, 403);

  const { route, params } = found;
  const c = { env, ctx, request, url, params, sb: null, apiKey: null };
  if (route.auth !== PUBLIC) {
    const auth = await resolveAuth(env, request);
    if (!auth) return json({ detail: 'missing credentials' }, 401);
    if (route.auth === SESSION && auth.apiKey) return json({ detail: 'Use the dashboard for this. API keys cannot call it.' }, 403);
    c.sb = auth.sb;
    c.apiKey = auth.apiKey;
    if (route.scope) checkScope(c.apiKey, route.scope);
  }
  return route.handler(c);
}

export default {
  async fetch(request, env, ctx) {
    if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
      return new Response('Demo is not set up yet: add the SECRET_KEY secret.', { status: 503 });
    }
    try {
      return withHeaders(await handle(request, env, ctx));
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(json({ detail: e.detail }, e.status));
      console.error(e && e.stack || e);
      return withHeaders(json({ detail: 'Something went wrong. Try again.' }, 500));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => cleanup(env)));
  },
};
