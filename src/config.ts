/**
 * config.ts — Env → CONFIG object. Load 1 lần ở top-level, các module import.
 */

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d = false) => (process.env[k] ?? String(d)) === "true";

const DATA_DIR = env("DATA_DIR", "./data");

export const CONFIG = {
  port: Number(env("PORT", "4321")),
  baseUrl: env("BASE_URL", "http://localhost:4321"),
  hmacSecret: env("HMAC_SECRET", "change-me-in-prod"),
  morningAt: env("MORNING_AT", "07:00"),
  pollIntervalMin: Number(env("POLL_INTERVAL_MIN", "5")),
  dailyBuildLimit: Number(env("DAILY_BUILD_LIMIT", "3")),
  buildWindowHours: Number(env("BUILD_WINDOW_HOURS", "24")),
  githubOwner: env("GITHUB_OWNER", "you"),
  awsHost: env("AWS_HOST", "your-ec2-host"),
  dataDir: DATA_DIR,
  outbox: `${DATA_DIR}/outbox`,
  builds: `${DATA_DIR}/builds`,
  useRealClaude: bool("USE_REAL_CLAUDE", false),
  // Model per role/skill — legacy env kept for BUILDER_CHOICES + text fallback.
  modelPrototyper: env("MODEL_PROTOTYPER", env("MODEL_GATHERER", "claude-haiku-4-5-20251001")),
  modelCeo:      env("MODEL_CEO",      "claude-sonnet-4-6"),
  modelPlanner:  env("MODEL_PLANNER",  "claude-haiku-4-5-20251001"),
  modelBuilder:  env("MODEL_BUILDER",  "claude-sonnet-4-6"),
  modelReviewer: env("MODEL_REVIEWER", "claude-haiku-4-5-20251001"),
  modelCso:      env("MODEL_CSO",      "claude-sonnet-4-6"),
  modelQa:       env("MODEL_QA",       "claude-haiku-4-5-20251001"),
  resendApiKey: env("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM", "mirotic@example.com"),
  emailTo: env("EMAIL_TO"),
};

// Web static files root (relative to project root at runtime).
export const WEB_DIR = env("WEB_DIR", "./web");
// Templates for Builder output projects.
export const TEMPLATES_DIR = env("TEMPLATES_DIR", "./templates");
