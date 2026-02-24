/**
 * Enterprise-grade decoupled backend for Attendance PWA.
 *
 * Usage:
 * - Deploy as Apps Script Web App.
 * - Call via POST JSON from Netlify Function (recommended), not directly from browser.
 *
 * Required Script Properties:
 * - SPREADSHEET_ID: target spreadsheet id
 * - API_SHARED_SECRET: shared secret expected from proxy
 */

const CONFIG = Object.freeze({
  SHEETS: Object.freeze({
    EMPLOYEES: 'xodimlar',
    ATTENDANCE: 'attendance',
    DAILY: 'statistika',
    MONTHLY: 'monthly statistics',
  }),
  STATUS: Object.freeze({
    ARRIVED: 'Keldim',
    LEFT: 'Ketdim',
    OUT_START: 'Ishim bor',
    OUT_END: 'Ishim bitdi',
  }),
  DRIVE: Object.freeze({
    ATTENDANCE_FOLDER_ID: '1kiqoaAJDx3967MzfcsgQVNCFggQ2aPSV',
  }),
  TIMEZONE: Session.getScriptTimeZone() || 'Asia/Tashkent',
});

/* ------------------------------ HTTP Entrypoints ------------------------------ */

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'attendance-api',
    version: '1.3.0',
    now: new Date().toISOString(),
  });
}

function doPost(e) {
  try {
    const body = parseRequestBody_(e);
    assertAuthorized_(body.apiKey);

    const action = String(body.action || '').trim();
    if (!action) throw httpError_(400, 'Missing action');

    if (action === 'bootstrap') {
      const branch = String(body.branch || '').trim();
      return jsonResponse_(buildBootstrap_(branch));
    }

    if (action === 'submitAttendance') {
      const result = submitAttendance_(body.payload || {});
      return jsonResponse_(result);
    }

    throw httpError_(400, `Unsupported action: ${action}`);
  } catch (err) {
    console.error(err);
    const status = err && err.httpStatus ? err.httpStatus : 500;
    return jsonResponse_({ ok: false, error: err.message || 'Server error', status });
  }
}

/* ------------------------------ API Services ------------------------------ */

function buildBootstrap_(branch) {
  const employees = getActiveEmployeesByBranch_(branch);
  return {
    ok: true,
    branch,
    employees,
    statuses: [
      CONFIG.STATUS.ARRIVED,
      CONFIG.STATUS.LEFT,
      CONFIG.STATUS.OUT_START,
      CONFIG.STATUS.OUT_END,
    ],
    apiVersion: '1.3.0',
    employeeCount: employees.length,
    serverTime: new Date().toISOString(),
  };
}

function submitAttendance_(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const data = validateSubmission_(payload);
    const now = new Date();

    // Idempotency guarantee for retried client submissions.
    if (data.requestId && attendanceIdExists_(data.requestId)) {
      return {
        ok: true,
        persisted: true,
        wroteNewRow: false,
        deduped: true,
        idempotent: true,
        apiVersion: '1.3.0',
      };
    }

    // Business dedupe: same employee + same status consecutively ignored.
    if (isConsecutiveDuplicate_(data.employeeId, data.status)) {
      return {
        ok: true,
        persisted: true,
        wroteNewRow: false,
        deduped: true,
        idempotent: false,
        apiVersion: '1.3.0',
      };
    }

    let imagePath = '';
    const warnings = [];
    try {
      imagePath = saveAttendanceImageToDrive_(data.imageData, data.requestId);
    } catch (uploadErr) {
      // Never block attendance logging on image upload failures.
      // Keep a deterministic placeholder path for traceability/recovery jobs.
      const fallbackName = makeAttendanceImageFileName_(data.requestId, 'jpg');
      imagePath = `attendance_Images/${fallbackName}`;
      const uploadWarning = `Image upload failed: ${uploadErr.message}`;
      warnings.push(uploadWarning);
      console.error(uploadWarning);
    }

    appendAttendanceRow_({
      attendanceId: data.requestId || Utilities.getUuid(),
      employeeId: data.employeeId,
      datetime: now,
      status: data.status,
      imagePath,
    });

    try {
      recalcDailyStatForEmployeeDate_(data.employeeId, now);
      recalcMonthlyStatForEmployeeMonth_(data.employeeId, now);
    } catch (statsErr) {
      const statsWarning = `Attendance saved, but statistics update failed: ${statsErr.message}`;
      warnings.push(statsWarning);
      console.error(statsWarning);
    }

    return {
      ok: true,
      persisted: true,
      wroteNewRow: true,
      deduped: false,
      idempotent: false,
      imagePath,
      warning: warnings.join(' | '),
      apiVersion: '1.3.0',
    };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------ Validation / Auth ------------------------------ */

function parseRequestBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw httpError_(400, 'Empty request body');

  try {
    return JSON.parse(e.postData.contents);
  } catch (_err) {
    throw httpError_(400, 'Invalid JSON body');
  }
}

