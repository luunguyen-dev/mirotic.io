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

Line counts hiển thị để track ratio giữa các concerns; tính khi mỗi lần restructure lớn (`wc -l src/**/*.ts`).

```
mirotic.io/
├── src/                            # 2 288 lines total
│   ├── index.ts             54     # entry: mkdirSync bootstrap + main() mode dispatch
│   ├── config.ts            40     # CONFIG object từ env
│   ├── types.ts             49     # Idea, Plan, Result, PlanStep, ProjectType (shared, cắt circular)
│   ├── db/index.ts         427     # Postgres + SQLite backend, jobs/projects/issues/pool/logs/cooldowns
│   ├── llm/
│   │   ├── index.ts        107     # Router callLLM (Claude CLI / Codex / Gemini REST / Ollama)
│   │   └── registry.ts     128     # Model priority + persistent cooldown state + pickModel
│   ├── prototyper/
│   │   └── index.ts        360     # 4-source signal collection + Ollama/Claude synthesis
│   ├── executor/
│   │   ├── builder.ts      429     # runBuild + 4 gstack sessions + runAgenticWithFallback + Codex
│   │   ├── deployer.ts      87     # deploy() + .shipenv + ship.sh streaming
│   │   ├── planner.ts      103     # BASE_STEPS + makePlan + generateDetailedPlan + updatePlanStep
│   │   └── ceo.ts          109     # ceoReview + callTextWithFallback (text tier router)
│   ├── worker/
│   │   ├── daemon.ts       113     # generateIdea + generateIdeaBatch + runDaemon + runWorker + msUntil
│   │   └── poller.ts        48     # pollOnce cycle (deploy queue → seed → build gate)
│   ├── projects/
│   │   └── index.ts        109     # promoteJobToProject + seedEmptyProjects
│   ├── api/
│   │   ├── server.ts        15     # Bun.serve wrapper (thin — test có thể import handleFetch)
│   │   ├── routes.ts       203     # handleFetch: JSON API + static views + HMAC actions
│   │   └── hmac.ts          38     # sign/verify + ACTIONS + PROMOTE + RETRY + BUILDER_CHOICES
│   └── util/
│       ├── logger.ts        14     # jLog (console + job_logs) + log + sleep
│       ├── rate-limit.ts    24     # parseRateLimitReset (Asia/Saigon → UTC)
│       └── email.ts         34     # Resend hoặc outbox mock + demoReady/deployed templates
├── web/                            # 622 lines total (static HTML, no build step)
│   ├── ideas.html          468     # /ideas kanban 7 columns + drawer + log tail + model picker
│   └── projects.html       154     # /projects list + detail (issue kanban)
├── infra/
│   ├── docker/
│   │   ├── Dockerfile               # 25 lines; COPY src/ web/ templates/
│   │   ├── dashboard.compose.yml    # EC2 dashboard container
│   │   └── docker-compose.dev.yml   # local dev stack
│   ├── aws/
│   │   ├── schema.sql               # Postgres schema (create + migrate)
│   │   ├── setup-caddy.sh
│   │   ├── setup-dashboard.sh
│   │   └── setup-db.sh
│   └── mac/
│       ├── io.mirotic.plist         # launchd → src/index.ts worker
│       └── install-launchd.sh
├── scripts/
│   ├── inject-idea.ts               # Dev utility: chèn idea thủ công
│   └── setup.sh                     # End-to-end env check + docker up
├── templates/
│   └── ship.sh.tmpl                 # Builder output projects paste vào repo
├── docs/
│   ├── README.md                    # Overview + Quick start
│   ├── SETUP.md                     # Từng biến env, cách lấy
│   └── ARCHITECTURE.md              # File này
└── data/                            # gitignored — SQLite dev, builds/, outbox/
```

**Extraction ledger** (chỉ src/, tính từ khi `mirotic.ts` còn là monolith):

| Restructure step | `src/index.ts` |
|---|---|
| Gốc monolith (`mirotic.ts`) | 1 238 |
| Move + extract util/config/types/api/hmac + executor/{ceo,planner} | 600 |
| Extract `executor/builder.ts` (runBuild + 4 sessions + fallback) | 421 |
| Extract `executor/deployer.ts` + `worker/poller.ts` + `projects/` | 421 → 201 |
| Extract `api/routes.ts` + `api/server.ts` | 201 |
| Extract `worker/daemon.ts` (Prototyper batch + scheduler + runDaemon/runWorker) | **54** |

Net −95.6%. Business logic đã 100% ở module dưới; `index.ts` giờ chỉ có bootstrap + argv dispatch.

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
