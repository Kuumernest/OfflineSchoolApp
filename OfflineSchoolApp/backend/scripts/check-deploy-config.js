// backend/scripts/check-deploy-config.js
"use strict";

/**
 * The Compose stack's doors (docs/40 0.7): only 80 and 443 are published,
 * HTTPS is served, and port 80 only answers the certificate challenge and
 * redirects. Read from docker-compose.yml and nginx.conf as they are
 * committed, so an edit that reopens the backend's port or drops TLS fails
 * here.
 *
 * Also: a fresh server starts on port 80 alone and adds 443 once the
 * certificate exists (nginx-start.sh); every service's logs are capped; the
 * backend and nginx run on Cameroon time.
 *
 * The configuration itself was run by hand in nginx:alpine with a
 * self-signed certificate (docs/39 §20.0): with no certificate, port 80
 * served the challenge and 443 stayed closed; once the certificate files
 * appeared, HTTPS came on within the poll (HTTP/2, TLS 1.3, HSTS, TLS 1.1
 * refused) and the logs were in WAT.
 *
 *   node scripts/check-deploy-config.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = process.env.CHECK_ROOT || path.join(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const read = (f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), "utf8") : "");
const nginx   = read("nginx.conf");          // port 443, rendered once the certificate exists
const nginx80 = read("nginx-http.conf");     // port 80, always
const start   = read("nginx-start.sh");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** One service's block of docker-compose.yml (two-space indented key to the next). */
const service = (name) => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n|\nvolumes:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
/** The host ports a service publishes ("80:80" → "80"). */
const published = (block) => {
  const m = block.match(/\n    ports:\n((?:      - .*\n)+)/);
  return m ? [...m[1].matchAll(/"?(\d+):\d+"?/g)].map((x) => x[1]) : [];
};
/** The server blocks of both files, by what they listen on. */
const servers = `${nginx}\n${nginx80}`.split(/\nserver \{/).slice(1);
const serverOn = (port) => servers.find((b) => new RegExp(`listen ${port}\\b`).test(b)) ?? "";

console.log("--- published ports ---");
check("no database in the stack: MongoDB is Atlas, outside it", [service("mongo"), /mongo:\d/.test(compose)], ["", false]);
check("the backend publishes nothing (5000 is reached over the Docker network only)", published(service("backend")), []);
check("nginx publishes 80 and 443", published(service("nginx")).sort(), ["443", "80"]);
check("every port published by the stack is 80 or 443",
  ["backend", "nginx", "certbot"].flatMap((s) => published(service(s))).filter((p) => !["80", "443"].includes(p)), []);

console.log("--- HTTPS ---");
const https = serverOn(443), http = serverOn(80);
check("a server on 443 with TLS and HTTP/2", [/listen 443 ssl;/.test(https), /http2 on;/.test(https)], [true, true]);
check("its certificate from the letsencrypt volume, for ${DOMAIN}",
  [/ssl_certificate\s+\/etc\/letsencrypt\/live\/\$\{DOMAIN\}\/fullchain\.pem;/.test(https), /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/\$\{DOMAIN\}\/privkey\.pem;/.test(https)], [true, true]);
check("TLS 1.2 and 1.3 only, and HSTS", [/ssl_protocols TLSv1\.2 TLSv1\.3;/.test(https), /Strict-Transport-Security "max-age=31536000" always/.test(https)], [true, true]);
check("443 is the API only: /api/ and /uploads/ proxied, everything else 404 (the console is on Cloudflare Pages)",
  [/location \/ \{\s*return 404;/.test(https), /\/app\/public\/web/.test(https),
   /location \/api\/ \{\s*proxy_pass http:\/\/backend:5000;/.test(https), /location \/uploads\/ \{\s*proxy_pass http:\/\/backend:5000;/.test(https)],
  [true, false, true, true]);
check("  debug routes closed at the door", [/location \/api\/debug\/ \{\s*return 404;/.test(https), /location \/api\/admin\/debug\/ \{\s*return 404;/.test(https)], [true, true]);
check("  long requests are not cut at 60s: 600s, as the backend allows", /proxy_read_timeout\s+600s;/.test(https), true);

console.log("--- port 80 ---");
check("80 answers the certificate challenge and redirects everything else to https",
  [/location \/\.well-known\/acme-challenge\/ \{\s*root \/var\/www\/certbot;/.test(http), /return 301 https:\/\/\$host\$request_uri;/.test(http)], [true, true]);
check("80 serves nothing else (no app, no proxy)", [/proxy_pass/.test(http), /\/app\/public\/web/.test(http)], [false, false]);
check("80 lives in its own file, 443 in nginx.conf", [/listen 80;/.test(nginx80), /listen 80;/.test(nginx), /listen 443 ssl;/.test(nginx)], [true, false, true]);

console.log("--- certificates ---");
const ng = service("nginx"), cb = service("certbot");
check("nginx starts through nginx-start.sh, with both templates, DOMAIN, the certificates and the challenge files",
  [/command: \["\/bin\/sh", "\/nginx-start\.sh"\]/.test(ng), /\.\/nginx-start\.sh:\/nginx-start\.sh:ro/.test(ng),
   /\.\/nginx-http\.conf:\/etc\/nginx\/site\/http\.conf\.template:ro/.test(ng), /\.\/nginx\.conf:\/etc\/nginx\/site\/https\.conf\.template:ro/.test(ng),
   /DOMAIN: \$\{DOMAIN:\?/.test(ng), /letsencrypt:\/etc\/letsencrypt:ro/.test(ng), /certbot_webroot:\/var\/www\/certbot:ro/.test(ng)], [true, true, true, true, true, true, true]);
check("a fresh server starts on port 80 alone; 443 is added once the certificate exists, after nginx -t",
  [/have_cert\(\) \{ \[ -s "\$CERT" \] && \[ -s "\$KEY" \]; \}/.test(start), /render "\$SITE\/http\.conf\.template" "\$CONF\/00-http\.conf"/.test(start),
   /if \[ ! -f "\$CONF\/10-https\.conf" \] && have_cert; then/.test(start), /if out=\$\(nginx -t 2>&1\); then\s*nginx -s reload/.test(start)], [true, true, true, true]);
check("nginx reloads periodically, so a renewed certificate is picked up", /RELOAD="\$\{RELOAD_SECONDS:-21600\}"/.test(start) && /nginx -s reload/.test(start), true);
check("a certbot service renews through the webroot, sharing both volumes",
  [/certbot renew --webroot -w \/var\/www\/certbot/.test(cb), /letsencrypt:\/etc\/letsencrypt\n/.test(cb), /certbot_webroot:\/var\/www\/certbot\n/.test(cb)], [true, true, true]);

console.log("--- the backend container ---");
const be = service("backend");
check("its environment comes from a protected file, not from compose", /env_file:\n      - \$\{BACKEND_ENV_FILE:-\.\/deploy\/backend\.env\}/.test(be), true);
check("  healthy means ready (the database answers), checked from inside",
  /healthcheck:\n      test: \["CMD", "wget", "-q", "-O", "\/dev\/null", "http:\/\/127\.0\.0\.1:5000\/api\/health\/ready"\]/.test(be), true);
check("  tini as PID 1, and time for the graceful shutdown", [/\n    init: true\n/.test(be), /\n    stop_grace_period: 20s\n/.test(be)], [true, true]);
check("  nginx waits for it to start, not to be healthy (so the ACME challenge is always answered)",
  /depends_on:\n      backend:\n        condition: service_started/.test(service("nginx")), true);

console.log("--- logs and time ---");
const SERVICES = ["backend", "nginx", "certbot"];
check("every service logs to json-file capped at 10 MB × 5 files",
  SERVICES.filter((n) => !/\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "5"\n/.test(service(n))), []);
check("the backend and nginx run on Cameroon time", ["backend", "nginx"].filter((n) => !/\n      TZ: Africa\/Douala\n/.test(service(n))), []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
