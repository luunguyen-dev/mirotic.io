-- schema.sql — Kho ý tưởng (Postgres). Khớp đúng db.ts → web đọc/ghi trực tiếp bảng này.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT,
  status        TEXT,          -- proposed → approved → building → demo-ready → deploy-requested → deploying → deployed  (| rejected | failed | skipped)
  idea_json     TEXT,          -- Idea (JSON) từ Prototyper
  plan_json     TEXT,          -- Plan (JSON) từ /autoplan
  result_json   TEXT,          -- Result (JSON): repoUrl, localUrl, deployedUrl, tests...
  reject_reason TEXT,
  started_at    TEXT,          -- lúc bắt đầu thực thi (cho gate 1 ý tưởng/ngày)
  error_detail  TEXT,          -- chi tiết lỗi khi status=failed
  ceo_rating    INTEGER,       -- CEO review rating (1-5 stars). Cao = ý tưởng đáng làm.
  ceo_critique  TEXT           -- CEO critique (song ngữ JSON: {en, vi})
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_detail   TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ceo_rating     INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ceo_critique   TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS builder_model      TEXT;  -- user pick trước Approve (null = auto → registry route)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS builder_model_used TEXT;  -- model thực sự dùng trong IMPLEMENT (auto-resolved từ registry)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_after        TEXT;  -- ISO ts; approved job bị skip đến khi qua mốc (rate-limit reset)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS total_cost_usd     DOUBLE PRECISION;  -- USD Claude CLI report cộng dồn qua 4 gstack sessions
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS total_turns        INTEGER;           -- turns cộng dồn qua 4 gstack sessions
CREATE INDEX IF NOT EXISTS jobs_status_rating_idx ON jobs (status, ceo_rating DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx  ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at DESC);

-- idea_pool: candidates Prototyper gom được nhưng KHÔNG promoted thành job hôm nay.
-- Mỗi sáng batch 5-10 candidates → top-3 vào jobs(status=proposed), số còn lại vào pool.
-- Bạn có thể promote pool→jobs thủ công khi review.
CREATE TABLE IF NOT EXISTS idea_pool (
  id          TEXT PRIMARY KEY,        -- slug + nguồn
  created_at  TEXT,
  title       TEXT,
  pitch       TEXT,
  why         TEXT,
  source      TEXT,
  url         TEXT,
  type        TEXT,
  score       REAL,                     -- điểm Ollama rank (0..1), cao = tốt
  promoted    BOOLEAN DEFAULT FALSE,    -- true khi đã chuyển sang bảng jobs
  -- Song ngữ (Ollama translate title/pitch, Prototyper tự tạo why 2 ngôn ngữ).
  title_vi    TEXT,  pitch_vi TEXT,  why_vi TEXT,
  title_en    TEXT,  pitch_en TEXT,  why_en TEXT,
  ceo_rating  INTEGER,
  ceo_critique TEXT
);
CREATE INDEX IF NOT EXISTS idea_pool_score_idx ON idea_pool (score DESC) WHERE promoted = FALSE;

-- P1 — projects + issues (idea đã promote thành dự án long-lived).
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  source_job_id TEXT REFERENCES jobs(id),
  slug          TEXT NOT NULL, title TEXT NOT NULL, title_vi TEXT,
  description   TEXT, status TEXT DEFAULT 'active',
  repo_url      TEXT, prod_domain TEXT, staging_domain TEXT,
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_idx ON projects (slug);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, target_date TEXT, status TEXT DEFAULT 'planned',
  ordinal INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id),
  title TEXT NOT NULL, title_vi TEXT, description TEXT, description_vi TEXT,
  type TEXT DEFAULT 'feature',   -- feature|bug|chore|spike|adr
  status TEXT DEFAULT 'backlog', -- backlog|ready|in_progress|review|shipped|dropped
  priority TEXT DEFAULT 'p2', parent_issue_id TEXT REFERENCES issues(id),
  builder_model TEXT, ceo_rating INTEGER, ceo_critique TEXT,
  branch_name TEXT, pr_url TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_project_status_idx ON issues (project_id, status);
CREATE INDEX IF NOT EXISTS issues_priority_idx ON issues (project_id, priority);

-- job_logs: log từng dòng của executor (Claude/gstack output, builder verify, ship.sh)
CREATE TABLE IF NOT EXISTS job_logs (
  id     BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  ts     TEXT NOT NULL,
  level  TEXT,        -- info | tool | result | summary | error
  line   TEXT
);
CREATE INDEX IF NOT EXISTS job_logs_job_idx ON job_logs (job_id, id);

-- system_events: batch-level activity không gắn với 1 job cụ thể.
-- Actor = prototyper | ceo | planner | poller | auto-approve | deployer.
CREATE TABLE IF NOT EXISTS system_events (
  id     BIGSERIAL PRIMARY KEY,
  ts     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  level  TEXT DEFAULT 'info',   -- info | summary | error
  line   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS system_events_id_idx ON system_events (id DESC);

-- model_cooldowns: per-model rate-limit tracking, survive worker restart.
CREATE TABLE IF NOT EXISTS model_cooldowns (
  model TEXT PRIMARY KEY, cooldown_until TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_cooldowns_until_idx ON model_cooldowns (cooldown_until);
