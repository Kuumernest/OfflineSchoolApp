# Parent portal redesign

Branch `feat/parent-portal-redesign`. Screenshots of every screen before and
after, at phone width (390px) and desktop (1280px):

- `before/` — the portal as it was: one page, six tabs.
- `after/` — the redesign, added screen by screen.

## Screens

| Screen | Before | After |
|---|---|---|
| Sign-in | `sign-in` | `sign-in` |
| Home (new) | — | `home`, `home-fr` (in French) |
| Results | `results` | `results` |
| Attendance | `attendance` | `attendance` |
| Fees | `fees` | `fees` |
| Messages (conversations, notices, news) | `messages`, `notices`, `news` | `messages`, `messages-notices`, `messages-news` |

The phone app's portal (`mobile/app/portal/`) has the same redesign; see
[The phone app](#the-phone-app) below.

## Rule

A parent can have many children. Home shows a card per child; every other
screen has a child switcher (avatar, name, class) when there is more than one.

## Data

Built on the portal API as it was. Additions are read-only and change no
calculation:

- `GET /portal/home` — every child's card in one request (slow data): latest
  published result with the previous one, attendance this month, fee balance
  (the family ledger, as Fees) with overdue and due date by the school's own
  rule (`feeReminders.candidates`), the class's next exam, the latest
  announcement. `check:portalhome`.
- `/portal/results` names the exam and lists the newest first within a term.

## Taking the screenshots

```sh
node backend/scripts/portal-demo.js --out /tmp/portal-demo-login.json   # seeded in-memory backend on :5000
(cd web && npx vite --port 5173)                                         # web, proxies /api to :5000
npm i --prefix /tmp/pw playwright-core@1.48.2                            # not an app dependency
PW_DIR=/tmp/pw node docs/parent-portal/harness/shots.mjs after [screen ...]
```

The demo is Mrs Bate and her three children (Form 1, Form 3, Lower Sixth),
chosen so every state shows: improving / falling / steady results, an overdue
fee, a fee not yet due, fees paid up, an absence and a late arrival.

## The phone app

`mobile/app/portal/index.js` is the shell: sign-in, the session, one
ticketed, tab-tagged load (cached per child, and per month for attendance,
for offline), polling, receipts and report cards. Each screen is its own
file in `mobile/src/components/portal/`, the phone's copy of the web
screen of the same name:

| Screen | Before (`mobile/before/`) | After (`mobile/after/`) |
|---|---|---|
| Sign-in | `sign-in` | `sign-in` |
| Home (new) | — | `home`, `home-fr` (in French) |
| Results | `results` | `results` |
| Attendance | `attendance` | `attendance` |
| Fees | `fees` | `fees` |
| Messages (conversations, notices, news) | `messages`, `notices`, `news` | `messages`, `messages-notices`, `messages-news` |

Five sections in a bottom bar instead of six tabs scrolling sideways; a
child switcher on Results, Attendance and Fees; EN | FR in the header and
on sign-in; Ionicons outline icons; 44px targets; loading placeholders and
empty states. Metro cannot import from `shared/`, so the two number helpers
(`ordinal`, `on20`) are copied into `theme.js`, as `i18n/format.js` already
copies `shared/dateFormat.js`. The web's portal strings were ported to the
phone's catalogues.

Taking the phone's screenshots (Expo web at 390px; the layout and strings
are the phone's, the fonts the browser's):

```sh
node backend/scripts/portal-demo.js --out /tmp/portal-demo-login.json
(cd mobile && EXPO_PUBLIC_API_URL=http://localhost:5000/api npx expo start --web --port 8081)
PW_DIR=/tmp/pw node docs/parent-portal/harness/mobile-shots.mjs after [screen ...]
```

expo-secure-store has no web implementation, so the harness swaps the
bundle's copy for one backed by localStorage while it takes the shots; the
app itself is unchanged. The demo backend is in memory: restart it before a
full run if a previous one marked notices read.

