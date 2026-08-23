# syntax=docker/dockerfile:1
#
# telemetry-processor
#
# Build from the REPOSITORY ROOT so the npm workspace layout is preserved:
#   docker build -f services/telemetry-processor/Dockerfile -t sit314-transport-telemetry-processor .
#
# No secrets are ever copied in. Credentials come from the ECS task role at
# runtime; certificate paths come from environment variables.
FROM node:22-alpine AS deps
WORKDIR /app
# Copy only the manifests first so dependency installation is cached.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY simulator/package.json ./simulator/
COPY services/telemetry-processor/package.json ./services/telemetry-processor/
COPY services/route-impact-worker/package.json ./services/route-impact-worker/
COPY services/notification-worker/package.json ./services/notification-worker/
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user.
RUN addgroup -S app && adduser -S -G app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY schemas ./schemas
COPY shared ./shared
COPY services/telemetry-processor ./services/telemetry-processor

USER app

# The worker runtime handles SIGTERM: it stops claiming new messages, finishes
# in-flight work and exits. Using exec form (no shell) means the signal reaches
# node directly, which is what makes ECS scale-in safe.
STOPSIGNAL SIGTERM
CMD ["node", "services/telemetry-processor/src/index.js"]