function assertAuthorized_(apiKey) {
  const expected = getRequiredProperty_('API_SHARED_SECRET');
  if (String(apiKey || '') !== expected) throw httpError_(401, 'Unauthorized');
}

function validateSubmission_(payload) {
  if (!payload || typeof payload !== 'object') throw httpError_(400, 'payload must be an object');

  const employeeId = String(payload.employeeId || '').trim();
  const status = String(payload.status || '').trim();
  const imageData = String(payload.imageData || '').trim();
  const requestId = String(payload.requestId || '').trim();

  if (!employeeId) throw httpError_(400, 'employeeId is required');
  if (!Object.values(CONFIG.STATUS).includes(status)) throw httpError_(400, 'Invalid status');
  if (!imageData.startsWith('data:image/')) throw httpError_(400, 'imageData must be data URL');

  return { employeeId, status, imageData, requestId };
}

/* ------------------------------ Spreadsheet Access ------------------------------ */

function getSpreadsheet_() {
  const rawRef = getRequiredProperty_('SPREADSHEET_ID').trim();
  const spreadsheetId = extractSpreadsheetId_(rawRef);

  // 1) If full URL is provided, try URL first.
  if (/^https?:\/\//i.test(rawRef)) {
    try {
      return SpreadsheetApp.openByUrl(rawRef);
    } catch (_errByUrl) {
      // fall through to id-based open
    }
  }

  // 2) ID-based open.
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (_errById) {
    // 3) DriveApp fallback avoids some intermittent openById runtime issues.
    try {
      const file = DriveApp.getFileById(spreadsheetId);
      return SpreadsheetApp.open(file);
    } catch (errByDrive) {
      throw httpError_(
        500,
        `Unable to open spreadsheet from SPREADSHEET_ID. Check property value, share permissions, and deployment auth. Detail: ${errByDrive.message}`
      );
    }
  }
}

function getSheetOrThrow_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw httpError_(500, `Sheet not found: ${name}`);
  return sheet;
}

function getRequiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw httpError_(500, `Missing script property: ${name}`);
  return value;
}

function extractSpreadsheetId_(rawRef) {
  const ref = String(rawRef || '').trim();
  if (!ref) throw httpError_(500, 'SPREADSHEET_ID is empty');

  // Accept either:
  // 1) Plain spreadsheet id
  // 2) Full spreadsheet URL
  const urlMatch = ref.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];

  return ref;
}

/* ------------------------------ Employee / Branch ------------------------------ */

function getActiveEmployeesByBranch_(branchParam) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.EMPLOYEES);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const requestedBranchKey = branchKey_(branchParam);

  return values
    .slice(1)
    .map((row) => ({
      id: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      surname: String(row[2] || '').trim(),
      activeStatus: String(row[3] || '').trim(),
      branch: String(row[8] || '').trim(),
    }))
    .filter((emp) => emp.id)
    .filter((emp) => normalizeText_(emp.activeStatus) === 'faol')
    .filter((emp) => {
      if (!requestedBranchKey) return true;
      return branchKey_(emp.branch) === requestedBranchKey;
    })
    .map((emp) => ({
      id: emp.id,
      fullName: `${emp.name} ${emp.surname}`.trim(),
      branch: emp.branch,
    }));
}

