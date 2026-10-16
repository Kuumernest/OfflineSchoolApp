// backend/scripts/check-deploy-config.js
"use strict";

/**
 * The Compose stack's doors (docs/40 0.7): only 80 and 443 are published,
 * HTTPS is served, and port 80 only answers the certificate challenge and
 * redirects. Read from docker-compose.yml and nginx.conf as they are
 * committed, so an edit that reopens the backend's port or drops TLS fails
 * here.
 *
 * The configuration itself was run once by hand in nginx:alpine with a
 * self-signed certificate (docs/39 §20.0): nginx -t passed; port 80
 * redirected and served the challenge; port 443 served the web console
 * with HSTS over HTTP/2 and TLS 1.3, and refused TLS 1.1.
 *
 *   node scripts/check-deploy-config.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = process.env.CHECK_ROOT || path.join(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const nginx   = fs.readFileSync(path.join(ROOT, "nginx.conf"), "utf8");

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
/** The server blocks of nginx.conf, by what they listen on. */
const servers = nginx.split(/\nserver \{/).slice(1);
const serverOn = (port) => servers.find((b) => new RegExp(`listen ${port}\\b`).test(b)) ?? "";

console.log("--- published ports ---");
check("mongo publishes nothing", published(service("mongo")), []);
check("the backend publishes nothing (5000 is reached over the Docker network only)", published(service("backend")), []);
check("nginx publishes 80 and 443", published(service("nginx")).sort(), ["443", "80"]);
check("every port published by the stack is 80 or 443",
  ["mongo", "backend", "nginx", "certbot"].flatMap((s) => published(service(s))).filter((p) => !["80", "443"].includes(p)), []);

console.log("--- HTTPS ---");
const https = serverOn(443), http = serverOn(80);
check("a server on 443 with TLS and HTTP/2", [/listen 443 ssl;/.test(https), /http2 on;/.test(https)], [true, true]);
check("its certificate from the letsencrypt volume, for ${DOMAIN}",
  [/ssl_certificate\s+\/etc\/letsencrypt\/live\/\$\{DOMAIN\}\/fullchain\.pem;/.test(https), /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/\$\{DOMAIN\}\/privkey\.pem;/.test(https)], [true, true]);
check("TLS 1.2 and 1.3 only, and HSTS", [/ssl_protocols TLSv1\.2 TLSv1\.3;/.test(https), /Strict-Transport-Security "max-age=31536000" always/.test(https)], [true, true]);
check("the web console, the API and uploads are served on 443",
  [/location \/ \{\s*root \/app\/public\/web;/.test(https), /location \/api\/ \{\s*proxy_pass http:\/\/backend:5000;/.test(https), /location \/uploads\/ \{\s*proxy_pass http:\/\/backend:5000;/.test(https)], [true, true, true]);

console.log("--- port 80 ---");
check("80 answers the certificate challenge and redirects everything else to https",
  [/location \/\.well-known\/acme-challenge\/ \{\s*root \/var\/www\/certbot;/.test(http), /return 301 https:\/\/\$host\$request_uri;/.test(http)], [true, true]);
check("80 serves nothing else (no app, no proxy)", [/proxy_pass/.test(http), /\/app\/public\/web/.test(http)], [false, false]);

console.log("--- certificates ---");
const ng = service("nginx"), cb = service("certbot");
check("nginx renders the template with DOMAIN, and reads the certificates and challenge files",
  [/\.\/nginx\.conf:\/etc\/nginx\/templates\/default\.conf\.template:ro/.test(ng), /DOMAIN: \$\{DOMAIN:\?/.test(ng), /letsencrypt:\/etc\/letsencrypt:ro/.test(ng), /certbot_webroot:\/var\/www\/certbot:ro/.test(ng)], [true, true, true, true]);
check("nginx reloads periodically, so a renewed certificate is picked up", /nginx -s reload/.test(ng), true);
check("a certbot service renews through the webroot, sharing both volumes",
  [/certbot renew --webroot -w \/var\/www\/certbot/.test(cb), /letsencrypt:\/etc\/letsencrypt\n/.test(cb), /certbot_webroot:\/var\/www\/certbot\n/.test(cb)], [true, true, true]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
