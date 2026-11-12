CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  username TEXT NOT NULL,
  app_name TEXT,
  app_name_change_count INTEGER NOT NULL DEFAULT 0,
  app_name_last_changed_at TEXT,
  app_logo TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  webhook_day TEXT,
  webhook_count INTEGER NOT NULL DEFAULT 0,
  show_market_price INTEGER NOT NULL DEFAULT 1,
  has_seen_onboarding INTEGER NOT NULL DEFAULT 1,
  required_confirmations_policy INTEGER,
  pay_spark_enabled INTEGER NOT NULL DEFAULT 1,
  pay_transparent_enabled INTEGER NOT NULL DEFAULT 1,
  pay_default_method TEXT NOT NULL DEFAULT 'spark',
  spark_key TEXT,
  spark_network TEXT,
  spark_connected_at TEXT,
  xpub TEXT,
  xpub_first TEXT,
  xpub_next INTEGER NOT NULL DEFAULT 0,
  xpub_connected_at TEXT,
  theme_json TEXT,
  telegram_connected INTEGER NOT NULL DEFAULT 0,
  notify_telegram INTEGER NOT NULL DEFAULT 0,
  analytics_reset_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sandboxes_expires ON sandboxes (expires_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_firo REAL NOT NULL,
  amount_received REAL,
  txid TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL DEFAULT 2,
  detected_at TEXT,
  confirmed_at TEXT,
  address_type TEXT NOT NULL DEFAULT 'spark',
  receiving_address TEXT NOT NULL,
  spark_address TEXT,
  transparent_address TEXT,
  order_id TEXT,
  order_description TEXT,
  customer_email TEXT,
  collect_email INTEGER NOT NULL DEFAULT 1,
  success_url TEXT,
  cancel_url TEXT,
  metadata_json TEXT,
  extend_count INTEGER NOT NULL DEFAULT 0,
  webhook_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payments_sandbox ON payments (sandbox_id, created_at);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_firo REAL NOT NULL,
  txid TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_refunds_sandbox ON refunds (sandbox_id);
CREATE INDEX IF NOT EXISTS ix_refunds_payment ON refunds (payment_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  amount_firo REAL,
  fixed_amount INTEGER NOT NULL DEFAULT 1,
  collect_email INTEGER NOT NULL DEFAULT 1,
  success_url TEXT,
  cancel_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  uses_count INTEGER NOT NULL DEFAULT 0,
  cancel_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_links_sandbox ON links (sandbox_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  amount_firo REAL NOT NULL,
  interval TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_link_id TEXT,
  anchor_day INTEGER,
  runs_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_plans_sandbox ON plans (sandbox_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  scopes TEXT NOT NULL DEFAULT '*',
  created_at TEXT NOT NULL,
  last_used TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_keys_sandbox ON api_keys (sandbox_id);

CREATE TABLE IF NOT EXISTS starts (
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_starts ON starts (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS webhook_log (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  payment_id TEXT,
  event TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_webhook_log_sandbox ON webhook_log (sandbox_id, created_at);
CREATE INDEX IF NOT EXISTS ix_webhook_log_payment ON webhook_log (payment_id);
