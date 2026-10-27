// docs/parent-portal/harness/shots.mjs
//
// Screenshots of the parent portal, at phone width (390px) and desktop
// (1280px), into docs/parent-portal/<phase>/<screen>-<mobile|desktop>.png.
//
//   1. backend:  node backend/scripts/portal-demo.js --out /tmp/portal-demo-login.json
//   2. web:      cd web && npx vite --port 5173
//   3. shots:    PW_DIR=<dir with playwright-core installed> \
//                node docs/parent-portal/harness/shots.mjs <before|after> [screen ...]
//
// playwright-core is not a dependency of the app; install it anywhere
// (npm i playwright-core@1.48.2) and point PW_DIR at that folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(process.env.PW_DIR || process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const phase = process.argv[2] || "after";
const only  = process.argv.slice(3);
const BASE  = process.env.PORTAL_URL || "http://localhost:5173/portal";
const login = JSON.parse(fs.readFileSync(process.env.LOGIN_FILE || path.join(os.tmpdir(), "portal-demo-login.json"), "utf8"));
const OUT   = path.join(HERE, "..", phase);
fs.mkdirSync(OUT, { recursive: true });

const SIZES = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } };

// How to reach each screen. "before" is the tabbed page as it was; "after" the
// redesign's navigation (bottom bar on a phone, side bar on desktop).
const tab = (label) => async (page) => {
  await page.getByRole("button", { name: new RegExp(`^\\s*${label}`) }).first().click();
};
const nav = (key) => async (page) => {
  await page.locator(`[data-nav="${key}"]:visible`).first().click();
};
const SCREENS = {
  before: {
    "sign-in": null,
    fees: tab("Fees"), results: tab("Results"), attendance: tab("Attendance"),
    notices: tab("Notices"), news: tab("From the school"), messages: tab("Messages"),
  },
  after: {
    "sign-in": null,
    home: nav("home"), results: nav("results"), attendance: nav("attendance"),
    fees: nav("fees"), messages: nav("messages"),
  },
}[phase];

const settle = async (page) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
};

// A full-page capture pins fixed elements where the first screen ends: the
// bottom bar lands mid-page and the sidebar stops short. For the picture only,
// anchor them to the whole page instead.
const PIN_FOR_CAPTURE = `
  [data-portal-root] { position: relative; }
  [data-portal-root] > nav { position: absolute !important; }
  [data-portal-root] > header { position: relative !important; }`;

const browser = await chromium.launch();
for (const [size, viewport] of Object.entries(SIZES)) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-GB" });
  const page = await context.newPage();
  await page.goto(BASE);
  await settle(page);
  for (const [name, go] of Object.entries(SCREENS)) {
    if (only.length && !only.includes(name)) {
      if (name === "sign-in") await signIn(page);
      continue;
    }
    if (go) await go(page);
    await settle(page);
    const pin = await page.addStyleTag({ content: PIN_FOR_CAPTURE });
    await page.screenshot({ path: path.join(OUT, `${name}-${size}.png`), fullPage: true });
    await pin.evaluate((el) => el.remove());
    console.log(`  ${phase}/${name}-${size}.png`);
    if (name === "sign-in") await signIn(page);
  }
  await context.close();
}
await browser.close();

async function signIn(page) {
  await page.locator('input[autocomplete="username"]').fill(login.admissionNo);
  await page.locator('input[autocomplete="one-time-code"]').fill(login.code);
  await page.locator('button[type="submit"]').click();
  await settle(page);
}
