# Mirotic

Orchestrator "idea → demo → project" — mỗi sáng Prototyper gom 10 idea từ HN/GitHub/Product Hunt, CEO chấm 1-5⭐, top-3 chờ bạn duyệt. Approve → Builder chạy 4 gstack sessions (implement/review/cso/qa) → demo-ready → Deploy → live tại `<slug>.luunguyen.dev`.

**Live**: https://mirotic.luunguyen.dev/ideas + https://mirotic.luunguyen.dev/projects

## Docs

- **[docs/README.md](docs/README.md)** — Overview + Quick start
- **[docs/SETUP.md](docs/SETUP.md)** — Env vars từng biến, cách lấy
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Component + data flow, layout mã, state machine

## Layout

```
src/          # TypeScript orchestrator (bun run src/index.ts <mode>)
web/          # HTML dashboards (ideas + projects)
infra/        # Docker + AWS + Mac launchd
scripts/      # Dev utilities
templates/    # Builder output templates
docs/         # Docs
```

## Dev quick start

```bash
cp .env.example .env         # điền theo docs/SETUP.md
bun install                  # (nếu thêm deps sau này)
bun run src/index.ts batch   # trigger 1 batch Prototyper
bun run src/index.ts poll    # trigger 1 poll cycle (build 1 approved)
bun run src/index.ts serve   # chỉ dashboard :4321
bun run src/index.ts worker  # daemon poll + morning batch (không serve)
bun run src/index.ts daemon  # daemon + serve trong 1 process
```

## Deploy

```bash
./infra/aws/setup-caddy.sh          # 1 lần trên EC2
./infra/aws/setup-dashboard.sh      # deploy dashboard container
./infra/mac/install-launchd.sh install  # Mac worker
```