function branchKey_(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  return normalizeText_(uzbekCyrillicToLatin_(raw))
    .replace(/[’'`ʻ\-]/g, '')
    .replace(/\s+/g, '');
}

function uzbekCyrillicToLatin_(text) {
  const map = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'j',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
    'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 's',
    'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'yu',
    'я': 'ya', 'ў': 'o', 'қ': 'q', 'ғ': 'g', 'ҳ': 'h',
  };

  const lower = String(text || '').toLowerCase();
  let output = '';
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i];
    output += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
  }
  return output;
}

/* ------------------------------ Attendance Writes ------------------------------ */

function appendAttendanceRow_(row) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  sheet.appendRow([
    row.attendanceId,
    row.employeeId,
    row.datetime,
    row.status,
    row.imagePath,
  ]);
}

/**
 * Saves data-url image into target Drive folder and returns sheet path value.
 * Example output: attendance_Images/bb7c88eb.1770876524190.jpg
 */
function saveAttendanceImageToDrive_(imageDataUrl, requestId) {
  const parsed = parseDataUrlImage_(imageDataUrl);
  const folder = getAttendanceImageFolder_();
  const ext = extensionFromMimeType_(parsed.mimeType);
  const fileName = makeAttendanceImageFileName_(requestId, ext);

  const bytes = Utilities.base64Decode(parsed.base64Data);
  const blob = Utilities.newBlob(bytes, parsed.mimeType, fileName);
  const file = folder.createFile(blob);

  // Keep a stable, integration-friendly path format in sheet.
  return `attendance_Images/${file.getName()}`;
}

function parseDataUrlImage_(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw httpError_(400, 'Invalid image data URL format');

  return {
    mimeType: match[1],
    base64Data: match[2],
  };
}

function extensionFromMimeType_(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return map[String(mimeType || '').toLowerCase()] || 'jpg';
}

function makeAttendanceImageFileName_(requestId, ext) {
  const raw = String(requestId || Utilities.getUuid()).toLowerCase();
  const safe = raw.replace(/[^a-z0-9]/g, '');
  const shortId = (safe || Utilities.getUuid().replace(/-/g, '')).slice(0, 8);
  return `${shortId}.${Date.now()}.${ext}`;
}

function getAttendanceImageFolder_() {
  const folderId = CONFIG.DRIVE.ATTENDANCE_FOLDER_ID;
  try {
    return DriveApp.getFolderById(folderId);
  } catch (err) {
    throw httpError_(
      500,
      `Attendance image folder is not accessible. Verify folder ID and script permissions. Detail: ${err.message}`
    );
  }
}

function attendanceIdExists_(attendanceId) {
  if (!attendanceId) return false;

  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = sheet.getDataRange().getValues();

  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i][0] || '').trim() === attendanceId) return true;
  }

  return false;
}

function isConsecutiveDuplicate_(employeeId, status) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = sheet.getDataRange().getValues();

  for (let i = values.length - 1; i >= 1; i -= 1) {
    const rowEmployeeId = String(values[i][1] || '').trim();
    if (rowEmployeeId !== employeeId) continue;

    const lastStatus = String(values[i][3] || '').trim();
    return lastStatus === status;
  }

  return false;
}

/* ------------------------------ Daily Statistics ------------------------------ */

function recalcDailyStatForEmployeeDate_(employeeId, dateTime) {
  const employee = getEmployeeById_(employeeId);
  const logs = getEmployeeLogsForDate_(employeeId, dateTime);
  const metrics = computeDailyMetrics_(employee, dateTime, logs);
  upsertDailyRow_(employeeId, dateTime, metrics);
}

function getEmployeeById_(employeeId) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.EMPLOYEES);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    if (String(row[0] || '').trim() === employeeId) {
      return {
        id: employeeId,
        dailySalary: toNumber_(row[4]),
        hourlySalary: toNumber_(row[5]),
        expectedStartRaw: row[6],
        expectedEndRaw: row[7],
      };
    }
  }

  throw httpError_(404, `Employee not found: ${employeeId}`);
}

function getEmployeeLogsForDate_(employeeId, dateTime) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = sheet.getDataRange().getValues();
  const dateKey = formatDateKey_(dateTime);

  return values
    .slice(1)
    .map((row) => ({
      employeeId: String(row[1] || '').trim(),
      datetime: asDate_(row[2]),
      status: String(row[3] || '').trim(),
    }))
    .filter((r) => r.employeeId === employeeId && r.datetime)
    .filter((r) => formatDateKey_(r.datetime) === dateKey)
    .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

