#!/bin/sh
# nginx-start.sh — the nginx service's start-up (docker-compose.yml).
#
# Port 80 (nginx-http.conf: the ACME challenge and a redirect) is served at
# once. Port 443 (nginx.conf) is added as soon as the certificate for
# ${DOMAIN} exists, so a fresh server, with no certificate yet, still starts
# and can be issued one through the webroot (docs/17, TLS). After that,
# nginx reloads every RELOAD_SECONDS (6 hours) to pick up a renewed
# certificate.
set -eu

: "${DOMAIN:?DOMAIN must be set}"
POLL="${CERT_POLL_SECONDS:-60}"
RELOAD="${RELOAD_SECONDS:-21600}"
SITE=/etc/nginx/site
CONF=/etc/nginx/conf.d
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

render() { envsubst '${DOMAIN}' < "$1" > "$2"; }
have_cert() { [ -s "$CERT" ] && [ -s "$KEY" ]; }

rm -f "$CONF/default.conf"
render "$SITE/http.conf.template" "$CONF/00-http.conf"
if have_cert; then
  render "$SITE/https.conf.template" "$CONF/10-https.conf"
  echo "[tls] certificate found for ${DOMAIN}: HTTPS on"
else
  rm -f "$CONF/10-https.conf"
  echo "[tls] no certificate yet for ${DOMAIN}: serving port 80 only (the ACME challenge) until it appears"
fi

nginx -g 'daemon off;' &
NGINX=$!
trap 'kill -TERM "$NGINX" 2>/dev/null; wait "$NGINX"; exit 0' TERM INT

elapsed=0
while kill -0 "$NGINX" 2>/dev/null; do
  sleep "$POLL" & wait $! || true
  elapsed=$((elapsed + POLL))
  if [ ! -f "$CONF/10-https.conf" ] && have_cert; then
    render "$SITE/https.conf.template" "$CONF/10-https.conf"
    if out=$(nginx -t 2>&1); then
      nginx -s reload
      echo "[tls] certificate found for ${DOMAIN}: HTTPS on"
    else
      rm -f "$CONF/10-https.conf"
      echo "[tls] certificate found but the HTTPS configuration did not pass nginx -t; still port 80 only:"
      echo "$out" | tail -2
    fi
  elif [ "$elapsed" -ge "$RELOAD" ]; then
    elapsed=0
    nginx -s reload
  fi
done
wait "$NGINX"
