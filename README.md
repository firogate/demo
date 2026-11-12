# FiroGate Demo

A public, demo-only copy of FiroGate CE that runs on Cloudflare Workers + D1.
Anyone can open it, press **Start demo**, and try the real dashboard, checkout,
pay links and API with fake money. No real FIRO, no Firo node, no emails.

- One tap starts a private sandbox with sample data. It is deleted after 24 hours.
- Demo API keys (`fg_demo_…`) work with the same API as CE.
- Demo Spark view keys and xpubs look like real ones (full length, valid xpub checksum)
  but carry a hidden signature only this demo accepts. Real keys are always refused.
- Every checkout has a **Simulate payment** button. Payments confirm in about 10 seconds.
- Webhooks are real HTTPS calls, signed exactly like CE (200 per sandbox per day).
  The dashboard shows recent deliveries with status code and payload. With no
  webhook saved, nothing is sent and the checkout says so.

## How it works

The pages are CE's own templates. `build/render.py` renders them from a
`firogate-ce` checkout into `public/`, so the demo always looks like CE.
The Worker (`src/`) answers every API call from D1 instead of a Firo node.

```
build/render.py   renders CE pages + copies CE static files into public/
demo-assets/      demo-only files: start page, demo bar, demo styles
src/worker.js     routes
src/payments.js   payments, checkout, simulated confirmations
src/merchant.js   dashboard API (keys, links, recurring, refunds, analytics, theme, wallet)
src/sandbox.js    one-click sandboxes, sample data, cleanup
schema.sql        D1 tables
```

## Run locally

Needs Node 20+, Python 3 with `jinja2`, and `firogate-ce` next to this folder.

```bash
npm install
npm run build          # renders ../firogate-ce into public/
npm run dev            # http://127.0.0.1:8787
```

`.dev.vars` holds the local `SECRET_KEY`. Tables are created automatically on first request.

## Secrets

Only one secret is needed:

| Name | What |
|---|---|
| `SECRET_KEY` | Any random string, 32 characters or more. Signs sessions, checkout links and demo keys. |

Create one with `openssl rand -hex 32`. Changing it signs everyone out and makes old demo keys invalid.
No email, Telegram, Firebase or Firo node credentials are used.

## Deploy

The rendered pages in `public/` are committed, so Cloudflare deploys the repo as is.
Run `npm run build` before pushing whenever CE changes.

1. Cloudflare dashboard → Storage & Databases → D1 → create a database named `firogate-demo`.
   Put its ID in `wrangler.toml` as `database_id`.
2. Workers & Pages → the Worker → Settings → Variables and Secrets → add secret `SECRET_KEY`.
3. The Worker name must be `firogate-demo` (same as `name` in `wrangler.toml`).
4. Push to `main`. Cloudflare runs `npx wrangler deploy`. The custom domain `demo.firogate.com` is in `wrangler.toml`.

## Updating from CE

After changing CE, run `npm run build` again and deploy. If CE adds a new API
route, add it to `src/worker.js`.

## Limits

| What | Limit |
|---|---|
| Sandbox life | 24 hours |
| New demos per visitor | 6 per hour |
| Sandboxes at once | 3,000 |
| Payments per sandbox | 1,000 |
| Pay links / recurring / API keys | 50 / 20 / 10 |
| Webhooks | 200 per sandbox per day, HTTPS only |
