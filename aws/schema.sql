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
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS builder_model  TEXT;  -- user pick trước Approve (null = CONFIG.modelBuilder)
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

-- job_logs: log từng dòng của executor (Claude/gstack output, builder verify, ship.sh)
CREATE TABLE IF NOT EXISTS job_logs (
  id     BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  ts     TEXT NOT NULL,
  level  TEXT,        -- info | tool | result | summary | error
  line   TEXT
);
CREATE INDEX IF NOT EXISTS job_logs_job_idx ON job_logs (job_id, id);
