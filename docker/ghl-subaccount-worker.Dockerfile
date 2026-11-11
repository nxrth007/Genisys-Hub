# Browser worker for GHL sub-account creation.
#
# Render → New → Background Worker → Docker, point the Dockerfile at
# this file, and set the env vars in .env.example (the GHL_SUBACCOUNT_*
# block). The image tag matches the `playwright` dependency so Chromium
# and the driver are the same version.
#
# Do not set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD on this service. Set
# GHL_SUBACCOUNT_WORKER_RUN=0 on the Hub web service so only this
# process drives the browser.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --include=dev
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
# Left off here on purpose. Set GHL_SUBACCOUNT_WORKER_ENABLED=1 on the
# service when you want it to log in. MODE stays dry_run until you set
# GHL_SUBACCOUNT_WORKER_MODE=create.
CMD ["npx", "tsx", "scripts/ghl-subaccount-worker.ts"]
