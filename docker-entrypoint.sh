#!/bin/sh

# Generate runtime environment config
cat <<EOF > /usr/share/nginx/html/env-config.js
window.__ENV__ = {
  VITE_API_URL: "${VITE_API_URL:-}"
  VITE_BYPASS_AUTH: "${VITE_BYPASS_AUTH:-}"
  VITE_TELEMETRY_HOST: "${VITE_TELEMETRY_HOST:-}"
};
EOF

echo "Generated env-config.js with VITE_API_URL=${VITE_API_URL:-'(not set)'}"

# Execute the CMD
exec "$@"
