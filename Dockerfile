# syntax=docker/dockerfile:1
FROM node:22-slim

# git: Claude Code dùng để commit/mở PR. ca-certificates: HTTPS (Anthropic, Resend).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# bun = runtime cho orchestrator. @anthropic-ai/claude-code = agent (chỉ cần khi USE_REAL_CLAUDE=true).
# Muốn image nhẹ (chỉ mock) thì bỏ "@anthropic-ai/claude-code" ở dòng dưới.
# npm kéo về native binary theo nền tảng build (arm64 nếu build trên Mac mini) — claude chạy không cần Node.
RUN npm install -g bun @anthropic-ai/claude-code

WORKDIR /app
COPY daily-loop.ts prototyper.ts db.ts inject-idea.ts dashboard.html ./

ENV NODE_ENV=production \
    DATA_DIR=/app/data
EXPOSE 4321

# Mặc định: daemon = server approve/reject + tự lên lịch chạy morning mỗi ngày (thay launchd).
CMD ["bun", "run", "daily-loop.ts", "daemon"]
