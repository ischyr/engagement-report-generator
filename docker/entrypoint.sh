#!/bin/sh
# ---------------------------------------------------------------------------
# What has to be true before the API starts, and is nobody's job to remember.
#
# Three things: real secrets exist, Mongo is answering, and there is an account
# to log in with. Each is skipped when it has already been done, so this runs on
# every boot and only does work on the first.
# ---------------------------------------------------------------------------
set -e

STATE_DIR="/app/server/storage"
SECRETS="$STATE_DIR/.secrets.env"

# --------------------------------------------------------------- secrets ----
#
# The defaults in env.js are literally called `dev-only-...`, and anything that
# ships with its signing key published is not signing anything. So: generate a
# set on first boot and keep it in the storage volume, which is the one thing
# here that survives a rebuild.
#
# Not regenerated on later boots, deliberately. New JWT secrets sign out
# everybody; a new VAULT_KEY makes every stored credential permanently
# unreadable, and the vault is the one part of this that cannot be re-entered
# from memory.
#
# Anything set in the environment wins — compose, an .env file, a real secrets
# manager. This is the fallback for somebody who set none of that up.
if [ -z "$JWT_ACCESS_SECRET" ] || [ -z "$JWT_REFRESH_SECRET" ] || [ -z "$VAULT_KEY" ]; then
  if [ ! -f "$SECRETS" ]; then
    echo "[entrypoint] first boot: generating secrets in $SECRETS"
    umask 077
    node -e '
      const { randomBytes } = require("node:crypto");
      const hex = (n) => randomBytes(n).toString("hex");
      process.stdout.write(
        `JWT_ACCESS_SECRET=${hex(48)}\nJWT_REFRESH_SECRET=${hex(48)}\nVAULT_KEY=${hex(32)}\n`
      );
    ' > "$SECRETS"
    echo "[entrypoint] back these up — losing VAULT_KEY makes stored credentials unreadable"
  fi
  # `set -a` so each assignment is exported rather than staying a shell variable.
  set -a
  . "$SECRETS"
  set +a
fi

# ----------------------------------------------------------------- mongo ----
#
# compose already gates on Mongo's healthcheck, so this is usually one attempt.
# It is here because `connectDatabase()` throws rather than retries, and a
# container that exits during a slow first start of Mongo looks like a bug.
echo "[entrypoint] waiting for MongoDB"
ATTEMPT=0
until node -e '
  const { MongoClient } = require("mongodb");
  const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
  c.connect().then(() => c.close()).then(() => process.exit(0)).catch(() => process.exit(1));
' 2>/dev/null; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 60 ]; then
    echo "[entrypoint] MongoDB never answered at $MONGODB_URI — giving up" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] MongoDB is up"

# ------------------------------------------------------------------ seed ----
#
# An empty instance has no account, and registration through the UI is the other
# way in — but a first run that ends at a login form nobody has a password for is
# a bad first run. The seed script is idempotent, so this is safe on every boot;
# skip it with SEED_ON_BOOT=false.
case "${SEED_ON_BOOT:-true}" in
  1 | true | yes | on)
    echo "[entrypoint] seeding (idempotent)"
    node server/src/scripts/seed.js || echo "[entrypoint] seed failed — continuing to start the API" >&2
    ;;
esac

exec "$@"
