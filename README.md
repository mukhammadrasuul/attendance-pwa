# Enterprise Decoupled PWA Attendance (Netlify + Apps Script)

This project implements a decoupled architecture:

1. `web/` is a PWA frontend (Netlify static hosting).
2. `netlify/functions/gas-proxy.js` is a backend-for-frontend (BFF) proxy.
3. `Code.gs` is the Apps Script backend (Sheets writes + calculations).

## 1) Architecture

- Browser never calls Apps Script directly.
- Browser calls `/api/bootstrap` and `/api/attendance` on the same Netlify domain.
- Netlify Function forwards requests to Apps Script with `API_SHARED_SECRET`.
- Apps Script validates secret, performs dedupe/idempotency, writes attendance, recalculates daily/monthly statistics.

## 2) Folder Structure

- `/Users/macbookair13/Documents/appscript based attendance form/Code.gs`
- `/Users/macbookair13/Documents/appscript based attendance form/netlify/functions/gas-proxy.js`
- `/Users/macbookair13/Documents/appscript based attendance form/netlify.toml`
- `/Users/macbookair13/Documents/appscript based attendance form/web/index.html`
- `/Users/macbookair13/Documents/appscript based attendance form/web/assets/app.js`
- `/Users/macbookair13/Documents/appscript based attendance form/web/assets/styles.css`
- `/Users/macbookair13/Documents/appscript based attendance form/web/sw.js`
- `/Users/macbookair13/Documents/appscript based attendance form/web/manifest.webmanifest`

## 3) Apps Script Setup (Backend)

1. Create a new Apps Script project.
2. Paste the content of `/Users/macbookair13/Documents/appscript based attendance form/Code.gs`.
3. Open **Project Settings** -> **Script properties** and set:
- `SPREADSHEET_ID` = your Google Spreadsheet ID
- `API_SHARED_SECRET` = long random secret (same value used in Netlify env)
4. Deploy as **Web app**:
- Execute as: `Me`
- Who has access: `Anyone`
5. Copy deployment URL (example: `https://script.google.com/macros/s/.../exec`).

## 4) Netlify Setup (Frontend + Proxy)

1. Push this folder to GitHub.
2. Create Netlify site from the repo.
3. Netlify detects `netlify.toml`:
- Publish directory: `web`
- Functions directory: `netlify/functions`
4. In Netlify -> **Site configuration** -> **Environment variables**, add:
- `GAS_WEB_APP_URL` = Apps Script web app URL
- `GAS_SHARED_SECRET` = same value as Apps Script `API_SHARED_SECRET`
5. Trigger redeploy.

Important:
- After every `Code.gs` change, create a **new Apps Script deployment version**.
- Verify backend version quickly by opening your Apps Script URL in browser:
  - Expected JSON field: `version: "1.2.1"`

## 5) Usage

1. Open your Netlify URL with branch parameter, for example:
- `https://your-site.netlify.app/?branch=Фарғона`
2. Select employee.
3. Select status (`Keldim`, `Ketdim`, `Ishim bor`, `Ishim bitdi`).
4. Click `Rasmga Olish`.
5. Click `Saqlash`.

Notes:
- Save is optimistic: UI confirms immediately and resets.
- Submission is queued and retried in background if network fails.
- Duplicate consecutive status is silently ignored by backend.

## 6) Step-by-Step Testing Checklist

### A. Bootstrap/branch test

1. Open `https://your-site.netlify.app/?branch=Фарғона`.
2. Confirm only active employees of `Фарғона` appear.
3. Confirm employees with `status != faol` are excluded.

### B. Camera test

1. Open in Chrome on Windows laptop.
2. Confirm camera permission prompt appears (if first time).
3. If not auto-started, click `Rasmga Olish` and confirm camera starts via user gesture fallback.
4. Capture should replace live view in same frame.

### C. Attendance write + dedupe

1. Submit `Keldim` once -> attendance row should be written.
2. Submit `Keldim` again immediately for same employee -> UI success but no extra raw row should be added.

### D. Statistics calculation

1. `Keldim` after expected start -> `statistika.late time` > 0.
2. Verify penalty formula: `(soatbay ish xaqi / 60) * late minutes`.
3. Verify `today salary = kunlik ish xaqi - penalty`.
4. Submit `Ishim bor` then `Ishim bitdi` -> outwork minutes should update.
5. Submit `Ketdim` before expected end -> early minutes should update.
6. Confirm `monthly statistics` row updates/creates for current month/year.

### E. Offline queue test

1. Disconnect internet.
2. Capture + Save attendance.
3. Reconnect internet.
4. Queue should auto-flush and row should appear in `attendance`.

## 7) Operational Hardening Recommendations

1. Rotate `API_SHARED_SECRET` quarterly.
2. Restrict Netlify function abuse with rate limiting (if traffic grows).
3. Add a monitoring sheet or alert on backend exceptions.
4. Archive old photo data to Drive when `attendance` size grows.
5. Add Netlify deploy previews for release validation before production.

## 8) Common Issues

1. Empty employee dropdown:
- Wrong `SPREADSHEET_ID`
- Wrong branch value in URL
- Branch naming mismatch in sheet
- Old Apps Script deployment still active (new code not deployed)

2. Unauthorized backend response:
- `GAS_SHARED_SECRET` and `API_SHARED_SECRET` mismatch

3. Camera blocked:
- Site permissions blocked in browser settings
- Non-HTTPS URL
- Laptop camera in use by another application

4. Custom logo in installed PWA:
- Replace `/Users/macbookair13/Documents/appscript based attendance form/web/assets/logo.png` with your own logo.
- Installed PWA icon files are:
  - `/Users/macbookair13/Documents/appscript based attendance form/web/assets/icon-192.png`
  - `/Users/macbookair13/Documents/appscript based attendance form/web/assets/icon-512.png`
- Redeploy Netlify, then uninstall/reinstall the PWA to refresh icon cache.
