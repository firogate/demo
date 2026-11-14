import { escapeHtml } from './util.js';
import { sandboxFromCookie } from './sandbox.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TABS = ['home', 'api', 'payments', 'security', 'account', 'analytics', 'wallet', 'recurring'];
const SUB_TABS = ['payments', 'analytics'];
const SUB = /^[A-Za-z0-9_-]{1,64}$/;
const PREVIEW_CSS = '<style>.st-wrap{display:none!important}#v2-themes{display:block!important}</style>';

async function asset(env, request, path) {
  const u = new URL(request.url);
  u.pathname = path;
  u.search = '';
  const r = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
  return r.ok ? r.text() : null;
}

export function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...extra,
    },
  });
}

const redirect = (to, status = 302) => new Response(null, { status, headers: { Location: to, 'Cache-Control': 'no-store' } });

async function page(env, request, name) {
  const body = await asset(env, request, `/_pages/${name}`);
  return body === null ? html('Not found', 404) : html(body);
}

export const pages = {
  async home({ env, request }) {
    const sb = await sandboxFromCookie(env, request);
    let body = await asset(env, request, '/_pages/start.html');
    if (body === null) return html('Not found', 404);
    body = body.replace('@@HAS_SESSION@@', sb ? '1' : '0');
    return html(body);
  },

  async dashboard({ env, request, params }) {
    const sb = await sandboxFromCookie(env, request);
    if (!sb) return redirect('/');
    const tab = TABS.includes(params.tab) ? params.tab : 'home';
    const sub = params.sub && SUB_TABS.includes(tab) && SUB.test(params.sub) ? params.sub : '';
    if (params.sub && !sub) return redirect('/dashboard');
    let body = await asset(env, request, '/_pages/dashboard.html');
    if (body === null) return html('Not found', 404);
    body = body.replace('"@@ACTIVE_TAB@@"', JSON.stringify(tab)).replace('"@@ACTIVE_SUB@@"', JSON.stringify(sub));
    return html(body);
  },

  async invoice({ env, request, url, params }) {
    const id = params.id;
    if (id !== 'preview' && !UUID.test(id)) return redirect('/');
    let body = await asset(env, request, '/_pages/checkout.html');
    if (body === null) return html('Not found', 404);
    body = body.replace('@@PAYMENT_ID@@', id);
    const layout = url.searchParams.get('layout') || '';
    if (id === 'preview' && layout && layout !== 'stripe') body = body.replace('</head>', PREVIEW_CSS + '</head>');
    return html(body);
  },

  async checkoutRedirect({ url, params }) {
    if (params.id === 'preview') return pages.invoice(arguments[0]);
    return redirect(`/invoice/${encodeURIComponent(params.id)}${url.search}`);
  },

  async paylink({ env, request, params }) {
    const l = await env.DB.prepare('SELECT * FROM links WHERE slug = ?').bind(params.slug).first();
    if (!l || !l.is_active || (l.expires_at && new Date(l.expires_at) < new Date())) return redirect('/');
    const sb = await env.DB.prepare('SELECT show_market_price FROM sandboxes WHERE id = ?').bind(l.sandbox_id).first();
    const fixed = !!(l.fixed_amount && l.amount_firo);
    const name = `paylink-${+fixed}${+!!l.collect_email}${+!!(sb && sb.show_market_price)}.html`;
    let body = await asset(env, request, `/_pages/${name}`);
    if (body === null) return html('Not found', 404);
    const title = escapeHtml(l.title);
    body = body.split('@@TITLE@@').join(title).split('@@SLUG@@').join(l.slug);
    if (l.description) body = body.replace('@@DESC@@', escapeHtml(l.description));
    else body = body.replace(/<p class="pl-desc" id="linkDesc">@@DESC@@<\/p>/, '');
    if (fixed) body = body.split('7777.123').join(String(l.amount_firo));
    return html(body);
  },

  docs: ({ env, request }) => page(env, request, 'docs.html'),
  about: ({ env, request }) => page(env, request, 'about.html'),
  changelog: ({ env, request }) => page(env, request, 'changelog.html'),
  themePreview: ({ env, request }) => page(env, request, 'theme-preview.html'),
  toHome: () => redirect('/'),
};
