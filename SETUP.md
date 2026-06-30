# SETUP — mọi thông tin cần & cách lấy

Điền tất cả vào `.env` (copy từ `.env.example`), rồi chạy `./setup.sh`. Dưới đây là **từng giá trị** kèm hướng dẫn lấy.

## Checklist nhanh

| # | Biến (.env) | Bắt buộc | Lấy ở đâu |
|---|---|---|---|
| §1 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | ✅ | IAM Console → Access key |
| §1 | `AWS_REGION` | ✅ | Góc phải AWS Console |
| §1 | `INSTANCE_ID` | ✅ | EC2 Console → Instances |
| §1 | `SSH_KEY`, `SSH_USER` | ✅ | File .pem khi tạo instance |
| §1 | `AWS_HOST` | ✅ | EC2 → Public IPv4 |
| §2 | `DATABASE_URL` | tự động | setup.sh tự điền |
| §3 | `GITHUB_TOKEN` | ✅ | GitHub → Fine-grained PAT |
| §3 | `GITHUB_OWNER` | ✅ | Username GitHub của bạn |
| §4 | `ANTHROPIC_API_KEY` | ✅ | console.anthropic.com |
| §5 | Ollama + model | ✅* | setup.sh tự cài/pull |
| §6 | `PH_TOKEN` | tuỳ chọn | Product Hunt API |
| §7 | `RESEND_API_KEY` | tuỳ chọn | resend.com |
| §8 | `TS_AUTHKEY` | tuỳ chọn | Tailscale |

\*Bắt buộc nếu `USE_REAL_OLLAMA=true`.

**Công cụ cần cài sẵn trên Mac:** `docker` (Docker Desktop), `aws` (AWS CLI), `ssh`, `curl`, `openssl`, và `brew` (để setup.sh tự cài Ollama). Cài AWS CLI: `brew install awscli`. Docker Desktop: https://www.docker.com/products/docker-desktop/

---

## §1. AWS

Bạn nói đã có sẵn 1 EC2 host. Cần các giá trị sau từ nó.

**`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`** (để script gọi AWS CLI mở security group)
1. Vào AWS Console → tìm **IAM** → **Users**.
2. Chọn user của bạn (hoặc **Create user** nếu chưa có; gắn policy **AmazonEC2FullAccess** hoặc tối thiểu quyền `ec2:DescribeInstances` + `ec2:AuthorizeSecurityGroupIngress`).
3. Tab **Security credentials** → **Create access key** → chọn **Application running outside AWS** → **Create**.
4. Copy **Access key** và **Secret access key** (secret chỉ hiện 1 lần) vào `.env`.

**`AWS_REGION`** — mã region nơi đặt instance (vd `ap-southeast-1`, `us-east-1`). Xem ở góc trên bên phải Console; lấy phần mã trong ngoặc.

**`INSTANCE_ID`**
1. AWS Console → **EC2** → **Instances**.
2. Chọn instance → copy **Instance ID** (dạng `i-0abc123def456`).

**`SSH_KEY` + `SSH_USER`**
- `SSH_KEY` = đường dẫn file `.pem` bạn tải về khi tạo instance (key pair). Đặt quyền: `chmod 600 ~/.ssh/your-key.pem`. Điền đường dẫn đó.
- `SSH_USER` = `ubuntu` nếu AMI là Ubuntu, `ec2-user` nếu Amazon Linux. (Xem mục AMI của instance, hoặc thử `ubuntu` trước.)
- Đảm bảo Security Group của instance đã mở **port 22 (SSH)** cho IP của bạn (EC2 → instance → Security → Inbound rules).

**`AWS_HOST`** — **Public IPv4 address** của instance (EC2 → instance → Details), hoặc domain bạn trỏ vào. Dùng làm URL khi deploy.

---

## §2. Database (`DATABASE_URL`)

**Để TRỐNG.** `setup.sh` sẽ tự SSH vào EC2, chạy Postgres (Docker), mở port 5432 *chỉ cho IP của bạn*, áp schema, rồi tự điền `DATABASE_URL` vào `.env`.
- `DB_NAME`/`DB_USER` có default; `DB_PASS` trống = tự sinh ngẫu nhiên.
- Nếu đã có Postgres riêng, tự điền `DATABASE_URL=postgresql://user:pass@host:5432/db` thì setup bỏ qua bước này.

---

## §3. GitHub

