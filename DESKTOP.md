# Laxorq Automate — desktop app + releases

Two ways to run this, built from the *same* `server.js`:

| | Who | How | Data lives in |
|---|---|---|---|
| **Desktop app** | You (the operator) | Install the `.exe` / `.dmg`, double-click | `%APPDATA%\laxorq-automate\data` (Win) / `~/Library/Application Support/laxorq-automate/data` (Mac) |
| **Installed on a phone (PWA)** | You + your clients | Open the dashboard URL in a browser → Install / Add to Home Screen | The server the URL points at |

The desktop app is a self-contained control centre: it boots the server in-process and opens the dashboard in its own window — no terminal, no `node server.js`. It runs on *your* machine, so for clients (and your phone) to reach it, the machine has to be reachable — see "Getting it onto phones" below.

## Run in development

```
npm install
npm start        # plain server on http://localhost:4000
npm run app      # the Electron desktop window
```

## Build the installer

```
npm run dist     # → dist\Laxorq Automate Setup <version>.exe  (Win)
```

- Windows produces an NSIS installer (choose folder, desktop shortcut).
- On a Mac, `npm run dist` produces a `.dmg`; on Linux an `.AppImage`. Build each on its own OS (electron-builder does not cross-compile signed installers).
- The app icon comes from `build/icon.png` (regenerate the icon set with `npm run icons`).

## One-click auto-update (like Reception)

`electron-updater` checks GitHub Releases on launch when the app is packaged and `build.publish.owner` is set (currently `s4vscalez` / `laxorq-automate`). To publish a new version:

1. Bump `version` in `package.json`.
2. `set GH_TOKEN=<a GitHub token with repo scope>`
3. `npm run publish` (builds + uploads to a GitHub Release).

Installed copies then offer "Restart to update." **Gotcha carried over from Reception:** electron-builder auto-publish can race and leave the installer unattached to the release. If that happens, the reliable path is to build locally (`npm run dist`) then attach the files with `gh release create v<version> "dist\Laxorq Automate Setup <version>.exe" ...`.

**Electron binary gotcha (same machine as Reception):** an npm optional-dependency bug can leave the actual electron binary undownloaded (`npm run app` errors that electron isn't installed). Fix: download `electron-v<ver>-win32-x64.zip` from the electron GitHub releases into `node_modules\electron\dist\`, then create `node_modules\electron\path.txt` containing `electron.exe`.

## Safety layer (built into server.js)

- **Auto DB backup** before every open → `data\backups\` (last 10 kept). Updating can never lose leads.
- **Migration runner** (`user_version` + `SCHEMA_VERSION` + `ensureColumn`) for safe schema changes.
- **Crash guards** on `uncaughtException` / `unhandledRejection` so one bad request can't kill the app.
- **`/api/health`** returns version, schema version, client/user counts.
- `AUTOMATE_DATA_DIR` env points the DB at a writable per-user folder inside the packaged app.

## Getting it onto phones (yours + clients')

The desktop app serves the dashboard at `http://localhost:4000` — only reachable on that one machine. To use it from a phone or let clients log in:

1. **Expose the server.** Quick: `cloudflared tunnel --url http://localhost:4000` (temporary HTTPS URL). Permanent: deploy `server.js` to an always-on host (a ~$5/mo VPS) and point a subdomain at it with HTTPS. It's a stateful server, so a normal VM/container — not Vercel.
2. **Install the PWA.** Open that HTTPS URL on the phone → Add to Home Screen (iOS Safari) / Install app (Android Chrome). It then behaves like a native app.
3. Clients log in with the account you create for them (Clients page → "Create a login for this client") and see only their own leads + conversions.

For reliable Day-1/3/7 follow-ups the server needs to be up when touches come due, which is why a paying-client setup wants the always-on host rather than your laptop.
