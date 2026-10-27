// docs/parent-portal/harness/mobile-shots.mjs
//
// Screenshots of the phone app's parent portal (mobile/app/portal), rendered
// with Expo web at 390px, into docs/parent-portal/mobile/<phase>/<screen>.png.
//
//   1. backend:  node backend/scripts/portal-demo.js --out /tmp/portal-demo-login.json
//   2. app:      (cd mobile && EXPO_PUBLIC_API_URL=http://localhost:5000/api npx expo start --web --port 8081)
//   3. shots:    PW_DIR=<dir with playwright-core installed> \
//                node docs/parent-portal/harness/mobile-shots.mjs <before|after> [screen ...]
//
// Expo web is the React Native code drawn by react-native-web: the layout and
// the strings are the phone's, the fonts and the status bar are the browser's.

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
const BASE  = process.env.PORTAL_URL || "http://localhost:8081/portal";
const login = JSON.parse(fs.readFileSync(process.env.LOGIN_FILE || path.join(os.tmpdir(), "portal-demo-login.json"), "utf8"));
const OUT   = path.join(HERE, "..", "mobile", phase);
fs.mkdirSync(OUT, { recursive: true });

// By the accessible name each control carries (labels change with language,
// so "after" uses testIDs, which react-native-web renders as data-testid).
const byText = (label) => async (page) => {
  await page.getByText(new RegExp(`^\\s*${label}`)).first().click();
};
const byId = (id) => async (page) => {
  await page.locator(`[data-testid="${id}"]`).first().click();
};

const SCREENS = {
  before: {
    "sign-in": null,
    fees: byText("Fees"), results: byText("Results"), attendance: byText("Attendance"),
    notices: byText("Notices"), news: byText("From the school"), messages: byText("Messages"),
  },
  after: {
    "sign-in": null,
    home: byId("portal-nav-home"), results: byId("portal-nav-results"),
    attendance: byId("portal-nav-attendance"), fees: byId("portal-nav-fees"),
    messages: byId("portal-nav-messages"),
    "messages-notices": byId("portal-msg-notices"), "messages-news": byId("portal-msg-news"),
    // Last, so every shot above stays in English.
    "home-fr": async (page) => { await byId("portal-lang-fr")(page); await byId("portal-nav-home")(page); },
  },
}[phase];

const settle = async (page) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(900);
};

// expo-secure-store has no web implementation (its web module is `{}`), and
// the portal keeps its session there. For these shots only, the bundle's copy
// of that module is swapped for one backed by localStorage. The app is not
// changed; a phone still uses the keychain.
const SECURE_STORE_WEB = /var _default = \{\};(\s*\},\d+,\[\],"node_modules\/expo-secure-store\/build\/ExpoSecureStore\.web\.js")/;
const LOCAL_STORE = `var _default = {
    getValueWithKeyAsync: async (k) => localStorage.getItem("ss:" + k),
    getValueWithKeySync: (k) => localStorage.getItem("ss:" + k),
    setValueWithKeyAsync: async (v, k) => { localStorage.setItem("ss:" + k, v); },
    setValueWithKeySync: (v, k) => { localStorage.setItem("ss:" + k, v); },
    deleteValueWithKeyAsync: async (k) => { localStorage.removeItem("ss:" + k); },
    canUseBiometricAuthentication: () => false,
  };`;

const browser = await chromium.launch();
try {
  const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "en-GB" });
  // Lazy chunks are bundles too; only the one holding the module is changed.
  let swapped = false;
  await ctx.route(/\.bundle\?/, async (route) => {
    const res  = await route.fetch();
    const body = await res.text();
    if (SECURE_STORE_WEB.test(body)) swapped = true;
    await route.fulfill({ response: res, body: body.replace(SECURE_STORE_WEB, `${LOCAL_STORE}$1`) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200)); });
  page.on("requestfailed", (r) => console.log("requestfailed:", r.url().slice(0, 120), r.failure()?.errorText));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) console.log("api", r.status(), r.url().slice(0, 120)); });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator("input").first().waitFor({ timeout: 60_000 }).catch(() => {});
  if (!swapped) throw new Error("expo-secure-store's web module was not found in the bundle");
  await settle(page);

  const want = (name) => only.length === 0 || only.includes(name);
  if (want("sign-in")) await page.screenshot({ path: path.join(OUT, "sign-in.png"), fullPage: true });

  const inputs = page.locator("input");
  await inputs.nth(0).fill(login.admissionNo);
  await inputs.nth(1).fill(login.code);
  await inputs.nth(1).press("Enter").catch(() => {});
  await page.getByText(/^(Sign in|Se connecter)$/).first().click().catch(() => {});
  await settle(page);

  for (const [name, go] of Object.entries(SCREENS)) {
    if (!go) continue;
    await go(page);
    await settle(page);
    if (!want(name)) continue;
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log("shot", phase, name);
  }
} catch (err) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(OUT, "_failed.png"), fullPage: true }).catch(() => {});
  throw err;
} finally {
  await browser.close();
}
