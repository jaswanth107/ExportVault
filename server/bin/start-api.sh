#!/bin/sh
# Entrypoint for the API service.
#
# Deliberately a script rather than `sh -c "migrate && node ..."` in the
# platform's start-command field: hosts differ in how they tokenise that field,
# and Render passes it through in a way that treats the whole string — `&&`
# included — as a single command name ("sh: 1: npx prisma migrate deploy &&
# node dist/server.js: not found"). A single executable has no such ambiguity.
set -e

echo "[start-api] applying database migrations..."
npx prisma migrate deploy
echo "[start-api] migrations applied; starting API"

# exec so the API becomes PID 1 and receives SIGTERM directly, which the
# graceful-shutdown handler in src/server.ts depends on.
exec node dist/server.js
