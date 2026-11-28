#!/bin/sh
if [ -n "${PLOW_POLICY_CLI:-}" ]; then
  exec node --disable-warning=ExperimentalWarning "$PLOW_POLICY_CLI"
fi
exec /usr/local/bin/node --disable-warning=ExperimentalWarning /opt/plow/policy/main.ts
