# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Engy Report, in one image: the API, the built app it serves, and the manual.
#
# Multi-stage so the thing that ships carries no build tooling and no dev
# dependencies — Vite, Tailwind and the test suites are all build-time only.
#
# No architecture is pinned. The base images have arm64 builds, so this is the
# same Dockerfile on an Apple Silicon Mac as on an x86 server, and Docker picks
# the right one.
# ---------------------------------------------------------------------------

# --------------------------------------------------------------- build ----
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first. They change far less often than source, so the install layer
# is reused on every rebuild that only touched code — which is nearly all of them.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY docs/package.json docs/
RUN npm ci

COPY . .

# The app and the manual. The server serves the first; the second is a static
# site the compose file publishes on its own port.
RUN npm run build --workspace client \
 && npm run build --workspace docs

# ---------------------------------------------------------------- docs ----
#
# The manual, on its own port. nginx rather than a Node process because it is a
# folder of static files, and rather than `npx serve` because that would reach out
# to the network on every start — which is the one thing a "just run this" setup
# cannot depend on.
FROM nginx:1.27-alpine AS docs
COPY --from=build /app/docs/dist /usr/share/nginx/html
COPY docker/docs.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# ----------------------------------------------------------------- run ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# `tini` because Node is not a good PID 1: without it, Ctrl-C and `docker stop`
# leave the process to be killed rather than shut down, and a shutdown mid-write
# to GridFS is the one this app would notice.
RUN apk add --no-cache tini

# Production dependencies only. `npm ci --omit=dev` against the same lockfile the
# build used, so what runs is what was tested, minus the toolchain.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY docs/package.json docs/
RUN npm ci --omit=dev --workspace server --include-workspace-root \
 && npm cache clean --force

COPY server/ server/
COPY --from=build /app/client/dist client/dist
COPY --from=build /app/docs/dist docs/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Uploaded templates and render output live here and must outlive the container;
# the compose file mounts a volume over it. Created and owned now so a mounted
# volume inherits the ownership rather than arriving as root-owned and unwritable.
RUN mkdir -p server/storage/templates server/storage/tmp \
 && chown -R node:node /app/server/storage

# Not root. The app writes to exactly one directory and needs nothing else.
USER node

EXPOSE 4000
ENV PORT=4000

# /api/health, not /api/version: the second is behind the token on purpose, so a
# healthcheck on it would report every healthy container as sick. /health answers
# without touching the database, so unhealthy means the process is wedged rather
# than that Mongo is slow — which is what the compose dependency is for.
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/src/index.js"]