function computeDailyMetrics_(employee, dateTime, logs) {
  const expectedStart = combineDateAndTime_(dateTime, employee.expectedStartRaw);
  const expectedEnd = combineDateAndTime_(dateTime, employee.expectedEndRaw);

  const arrivals = logs.filter((l) => l.status === CONFIG.STATUS.ARRIVED);
  const leaves = logs.filter((l) => l.status === CONFIG.STATUS.LEFT);
  const outStarts = logs.filter((l) => l.status === CONFIG.STATUS.OUT_START);
  const outEnds = logs.filter((l) => l.status === CONFIG.STATUS.OUT_END);

  let lateMinutes = 0;
  if (arrivals.length && expectedStart) lateMinutes = diffMinutesPositive_(expectedStart, arrivals[0].datetime);

  let earlyMinutes = 0;
  if (leaves.length && expectedEnd) earlyMinutes = diffMinutesPositive_(leaves[leaves.length - 1].datetime, expectedEnd);

  const outworkMinutes = pairAndSumOutworkMinutes_(outStarts, outEnds);
  const penalty = round2_((employee.hourlySalary / 60) * lateMinutes);
  const todaySalary = round2_(Math.max(0, employee.dailySalary - penalty));

  return { lateMinutes, earlyMinutes, outworkMinutes, penalty, todaySalary };
}

function pairAndSumOutworkMinutes_(outStarts, outEnds) {
  const startTimes = outStarts.map((x) => x.datetime.getTime());
  const endTimes = outEnds.map((x) => x.datetime.getTime());

  let i = 0;
  let j = 0;
  let total = 0;

  while (i < startTimes.length && j < endTimes.length) {
    if (endTimes[j] <= startTimes[i]) {
      j += 1;
      continue;
    }
    total += Math.floor((endTimes[j] - startTimes[i]) / 60000);
    i += 1;
    j += 1;
  }

  return Math.max(0, total);
}

function upsertDailyRow_(employeeId, dateTime, metrics) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.DAILY);
  const values = sheet.getDataRange().getValues();
  const dateKey = formatDateKey_(dateTime);

  let foundRow = -1;
  for (let i = 1; i < values.length; i += 1) {
    const rowEmployeeId = String(values[i][1] || '').trim();
    const rowDate = asDate_(values[i][2]);
    if (!rowDate) continue;

    if (rowEmployeeId === employeeId && formatDateKey_(rowDate) === dateKey) {
      foundRow = i + 1;
      break;
    }
  }

  const existingId = foundRow > 0 ? String(sheet.getRange(foundRow, 1).getValue() || '').trim() : '';
  const rowId = existingId || Utilities.getUuid();

  const rowValues = [[
    rowId,
    employeeId,
    stripTime_(dateTime),
    metrics.lateMinutes,
    metrics.earlyMinutes,
    metrics.outworkMinutes,
    metrics.penalty,
    metrics.todaySalary,
  ]];

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowValues[0].length).setValues(rowValues);
  } else {
    sheet.appendRow(rowValues[0]);
  }
}

/* ------------------------------ Monthly Statistics ------------------------------ */

function recalcMonthlyStatForEmployeeMonth_(employeeId, dateTime) {
  const month = dateTime.getMonth() + 1;
  const year = dateTime.getFullYear();

  const attendanceMonth = getEmployeeAttendanceForMonth_(employeeId, month, year);
  const dailyMonth = getEmployeeDailyStatsForMonth_(employeeId, month, year);

  const workedDays = countUniqueDatesByStatus_(attendanceMonth, CONFIG.STATUS.ARRIVED);
  const lateCount = dailyMonth.filter((r) => toNumber_(r.lateMinutes) > 0).length;
  const overallLateHrs = sumBy_(dailyMonth, 'lateMinutes');
  const earlyCount = dailyMonth.filter((r) => toNumber_(r.earlyMinutes) > 0).length;
  const overallEarlyHrs = sumBy_(dailyMonth, 'earlyMinutes');
  const outworkCount = attendanceMonth.filter((r) => r.status === CONFIG.STATUS.OUT_START).length;
  const overallOutworkHrs = sumBy_(dailyMonth, 'outworkMinutes');
  const totalPenalty = round2_(sumBy_(dailyMonth, 'penalty'));
  const salary = round2_(sumBy_(dailyMonth, 'todaySalary'));

  upsertMonthlyRow_({
    employeeId,
    month,
    year,
    workedDays,
    lateCount,
    overallLateHrs,
    earlyCount,
    overallEarlyHrs,
    outworkCount,
    overallOutworkHrs,
    totalPenalty,
    salary,
  });
}

