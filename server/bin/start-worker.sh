#!/bin/sh
# Entrypoint for the export worker service.
# The worker never runs migrations — the API owns the schema, and two services
# racing `migrate deploy` on boot is a good way to deadlock a deployment.
set -e

echo "[start-worker] starting export worker"
exec node dist/worker.js