**`GITHUB_TOKEN`** — token để hệ thống tạo repo private mới + đẩy code + cấu hình CI/CD.
1. GitHub → ảnh đại diện → **Settings** → **Developer settings** (cuối trang trái) → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Resource owner**: chọn tài khoản của bạn. **Expiration**: tuỳ (vd 90 ngày).
3. **Repository access**: **All repositories** (để tạo repo mới được).
4. **Permissions** → Repository permissions, đặt **Read and write** cho: **Administration** (tạo repo), **Contents** (đẩy code), **Workflows** (file Actions), **Secrets** (đặt secret CI/CD), **Actions**.
5. **Generate token** → copy (chỉ hiện 1 lần) vào `.env`.

> Cách khác (đơn giản hơn nhưng quyền rộng): tạo **token classic** với scope `repo` + `workflow`.

**`GITHUB_OWNER`** — username GitHub của bạn (hoặc tên org). Repo sẽ tạo dạng `OWNER/daily-<tên-ý-tưởng>`.

---

## §4. Claude Code (`ANTHROPIC_API_KEY`)

Token để executor chạy `claude -p` (gstack) trong container — **không liên quan tới chat này**, là key riêng của bạn.

**Cách 1 — API key (đơn giản nhất cho headless):**
1. Vào **console.anthropic.com** → đăng nhập → **API Keys** (hoặc **Settings → API Keys**).
2. **Create Key** → đặt tên → copy `sk-ant-...` vào `ANTHROPIC_API_KEY`.
3. Cần có credit/billing trong Console. *(Billing tính theo lượng dùng API.)*

**Cách 2 — dùng gói Claude Max (tiết kiệm hơn nếu chạy nhiều):**
1. Để `ANTHROPIC_API_KEY` **trống**.
2. Trên Mac chạy `claude` một lần, đăng nhập bằng tài khoản Max qua trình duyệt.
3. Mở comment dòng `- ${HOME}/.claude:/root/.claude` trong `docker-compose.yml` để container dùng phiên đăng nhập đó.

---

## §5. Ollama (Prototyper)

Không cần key. Đặt `USE_REAL_OLLAMA=true` để Prototyper dùng model thật. `setup.sh` sẽ:
1. Cài Ollama nếu chưa có (`brew install ollama`).
2. Chạy nền + `ollama pull qwen3-coder:30b` (model trong `OLLAMA_MODEL`).

Tự cài tay nếu muốn: tải ở **https://ollama.com/download**, rồi `ollama pull qwen3-coder:30b`. (Chạy native trên Mac để dùng GPU/Metal — **không** đặt trong Docker.)

---

## §6. Product Hunt (`PH_TOKEN`) — tuỳ chọn

Thêm Product Hunt làm nguồn ý tưởng. Bỏ trống cũng được (vẫn có HN + GitHub Trending + backlog).
1. **producthunt.com/v2/oauth/applications** → đăng nhập → **Add an application**.
2. Điền tên + redirect URI bất kỳ (vd `http://localhost`).
3. Trong app → mục **Developer Token** → **Create Token** → copy vào `PH_TOKEN`.

---

## §7. Email (`RESEND_API_KEY`) — tuỳ chọn

Gửi email "demo sẵn sàng / đã deploy". Bỏ trống = ghi email ra `./data/outbox/*.html`.
1. **resend.com** → đăng ký → **API Keys** → **Create API Key** → copy vào `RESEND_API_KEY`.
2. **Domains** → thêm & xác minh domain của bạn, rồi đặt `EMAIL_FROM=ten@domain-đã-xác-minh`. `EMAIL_TO` = email nhận của bạn.

---

## §8. Tailscale (`TS_AUTHKEY`) — tuỳ chọn nhưng khuyến nghị

Để Mac + EC2 nói chuyện qua mạng riêng, **không phải mở port Postgres ra Internet**.
1. **login.tailscale.com** → **Settings** → **Keys** → **Generate auth key** → copy.
2. Cài Tailscale trên cả Mac và EC2 (`curl -fsSL https://tailscale.com/install.sh | sh`), `tailscale up`.
3. Đặt `DATABASE_URL` dùng IP tailnet của EC2 (dạng `100.x.y.z`) thay vì public IP.

---

## Sau khi điền xong

```bash
cp .env.example .env     # nếu chưa
# ... điền các giá trị theo trên ...
chmod +x setup.sh aws/setup-aws-db.sh
./setup.sh               # chạy từ đầu đến cuối
```

`setup.sh` sẽ kiểm tra thiếu biến nào (báo tên rõ ràng), dựng Postgres, cài Ollama+model, kiểm tra token, rồi build & chạy Docker. Lỗi ở bước nào nó dừng và in lý do.
