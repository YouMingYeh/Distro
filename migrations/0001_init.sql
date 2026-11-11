CREATE TABLE IF NOT EXISTS brand_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT,
  brief_md TEXT,
  site_url TEXT,
  site_excerpt TEXT,
  scrape_ok INTEGER,
  niche TEXT,
  audience TEXT,
  tone TEXT,
  platform TEXT DEFAULT 'TikTok',
  cta TEXT,
  competitors_json TEXT,
  avoid_claims_json TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  token TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  declared_size INTEGER,
  sha256 TEXT,
  mode TEXT NOT NULL,          -- worker|presigned
  status TEXT NOT NULL,        -- pending|complete|expired|rejected
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,         -- asset_id ast_...
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,          -- footage|highlight|ad_body|screenshot|audio|final|thumb|other
  original_filename TEXT,
  source TEXT,                 -- chat_upload|bulk|generated
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  has_audio INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  warnings_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  platform TEXT,
  posted_within_days INTEGER,
  calls_used INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  research_id TEXT,
  hook_type TEXT,
  format_family TEXT,
  why TEXT NOT NULL,          -- original paraphrase only
  brand_angle TEXT,
  evidence_json TEXT,         -- no verbatim source transcripts
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  pattern_id TEXT,
  hook TEXT NOT NULL,
  body TEXT,
  cta TEXT,
  footage_hints_json TEXT,
  want_talking_head INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_scores (
  hook_id TEXT NOT NULL,
  pointwise_avg REAL,
  elo REAL,
  reasons_json TEXT,
  rank INTEGER,
  PRIMARY KEY (hook_id)
);

CREATE TABLE IF NOT EXISTS rank_runs (
  id TEXT PRIMARY KEY,
  research_id TEXT,
  brand TEXT,
  n INTEGER,
  cost_cents INTEGER,
  discarded_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  hook_id TEXT,
  status TEXT NOT NULL,
  step TEXT,
  params_json TEXT,
  estimated_cents INTEGER,
  reserved_cents INTEGER,
  actual_cents INTEGER,
  gmi_request_id TEXT,
  final_r2_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sanity_checks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  verdict TEXT NOT NULL,      -- pass|fixed|discard
  items_json TEXT NOT NULL,
  actions_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,         -- reserve|commit|release
  cents INTEGER NOT NULL,
  job_id TEXT,
  model TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS darkugc_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  day TEXT NOT NULL           -- YYYY-MM-DD in a fixed timezone, e.g. UTC
);

CREATE TABLE IF NOT EXISTS publish_drafts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);

-- Small key/value store (cached DarkUGC filters, refreshed OAuth tokens).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_hooks_run ON hooks(run_id);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
