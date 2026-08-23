# ai-gateway 프로덕션 이미지 (Node 22 = 프로덕션 타깃, CI와 동일)
# 빌드: docker build -t ai-gateway .
# 실행: docker run -p 8787:8787 --env-file .env ai-gateway
#
# 설계 메모:
#  · corepack 서명 키 버그 회피를 위해 COREPACK_INTEGRITY_KEYS=0 (CLAUDE.md 환경 규칙)
#  · CMD는 exec 형식 + node 직접 실행 — pnpm/sh 래퍼를 끼우면 SIGTERM이 PID 1에서 멈춰
#    graceful shutdown(드레인)이 통째로 건너뛰어진다
#  · 런타임 스테이지는 프로덕션 의존성만 — tsx·vitest·타입 정의는 이미지에 넣지 않는다

# ── 1) 의존성 (캐시 레이어) ──────────────────────────────────────
FROM node:22-alpine AS deps
ENV COREPACK_INTEGRITY_KEYS=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile

# ── 2) 빌드 ────────────────────────────────────────────────────
FROM node:22-alpine AS build
ENV COREPACK_INTEGRITY_KEYS=0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN corepack enable && corepack pnpm build

# ── 3) 프로덕션 의존성만 재설치 ──────────────────────────────────
FROM node:22-alpine AS prod-deps
ENV COREPACK_INTEGRITY_KEYS=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile --prod

# ── 4) 런타임 ──────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 비루트 실행 (node 이미지의 기본 uid 1000 사용)
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node

EXPOSE 8787
# liveness와 같은 엔드포인트 — 의존성 장애로 재시작 루프에 빠지지 않게 /ready가 아닌 /health
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
