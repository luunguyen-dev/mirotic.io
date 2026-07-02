# Mirotic

Idea → demo → deploy pipeline. Mỗi sáng Prototyper gom 10 idea từ Hacker News / GitHub Trending / Product Hunt / backlog, CEO chấm 1-5⭐, top-3 vào cột **Proposed**. Bạn Approve trên dashboard, Builder chạy 4 gstack sessions (`implement /review /cso /qa`) qua Claude Code + Codex, output demo-ready docker container + repo GitHub private. Deploy → `<slug>.luunguyen.dev` live qua Caddy.

**Live**: <https://mirotic.luunguyen.dev/ideas> · <https://mirotic.luunguyen.dev/projects>

## State machine

```
Prototyper 07:00 ─► proposed ─(bạn Approve)─► approved ─(poller 5', rolling 24h gate)─► building
                                                                                          │
                                                                                          ▼
                                                                                     demo-ready
                                                                                     • docker chạy trên Mac (test)
                                                                                     • repo private mới trên GitHub
                                                                                          │
                                                                        (bạn Deploy trên web)
                                                                                          ▼
                                                        deploy-requested ─► deploying ─► deployed
                                                                                          │
                                                                                          ▼
                                                                       https://<slug>.luunguyen.dev
```

demo-ready cũng có thể **Promote → Project** để chuyển sang long-lived project với issue backlog (LLM sinh 5-8 issues khởi tạo).

## Chạy

Xem `SETUP.md` cho từng biến env + cách lấy. Sau khi có `.env`:

```bash
bun install                       # nếu cần (Bun-only, không có node_modules thực)
bun run src/index.ts <mode>
```

| Mode | Làm gì | Dùng khi nào |
|---|---|---|
| `daemon` | server + morning batch + poller interval | Docker container (dashboard EC2) |
| `serve` | chỉ dashboard `:4321` | dashboard EC2 nếu tách worker |
| `worker` | morning batch + poller, không serve | launchd Mac |
| `poll` | 1 chu kỳ poller rồi thoát | dev/debug |
| `generate` | sinh 1 idea đơn rồi thoát | dev |
| `batch` | sinh 1 batch (10 candidates + CEO) rồi thoát | dev |
| `demo` | full flow trong bộ nhớ, mock (~6s) | dev quick check |

Xem Prototyper gom gì (không insert DB): `bun run src/prototyper/index.ts`

## Database

- **Postgres** khi có `DATABASE_URL` — worker + dashboard cùng đọc/ghi. Dựng: `AWS_HOST=… SSH_KEY=… ./infra/aws/setup-db.sh`.
- **SQLite** khi `DATABASE_URL` trống — file `data/mirotic.db`, cho dev không cần Postgres.
- Schema xem `infra/aws/schema.sql` (Postgres). Tables: `jobs`, `idea_pool`, `job_logs`, `projects`, `milestones`, `issues`, `model_cooldowns`.

## Deploy

```bash
./infra/aws/setup-caddy.sh              # 1 lần trên EC2
./infra/aws/setup-dashboard.sh          # deploy dashboard container tại mirotic.luunguyen.dev
./infra/mac/install-launchd.sh install  # Mac worker (io.mirotic → launchd)
tail -f ~/Library/Logs/mirotic/stdout.log
```

Chi tiết component + data flow: [`ARCHITECTURE.md`](ARCHITECTURE.md).
