# Optional fallback. The Hub web service (native Node, 1c-2g) runs the
# browser itself. Use this image only if that service runs out of its
# 2 GB while a job is open.
#
# Render → New → Background Worker → Docker. Set
# GHL_SUBACCOUNT_CHROMIUM=system (this image already has the libraries)
# and GHL_SUBACCOUNT_WORKER_RUN=0 on the web service.
# The image tag matches the `playwright` dependency.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --include=dev
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
ENV GHL_SUBACCOUNT_CHROMIUM=system
# Left off here on purpose. Set GHL_SUBACCOUNT_WORKER_ENABLED=1 on the
# service when you want it to log in. MODE stays dry_run until you set
# GHL_SUBACCOUNT_WORKER_MODE=create.
CMD ["npx", "tsx", "scripts/ghl-subaccount-worker.ts"]