function getEmployeeAttendanceForMonth_(employeeId, month, year) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = sheet.getDataRange().getValues();

  return values
    .slice(1)
    .map((row) => ({
      employeeId: String(row[1] || '').trim(),
      datetime: asDate_(row[2]),
      status: String(row[3] || '').trim(),
    }))
    .filter((r) => r.employeeId === employeeId && r.datetime)
    .filter((r) => r.datetime.getMonth() + 1 === month && r.datetime.getFullYear() === year);
}

function getEmployeeDailyStatsForMonth_(employeeId, month, year) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.DAILY);
  const values = sheet.getDataRange().getValues();

  return values
    .slice(1)
    .map((row) => ({
      employeeId: String(row[1] || '').trim(),
      date: asDate_(row[2]),
      lateMinutes: toNumber_(row[3]),
      earlyMinutes: toNumber_(row[4]),
      outworkMinutes: toNumber_(row[5]),
      penalty: toNumber_(row[6]),
      todaySalary: toNumber_(row[7]),
    }))
    .filter((r) => r.employeeId === employeeId && r.date)
    .filter((r) => r.date.getMonth() + 1 === month && r.date.getFullYear() === year);
}

function upsertMonthlyRow_(m) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.MONTHLY);
  const values = sheet.getDataRange().getValues();

  let foundRow = -1;
  for (let i = 1; i < values.length; i += 1) {
    const rowEmployeeId = String(values[i][1] || '').trim();
    const rowMonth = toNumber_(values[i][2]);
    const rowYear = toNumber_(values[i][3]);

    if (rowEmployeeId === m.employeeId && rowMonth === m.month && rowYear === m.year) {
      foundRow = i + 1;
      break;
    }
  }

  const existingId = foundRow > 0 ? String(sheet.getRange(foundRow, 1).getValue() || '').trim() : '';
  const rowId = existingId || Utilities.getUuid();

  const rowValues = [[
    rowId,
    m.employeeId,
    m.month,
    m.year,
    m.workedDays,
    m.lateCount,
    m.overallLateHrs,
    m.earlyCount,
    m.overallEarlyHrs,
    m.outworkCount,
    m.overallOutworkHrs,
    m.totalPenalty,
    m.salary,
  ]];

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowValues[0].length).setValues(rowValues);
  } else {
    sheet.appendRow(rowValues[0]);
  }
}

/* ------------------------------ Helpers ------------------------------ */

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function httpError_(httpStatus, message) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  return err;
}

function normalizeText_(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function toNumber_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asDate_(value) {
  if (value instanceof Date) return value;
  if (!value) return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateKey_(dateValue) {
  return Utilities.formatDate(asDate_(dateValue), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function stripTime_(dateValue) {
  const d = asDate_(dateValue);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function combineDateAndTime_(dateBase, timeValue) {
  const base = asDate_(dateBase);
  const t = asDate_(timeValue);
  if (!base || !t) return null;

  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    t.getHours(),
    t.getMinutes(),
    0,
    0
  );
}

function diffMinutesPositive_(fromDate, toDate) {
  const diffMs = asDate_(toDate).getTime() - asDate_(fromDate).getTime();
  return diffMs > 0 ? Math.floor(diffMs / 60000) : 0;
}

function round2_(value) {
  return Math.round((toNumber_(value) + Number.EPSILON) * 100) / 100;
}

function sumBy_(arr, key) {
  return arr.reduce((acc, item) => acc + toNumber_(item[key]), 0);
}

function countUniqueDatesByStatus_(attendanceRows, status) {
  const keys = new Set(
    attendanceRows
      .filter((x) => x.status === status && x.datetime)
      .map((x) => formatDateKey_(x.datetime))
  );
  return keys.size;
}
