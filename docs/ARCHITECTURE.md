# Mirotic Architecture

Mirotic là orchestrator "idea → demo → project" chạy trên 2 host:

- **Mac (worker)**: `src/index.ts worker` — poll DB, run Prototyper batch, spawn Builder sessions qua Claude Code / Codex CLI. Cần OAuth Claude Max ở Keychain.
- **EC2 (dashboard)**: `src/index.ts serve` — Bun.serve HTTP, phục vụ `/ideas` + `/projects` HTML, expose `/api/*`. Không cần Claude auth.

Cả 2 chia sẻ **Postgres trên EC2** — worker và dashboard đọc/ghi cùng schema.

## Sơ đồ luồng

```
   Prototyper (07:00 VN)              CEO review              Builder (per job)
 ┌──────────────────────┐  batchCollect  ┌────────────────┐   ┌──────────────────────────┐
 │ HN + GH + PH signals ├───────────────►│ ceoReview      ├──►│ IMPLEMENT (Sonnet/Opus)  │
 │ Gemini/Opus synth 10 │               │ 1-5⭐ + critique │   │ REVIEW    (Sonnet/Haiku) │
 └──────────────────────┘               └────────────────┘   │ CSO       (Sonnet)       │
                                                             │ QA        (Haiku/GPT)    │
                                                             └──────┬───────────────────┘
                                                                    ▼
                                                          demo-ready + repo + local :port
                                                                    │
                                                                    ▼ user: Deploy on dashboard
                                                             ┌──────────────────┐
                                                             │ ship.sh          │
                                                             │ rsync → EC2      │
                                                             │ docker compose up│
                                                             │ Caddy site block │
                                                             └──────────────────┘
                                                                    ▼
                                                          https://<slug>.luunguyen.dev
```

## Tầng model (2 tier)

| Tier | Task | Model pool | Router hint |
|---|---|---|---|
| **agentic** | gstack `/review`, `/cso`, `/qa`, IMPLEMENT | Opus 4.8 / Sonnet 5 / GPT-5.5 (Codex) | `complexity` từ CEO rating |
| **text** | Prototyper synth, CEO critique, plan refine | Opus 4.8 / Sonnet 5 / GPT-5.5 / Gemini Pro/Flash / qwen3:8b | `role`: gatherer/ceo/planner |

Router: `src/llm/registry.ts::pickModel(tier, hint)` — chọn model đầu tiên không cooldown theo priority list.  
Cooldown persistence: bảng `model_cooldowns` (ISO ts). Detect qua `parseRateLimitReset` khi Claude/OpenAI trả "session limit resets 12pm".

## Layout mã

```
mirotic.io/
├── src/
│   ├── index.ts            # entry point + main dispatch + runBuild + startServer + poll cycle
│   ├── config.ts           # CONFIG object từ env
│   ├── types.ts            # Idea, Plan, Result, PlanStep, ProjectType
│   ├── db/                 # Postgres/SQLite backend + methods
│   ├── llm/
│   │   ├── index.ts        # Router callLLM (Claude CLI / Codex / Gemini REST / Ollama)
│   │   └── registry.ts     # Model priority + cooldown state
│   ├── prototyper/         # Signal collection + LLM synthesis (10 ideas / morning)
│   ├── executor/
│   │   ├── ceo.ts          # CEO review + text tier wrapper
│   │   └── planner.ts      # BASE_STEPS + generateDetailedPlan + updatePlanStep
│   ├── util/
│   │   ├── logger.ts       # jLog (console + job_logs)
│   │   ├── rate-limit.ts   # parseRateLimitReset (Asia/Saigon → UTC)
│   │   └── email.ts        # Resend or outbox mock
│   └── api/
│       └── hmac.ts         # sign/verify + BUILDER_CHOICES + ACTIONS
├── web/
│   ├── ideas.html          # /ideas kanban 7 columns
│   └── projects.html       # /projects list + detail
├── infra/
│   ├── docker/
│   │   ├── Dockerfile
│   │   ├── dashboard.compose.yml   # deploy dashboard trên EC2
│   │   └── docker-compose.dev.yml  # local dev
│   ├── aws/
│   │   ├── schema.sql               # Postgres schema
│   │   ├── setup-caddy.sh
│   │   ├── setup-dashboard.sh
│   │   └── setup-db.sh
│   └── mac/
│       ├── io.mirotic.plist
│       └── install-launchd.sh
├── scripts/
│   ├── inject-idea.ts       # Dev utility: chèn idea thủ công
│   └── setup.sh             # End-to-end env check + docker up
├── templates/
│   └── ship.sh.tmpl         # Builder output projects paste vào repo
├── docs/
│   ├── README.md            # Overview + Quick start
│   ├── SETUP.md             # Từng biến env, cách lấy
│   └── ARCHITECTURE.md      # File này
└── data/                    # gitignored — SQLite dev, builds/, outbox/
```

## State machine (jobs table)

```
proposed ──approve──► approved ──poller claim──► building ──runBuild──► demo-ready ──deploy──► deploy-requested ──ship.sh──► deployed
   │                     │                          │                       │                      │
   ├──reject──► rejected │                          │                       ├──promote──► (project created)
   │                     │                          │                       │
   │                     │──rate-limit-parsed──►    │──build fail──► failed
   │                                                │
   │                                                └──runAgenticWithFallback attempt ≤ 4
```

Đọc thêm:
- Rolling 24h build gate: `pollOnce` trong `src/index.ts` — max `DAILY_BUILD_LIMIT` builds/window.
- Manual retry: HMAC `/retry/:id?t=<token>` → `db.requeueWithRetry` → `retry_after=now-1s` để poll pick lên ngay.
- Model registry + fallback: `src/llm/registry.ts` — 6 model có metadata `tier + cost_in/out`.

## Deploy

**Mac worker:**
```bash
./infra/mac/install-launchd.sh install   # bootstrap io.mirotic → launchd
./infra/mac/install-launchd.sh status
tail -f ~/Library/Logs/mirotic/stdout.log
```

**EC2 dashboard:**
```bash
AWS_HOST=… SSH_KEY=~/… ./infra/aws/setup-dashboard.sh
# → build image mirotic, docker compose up, Caddy block mirotic.luunguyen.dev
```

**Postgres schema (1 lần):**
```bash
AWS_HOST=… SSH_KEY=~/… ./infra/aws/setup-db.sh
# hoặc migrate delta:
PGPASSWORD=… psql "host=…" -f infra/aws/schema.sql
```
