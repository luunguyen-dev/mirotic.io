# Daily Idea → Demo system (DB-driven, web-managed)

Mỗi ngày hệ thống tự gom 1 ý tưởng vào DB. Bạn **duyệt trên web** (đổi status). Poller mỗi 5' nhận ý tưởng `approved`, **thực thi tối đa 1/ngày**, cập nhật status liên tục lên DB để bạn theo dõi. Kết quả: **docker chạy local để test + repo private mới + CI/CD lên AWS**, và bạn bấm **Deploy** trên web khi ưng.

## Luồng (state machine)
```
Prototyper ──> proposed ──(bạn duyệt trên web)──> approved
                                                     │ poller 5' (tối đa 1/ngày)
                                                     ▼
                                                  building ──> demo-ready
                                                                 │  • docker chạy trên Mac (test ở nhà)
                                                                 │  • repo private mới trên GitHub
                                                                 │  • CI/CD → AWS đã sẵn
                                   (bạn test → bấm Deploy trên web)
                                                                 ▼
                                          deploy-requested ──> deploying ──> deployed
```
Web ↔ orchestrator **decoupled hoàn toàn qua DB**: web chỉ đọc/ghi Postgres; orchestrator poll DB tìm việc (`approved`→build, `deploy-requested`→deploy).

## Thành phần
| Module | Vai | Trạng thái |
|---|---|---|
| `prototyper.ts` | Thu thập ý tưởng (HN + GitHub Trending + Product Hunt + backlog) | ✅ chạy thật (HN/GitHub không cần key) |
| `db.ts` | Kho ý tưởng dùng chung — **Postgres** (có `DATABASE_URL`) hoặc **SQLite** (dev) | ✅ tested cả 2 |
| `mirotic.ts` | Orchestrator: sinh ý tưởng + **poller 5'** + gate 1/ngày + executor + deploy | ✅ logic tested (execution mock) |
| `aws/setup-aws-db.sh` | Dựng Postgres trên EC2 + mở network + schema | ✅ syntax-checked |
| **Web quản lý ý tưởng** | UI duyệt/đổi status/nút Deploy (đọc/ghi Postgres) | ⏳ chưa build |
| Executor thật (Claude Code + gstack) | Build + tạo repo private + CI/CD | ⏳ mock (bật `USE_REAL_CLAUDE`) |

## Chạy
```bash
cp .env.example .env          # sửa HMAC_SECRET; DATABASE_URL trống = SQLite dev
docker compose up -d --build  # daemon: dashboard + sinh ý tưởng + poller 5'
```
Hoặc Bun trực tiếp: `DATA_DIR=./data bun run mirotic.ts <mode>`

| Mode | Làm gì |
|---|---|
| `daemon` | server + sinh ý tưởng hằng ngày + poller 5' (mặc định) |
| `demo` | trọn luồng trong bộ nhớ, mock (~6s) — xem proposed→…→deployed |
| `generate` | sinh 1 ý tưởng `proposed` rồi thoát |
| `poll` | chạy 1 chu kỳ poller rồi thoát |
| `serve` | chỉ dashboard tạm + action endpoints |

Xem riêng Prototyper gom gì: `bun run prototyper.ts`

## Database
- **Postgres** khi đặt `DATABASE_URL` (web + orchestrator dùng chung). Dựng nhanh: `cd aws && INSTANCE_ID=i-… SSH_KEY=~/.ssh/key.pem ./setup-aws-db.sh`.
- **SQLite** khi không có `DATABASE_URL` — file `DATA_DIR/mirotic.db`, cho dev không cần Postgres.
- Cùng một bảng `jobs` (xem `aws/schema.sql`) → web đọc/ghi trực tiếp.

## Còn mock / cần làm tiếp
- **Web quản lý ý tưởng**: list/duyệt/đổi status + nút Deploy (chỉ cần CRUD trên bảng `jobs`).
- **Executor thật** (`USE_REAL_CLAUDE=true`): `claude -p` chạy gstack, **tạo repo private** (cần GitHub token), **docker up trên Mac**, **CI/CD → AWS**. Tìm `PLUG REAL` / `callClaudeCode`.
- Dashboard hiện tại (`/`) là UI tạm để điều khiển trước khi web app ra đời.

Kiến trúc tổng thể + lộ trình: xem `../daily-idea-to-pr-system-plan.md`.
