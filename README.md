# Laxorq Automate

Lead capture, AI qualification, instant replies, an automatic 3-touch follow-up engine, and a **conversion analytics dashboard** — with logins so **you see every client** and **each client sees only their own leads and results.**

Cross-platform and installable: one central server, and the dashboard installs as an **app on iPhone, Android, Windows, Mac and ChromeOS** straight from the browser (it is a PWA — no app store needed).

## Two ways to run it

**A. Desktop app (recommended for you).** A real installable program — the server is bundled inside, no terminal. Build/install it per [DESKTOP.md](DESKTOP.md):

```
npm install
npm run app      # run the desktop window now
npm run dist     # build the installer (.exe on Windows, .dmg on Mac, .AppImage on Linux)
```

It auto-updates from GitHub Releases and keeps its database (with automatic backups) in your per-user app folder. Same Electron + one-click-update setup as Laxorq Reception.

**B. Plain server (for hosting / quick runs).** Needs Node.js 22.5+ (built-in SQLite). Zero `npm` dependencies for this path.

- **Windows:** double-click `start-automate.bat`
- **Mac / Linux:** `chmod +x start-automate.sh && ./start-automate.sh`
- **Any:** `node server.js`

Either way: open http://localhost:4000. First launch asks you to **create your owner account** — that master login sees everything. Data lives in `data\automate.db` (or the desktop app's per-user folder).

## Install it as an app (you and your clients)

Open the dashboard URL in a browser, then:
- **iPhone/iPad (Safari):** Share → Add to Home Screen
- **Android (Chrome):** menu → Install app (or the "Install app" button in the top bar)
- **Windows/Mac (Chrome/Edge):** the install icon in the address bar, or the "Install app" button

It then opens like a native app, full-screen, with its own icon.

## Roles

- **Owner (you):** every client workspace, the follow-up queue, client logins, SMTP + AI settings, workflow toggles.
- **Client:** logs in and sees only their own workspace — **Results (analytics), My leads, Follow-ups.** No access to other clients, your API keys, or settings.

Create a client login from the **Clients** page → "Create a login for this client" → give them the email + password. They can now watch their leads and conversions from any device.

## What clients see (the Results page)

- Leads captured, **conversion rate**, reply rate, average first-response time
- A conversion **funnel**: Captured → Contacted → Replied → Booked
- **Bookings by month** with the monthly **booking rate** (appointments booked ÷ leads captured) and this-vs-last-month change — the headline number for judging whether web + social marketing is working
- Where leads come from, lead quality (hot/warm/cold)
- A 30-day trend of leads vs conversions
- Revenue from booked leads (enter a deal value when you mark a lead "Booked")

This page *is* the client report — they can log in anytime instead of waiting for a screenshot.

## Website tracking

Each client can have their **website** saved (Clients page). Paste the one-line **tracking snippet** into the site's `<head>` and Laxorq counts visits; the embedded lead form tags each lead with where it came from (the site's domain, or a `utm_source`). The Results page then shows **visits → leads from the site → visit-to-lead conversion**, so a client can see whether their site traffic is actually turning into enquiries.

## Notifications (push, even when the app is closed)

Tap **🔔 Notifications** in the top bar to turn on push for that device. You (and clients) get an alert for:
- **Hot leads** that need a personal reply ("take over")
- **New bookings** / appointments

Works on desktop (Chrome/Edge/Firefox) and on phones once the app is added to the Home Screen (iOS requires the installed PWA). Each device is enabled once.

## Stay signed in

Sessions last 400 days and refresh on every use, so you sign in once per device (phone, desktop) and stay logged in — no repeated logins.

## Booking calendar

Marking a lead **Booked** opens a form to set the appointment date/time (and optional deal value). Those appointments show up on the **Calendar** tab (month grid + upcoming list) for both you and the client, and feed the monthly booking rate above.

## How the automation works

1. **Lead arrives** — hosted form (`/form?t=<token>`, one per client, shareable or embeddable), or added manually.
2. **Qualified instantly** — Hot/Warm/Cold. Rules-based by default; add an Anthropic API key (Settings) and Claude scores it *and* writes a personalised first reply.
3. **Instant reply** — auto-sends by email if SMTP is set; WhatsApp lands in the queue as a one-tap pre-filled message (auto-sending from a personal WhatsApp number breaks their ToS, so this stays human-tapped).
4. **Follow-up sequence** — WhatsApp Day 1, Email Day 3 (auto with SMTP), Call prompt Day 7, then archive. Marking a lead **replied/booked** cancels every pending touch.
5. **Conversions** — mark a lead Booked (with optional deal value) and it flows into everyone's analytics.

## Going live for real clients

The server must be reachable from the internet so clients can log in and forms can receive leads.

- **Quick test / demo:** `cloudflared tunnel --url http://localhost:4000` gives a temporary https URL (cloudflared is already installed on this machine). Logins work because the tunnel is https.
- **Always-on (recommended for paying clients):** put `server.js` on a small always-on box — a ~$5/mo VPS, or a spare laptop. It is a single Node process; set the `PORT` env var if needed and point a subdomain (e.g. app.laxorq.com) at it with HTTPS.

Because the follow-up scheduler only runs while the server is up, an always-on host is what makes the Day-1/3/7 touches fire reliably.

## Files

- `server.js` — the whole backend (HTTP + SQLite + SMTP + auth + analytics)
- `public/app.html` — the dashboard (owner + client)
- `public/form.html` — the public lead-capture form
- `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` — PWA install assets
- `gen-icons.js` — regenerates the app icons if you rebrand
- `data/automate.db` — your database (back this up)

## Want native store binaries too?

The PWA already installs on every platform. If you ever need a literal `.exe` / `.dmg` / Play Store build, the same server can be wrapped with Electron or Tauri pointing at it — a small add-on, not a rewrite. Ask when you get there.
