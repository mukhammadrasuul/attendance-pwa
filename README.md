# Attendance System (Decoupled Apps Script Architecture)

This version is optimized for reliability and speed:

1. API write path saves only to `attendance` (fast).
2. Image upload runs as background follow-up request after attendance is persisted.
3. Daily statistics are updated by a background worker.
4. Monthly statistics are updated by a nightly worker.

## Files

- `/Users/macbookair13/Documents/appscript based attendance form/Code.gs`
- `/Users/macbookair13/Documents/appscript based attendance form/netlify/functions/gas-proxy.js`
- `/Users/macbookair13/Documents/appscript based attendance form/netlify.toml`
- `/Users/macbookair13/Documents/appscript based attendance form/web/` (PWA frontend)

## Required Spreadsheet Sheets

1. `xodimlar`
2. `attendance`
3. `statistika`
4. `monthly statistics`
5. `today_state` (auto-created if missing)

## 1) Apps Script Setup

1. Open your Apps Script project.
2. Replace code with `/Users/macbookair13/Documents/appscript based attendance form/Code.gs`.
3. In **Project Settings -> Script properties**, set:
- `SPREADSHEET_ID` = production spreadsheet id
- `API_SHARED_SECRET` = long random secret
4. Deploy Web App:
- Execute as: `Me`
- Access: `Anyone`
5. Open web app URL and verify JSON has:
- `"version":"2.3.2"`

## 2) Netlify Setup

In Netlify environment variables:

- `GAS_WEB_APP_URL` = Apps Script web app URL
- `GAS_SHARED_SECRET` = same value as Apps Script `API_SHARED_SECRET`

Trigger redeploy.

## 3) Worker Trigger Setup (Important)

Create **installable triggers** in Apps Script:

1. Daily incremental worker
- Function: `processAttendanceToDailyStats`
- Event type: Time-driven
- Frequency: Every 1 minute (or 5 minutes)

2. Nightly monthly rollup
- Function: `runNightlyMonthlyRollup`
- Event type: Time-driven
- Frequency: Daily
- Time: night (e.g., 23:00-23:59)

3. Image sync reconciler (recommended)
- Function: `reconcileAttendanceImageStatuses`
- Event type: Time-driven
- Frequency: Every 5 minutes (or 15 minutes)

## 4) First-Time Worker Initialization

If you want worker to start from current attendance row and skip old historical rows:

1. Run function: `initializeAttendanceCursorToCurrentLastRow`
2. Accept permissions.

If you want to process all history, do not run this initializer.

## 5) Runtime Flow

1. Frontend calls `/api/attendance`.
2. Apps Script validates, dedupes, writes one row to `attendance` immediately.
3. Frontend uploads image in background to attach it by `attendanceId`.
4. `processAttendanceToDailyStats` updates `statistika` asynchronously.
5. `runNightlyMonthlyRollup` updates `monthly statistics` once per night.

## 6) API Behavior Guarantees

1. Success is returned only when attendance write is persisted.
2. Duplicate consecutive status is silently ignored (dedupe).
3. `requestId` retries are idempotent.
4. If background image upload fails, attendance row remains persisted and image upload is retried while app is open.
5. Image sync state is tracked in `attendance`:
- column 6: `image_sync_status` (`pending`, `uploaded`, `failed`)
- column 7: `image_sync_at` (timestamp)
6. Status sequence is validated per employee per day using `today_state`:
- first status must be `Keldim`
- `Keldim` -> `Ishim bor` or `Ketdim`
- `Ishim bor` -> `Ishim bitdi`
- `Ishim bitdi` -> `Ketdim`
- invalid order returns `code: INVALID_SEQUENCE` with allowed next statuses

## 7) Testing Checklist

1. Open app URL with branch:
- `https://attendance-uz.netlify.app/?branch=Фарғона`
2. Save one record and confirm new row in `attendance` immediately.
3. Wait for daily worker trigger and confirm row updates in `statistika`.
4. Run `runNightlyMonthlyRollup` manually once and verify `monthly statistics`.
5. Retry same requestId (or duplicate same status) and verify no duplicate row write.
6. Validation test:
- choose employee with no record today, try `Ketdim` first -> must return validation error
- then save `Keldim` -> must succeed
- after `Ketdim`, try `Keldim` again same day -> must return validation error

## 8) Troubleshooting

1. Empty employee list:
- wrong `SPREADSHEET_ID`
- wrong branch value
- old Apps Script deployment version

2. Unauthorized:
- `GAS_SHARED_SECRET` != `API_SHARED_SECRET`

3. Slow save:
- check network/upload speed
- ensure workers are not called in save path

4. No daily/monthly updates:
- missing installable triggers
- worker permissions not granted
