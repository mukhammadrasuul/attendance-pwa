/**
 * Attendance API + Workers (Decoupled Architecture)
 *
 * API (user-facing):
 * - bootstrap: branch-filtered employee list
 * - submitAttendance: validates + dedupes + writes attendance only
 *
 * Workers (time-driven):
 * - processAttendanceToDailyStats: incremental daily statistics updater
 * - runNightlyMonthlyRollup: monthly aggregation updater (nightly)
 *
 * Required Script Properties:
 * - SPREADSHEET_ID
 * - API_SHARED_SECRET
 *
 * Optional Script Properties:
 * - ATT_LAST_PROCESSED_ROW (managed automatically)
 */

const CONFIG = Object.freeze({
  VERSION: '2.2.0',
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
  IMAGE_SYNC: Object.freeze({
    PENDING: 'pending',
    UPLOADED: 'uploaded',
    FAILED: 'failed',
  }),
  COLS: Object.freeze({
    ATTENDANCE: Object.freeze({
      ID: 1,
      EMPLOYEE_ID: 2,
      DATETIME: 3,
      STATUS: 4,
      IMAGE_PATH: 5,
      IMAGE_SYNC_STATUS: 6,
      IMAGE_SYNC_AT: 7,
    }),
  }),
  DRIVE: Object.freeze({
    ATTENDANCE_FOLDER_ID: '1kiqoaAJDx3967MzfcsgQVNCFggQ2aPSV',
    ATTENDANCE_FOLDER_NAME: 'attendance_Images',
  }),
  PERF: Object.freeze({
    ATTENDANCE_LOOKBACK_ROWS: 1500,
    DAILY_WORKER_BATCH_SIZE: 300,
  }),
  PROPS: Object.freeze({
    ATT_LAST_PROCESSED_ROW: 'ATT_LAST_PROCESSED_ROW',
  }),
  TIMEZONE: Session.getScriptTimeZone() || 'Asia/Tashkent',
});

/* ------------------------------ HTTP Entrypoints ------------------------------ */

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'attendance-api',
    version: CONFIG.VERSION,
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
      return jsonResponse_(buildBootstrap_(String(body.branch || '').trim()));
    }

    if (action === 'submitAttendance') {
      return jsonResponse_(submitAttendance_(body.payload || {}));
    }

    if (action === 'uploadAttendanceImage') {
      return jsonResponse_(uploadAttendanceImage_(body.payload || {}));
    }

    throw httpError_(400, `Unsupported action: ${action}`);
  } catch (err) {
    console.error(err);
    return jsonResponse_({
      ok: false,
      error: err.message || 'Server error',
      status: err.httpStatus || 500,
    });
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
    apiVersion: CONFIG.VERSION,
    employeeCount: employees.length,
    serverTime: new Date().toISOString(),
  };
}

/**
 * User-facing write path: keep this fast and reliable.
 * Writes attendance row only (plus image path), without heavy calculations.
 */
function submitAttendance_(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);

  try {
    const data = validateSubmission_(payload);

    if (data.requestId && attendanceIdExists_(data.requestId)) {
      return {
        ok: true,
        persisted: true,
        wroteNewRow: false,
        deduped: true,
        idempotent: true,
        apiVersion: CONFIG.VERSION,
      };
    }

    if (isConsecutiveDuplicate_(data.employeeId, data.status)) {
      return {
        ok: true,
        persisted: true,
        wroteNewRow: false,
        deduped: true,
        idempotent: false,
        apiVersion: CONFIG.VERSION,
      };
    }

    const now = new Date();
    const attendanceId = data.requestId || Utilities.getUuid();
    let imagePath = data.imagePath || `${CONFIG.DRIVE.ATTENDANCE_FOLDER_NAME}/${makeAttendanceImageFileName_(attendanceId, 'jpg')}`;
    let imageSyncStatus = normalizeImageSyncStatus_(data.imageSyncStatus) || (data.deferImageUpload ? CONFIG.IMAGE_SYNC.PENDING : CONFIG.IMAGE_SYNC.UPLOADED);
    let imageSyncAt = data.deferImageUpload ? '' : new Date();

    if (!data.deferImageUpload) {
      // Backward-compatible mode if client still sends image in write request.
      const stored = storeAttendanceImagePath_(data.imageData, attendanceId, imagePath);
      if (stored.path) imagePath = stored.path;
      if (stored.uploaded) {
        imageSyncStatus = CONFIG.IMAGE_SYNC.UPLOADED;
        imageSyncAt = new Date();
      } else {
        imageSyncStatus = CONFIG.IMAGE_SYNC.FAILED;
        imageSyncAt = '';
      }
    }

    appendAttendanceRow_({
      attendanceId,
      employeeId: data.employeeId,
      datetime: now,
      status: data.status,
      imagePath,
      imageSyncStatus,
      imageSyncAt,
    });

    return {
      ok: true,
      persisted: true,
      wroteNewRow: true,
      deduped: false,
      idempotent: false,
      attendanceId,
      imagePath,
      imageDeferred: data.deferImageUpload,
      imageSyncStatus,
      apiVersion: CONFIG.VERSION,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Background attachment upload endpoint.
 * Does not affect attendance write confirmation flow.
 */
function uploadAttendanceImage_(payload) {
  const data = validateImageUploadPayload_(payload);

  try {
    const imagePath = saveAttendanceImageToDrive_(data.imageData, data.attendanceId, data.imagePath);
    const pathUpdated = updateAttendanceImagePathById_(data.attendanceId, imagePath);
    const syncUpdated = updateAttendanceImageSyncById_(data.attendanceId, CONFIG.IMAGE_SYNC.UPLOADED, new Date());

    return {
      ok: true,
      persisted: true,
      attendanceId: data.attendanceId,
      imagePath,
      rowUpdated: Boolean(pathUpdated && syncUpdated),
      imageSyncStatus: CONFIG.IMAGE_SYNC.UPLOADED,
      apiVersion: CONFIG.VERSION,
    };
  } catch (err) {
    const syncUpdated = updateAttendanceImageSyncById_(data.attendanceId, CONFIG.IMAGE_SYNC.FAILED, '');
    return {
      ok: false,
      persisted: false,
      attendanceId: data.attendanceId,
      error: err.message || 'Image upload failed',
      rowUpdated: Boolean(syncUpdated),
      imageSyncStatus: CONFIG.IMAGE_SYNC.FAILED,
      apiVersion: CONFIG.VERSION,
    };
  }
}

/* ------------------------------ Workers ------------------------------ */

/**
 * Incremental worker: process new rows from attendance and upsert daily stats.
 * Recommended trigger: every 1-5 minutes.
 */
function processAttendanceToDailyStats(batchSize) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(1000);
  if (!locked) {
    return { ok: true, skipped: true, reason: 'worker_lock_busy' };
  }

  try {
    const attendanceSheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
    const lastRow = attendanceSheet.getLastRow();
    if (lastRow <= 1) {
      return { ok: true, processedRows: 0, impactedDays: 0, updatedDailyRows: 0, insertedDailyRows: 0 };
    }

    const safeBatchSize = Math.max(1, Number(batchSize) || CONFIG.PERF.DAILY_WORKER_BATCH_SIZE);
    const lastProcessed = getNumericProperty_(CONFIG.PROPS.ATT_LAST_PROCESSED_ROW, 1);

    if (lastProcessed >= lastRow) {
      return { ok: true, processedRows: 0, impactedDays: 0, updatedDailyRows: 0, insertedDailyRows: 0 };
    }

    const startRow = lastProcessed + 1;
    const endRow = Math.min(lastRow, startRow + safeBatchSize - 1);
    const numRows = endRow - startRow + 1;

    // attendance cols used here: employee id (2), datetime (3), status (4)
    const chunk = attendanceSheet.getRange(startRow, 2, numRows, 3).getValues();

    const impacted = new Map();
    const employeeIds = new Set();

    chunk.forEach((row) => {
      const employeeId = String(row[0] || '').trim();
      const datetime = asDate_(row[1]);
      if (!employeeId || !datetime) return;

      const day = stripTime_(datetime);
      const key = employeeDateKey_(employeeId, day);

      if (!impacted.has(key)) impacted.set(key, { employeeId, day });
      employeeIds.add(employeeId);
    });

    // Advance cursor even if rows were malformed, to avoid worker stall.
    if (impacted.size === 0) {
      setNumericProperty_(CONFIG.PROPS.ATT_LAST_PROCESSED_ROW, endRow);
      return { ok: true, processedRows: numRows, impactedDays: 0, updatedDailyRows: 0, insertedDailyRows: 0 };
    }

    const employeeMap = getEmployeeMapByIds_(employeeIds);
    const logsByKey = getAttendanceLogsByKeys_(new Set(impacted.keys()));

    const dailyEntries = [];
    let skippedNoEmployee = 0;

    impacted.forEach((entry, key) => {
      const employee = employeeMap.get(entry.employeeId);
      if (!employee) {
        skippedNoEmployee += 1;
        return;
      }

      const logs = (logsByKey.get(key) || []).sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const metrics = computeDailyMetrics_(employee, entry.day, logs);

      dailyEntries.push({
        employeeId: entry.employeeId,
        date: entry.day,
        lateMinutes: metrics.lateMinutes,
        earlyMinutes: metrics.earlyMinutes,
        outworkMinutes: metrics.outworkMinutes,
        penalty: metrics.penalty,
        todaySalary: metrics.todaySalary,
      });
    });

    const upsert = upsertDailyEntries_(dailyEntries);

    setNumericProperty_(CONFIG.PROPS.ATT_LAST_PROCESSED_ROW, endRow);

    return {
      ok: true,
      processedRows: numRows,
      impactedDays: impacted.size,
      skippedNoEmployee,
      updatedDailyRows: upsert.updated,
      insertedDailyRows: upsert.inserted,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Nightly worker: rebuilds monthly statistics for target month/year.
 * Recommended trigger: once daily at night.
 */
function runNightlyMonthlyRollup(targetMonth, targetYear) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(1000);
  if (!locked) {
    return { ok: true, skipped: true, reason: 'worker_lock_busy' };
  }

  try {
    const now = new Date();
    const month = Number(targetMonth) || (now.getMonth() + 1);
    const year = Number(targetYear) || now.getFullYear();

    const dailyRows = getDailyRowsForMonth_(month, year);
    const attendanceRows = getAttendanceRowsForMonth_(month, year);

    const dailyAgg = aggregateDailyByEmployee_(dailyRows);
    const attAgg = aggregateAttendanceByEmployee_(attendanceRows);

    const employeeIds = new Set([...dailyAgg.keys(), ...attAgg.keys()]);
    const monthlyEntries = [];

    employeeIds.forEach((employeeId) => {
      const d = dailyAgg.get(employeeId) || {
        lateCount: 0,
        overallLateHrs: 0,
        earlyCount: 0,
        overallEarlyHrs: 0,
        overallOutworkHrs: 0,
        totalPenalty: 0,
        salary: 0,
      };

      const a = attAgg.get(employeeId) || {
        workedDays: 0,
        outworkCount: 0,
      };

      monthlyEntries.push({
        employeeId,
        month,
        year,
        workedDays: a.workedDays,
        lateCount: d.lateCount,
        overallLateHrs: d.overallLateHrs,
        earlyCount: d.earlyCount,
        overallEarlyHrs: d.overallEarlyHrs,
        outworkCount: a.outworkCount,
        overallOutworkHrs: d.overallOutworkHrs,
        totalPenalty: round2_(d.totalPenalty),
        salary: round2_(d.salary),
      });
    });

    const upsert = upsertMonthlyEntries_(monthlyEntries, month, year);

    return {
      ok: true,
      month,
      year,
      employees: monthlyEntries.length,
      updatedMonthlyRows: upsert.updated,
      insertedMonthlyRows: upsert.inserted,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Helper for first deployment: initialize attendance cursor to current last row.
 * Use once if you want workers to start from "now" and skip historical rows.
 */
function initializeAttendanceCursorToCurrentLastRow() {
  const attendanceSheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const lastRow = attendanceSheet.getLastRow();
  setNumericProperty_(CONFIG.PROPS.ATT_LAST_PROCESSED_ROW, Math.max(1, lastRow));
  return { ok: true, cursor: Math.max(1, lastRow) };
}

/**
 * Reconciler for image sync status.
 * Marks pending/failed rows as uploaded if file exists in Drive folder.
 * Recommended trigger: every 5-15 minutes.
 */
function reconcileAttendanceImageStatuses(maxRows) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(1000);
  if (!locked) {
    return { ok: true, skipped: true, reason: 'worker_lock_busy' };
  }

  try {
    const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { ok: true, scanned: 0, updated: 0 };

    const cols = CONFIG.COLS.ATTENDANCE;
    const rowsToScan = Math.min(lastRow - 1, Math.max(1, Number(maxRows) || CONFIG.PERF.ATTENDANCE_LOOKBACK_ROWS));
    const startRow = lastRow - rowsToScan + 1;
    const values = sheet.getRange(startRow, 1, rowsToScan, cols.IMAGE_SYNC_AT).getValues();
    const folder = getAttendanceImageFolder_();

    let updated = 0;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const rowNumber = startRow + i;
      const imagePath = String(values[i][cols.IMAGE_PATH - 1] || '').trim();
      const syncStatus = String(values[i][cols.IMAGE_SYNC_STATUS - 1] || '').trim().toLowerCase();
      if (!imagePath) continue;
      if (syncStatus !== CONFIG.IMAGE_SYNC.PENDING && syncStatus !== CONFIG.IMAGE_SYNC.FAILED) continue;

      const fileName = fileNameFromPath_(imagePath);
      if (!fileName) continue;

      const found = folder.getFilesByName(fileName);
      if (found.hasNext()) {
        sheet.getRange(rowNumber, cols.IMAGE_SYNC_STATUS).setValue(CONFIG.IMAGE_SYNC.UPLOADED);
        sheet.getRange(rowNumber, cols.IMAGE_SYNC_AT).setValue(new Date());
        updated += 1;
      }
    }

    return { ok: true, scanned: rowsToScan, updated };
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
  const deferImageUpload = Boolean(payload.deferImageUpload);
  const imagePath = String(payload.imagePath || '').trim();
  const imageSyncStatus = String(payload.imageSyncStatus || '').trim();

  if (!employeeId) throw httpError_(400, 'employeeId is required');
  if (!Object.values(CONFIG.STATUS).includes(status)) throw httpError_(400, 'Invalid status');
  if (!deferImageUpload && !imageData.startsWith('data:image/')) {
    throw httpError_(400, 'imageData must be data URL');
  }

  return { employeeId, status, imageData, requestId, deferImageUpload, imagePath, imageSyncStatus };
}

function validateImageUploadPayload_(payload) {
  if (!payload || typeof payload !== 'object') throw httpError_(400, 'payload must be an object');

  const attendanceId = String(payload.attendanceId || '').trim();
  const imageData = String(payload.imageData || '').trim();
  const imagePath = String(payload.imagePath || '').trim();

  if (!attendanceId) throw httpError_(400, 'attendanceId is required');
  if (!imageData.startsWith('data:image/')) throw httpError_(400, 'imageData must be data URL');

  return { attendanceId, imageData, imagePath };
}

function normalizeImageSyncStatus_(statusRaw) {
  const s = String(statusRaw || '').trim().toLowerCase();
  if (s === CONFIG.IMAGE_SYNC.PENDING) return CONFIG.IMAGE_SYNC.PENDING;
  if (s === CONFIG.IMAGE_SYNC.UPLOADED) return CONFIG.IMAGE_SYNC.UPLOADED;
  if (s === CONFIG.IMAGE_SYNC.FAILED) return CONFIG.IMAGE_SYNC.FAILED;
  return '';
}

/* ------------------------------ Spreadsheet Access ------------------------------ */

function getSpreadsheet_() {
  const rawRef = getRequiredProperty_('SPREADSHEET_ID').trim();
  const spreadsheetId = extractSpreadsheetId_(rawRef);

  if (/^https?:\/\//i.test(rawRef)) {
    try {
      return SpreadsheetApp.openByUrl(rawRef);
    } catch (_errByUrl) {
      // fallback below
    }
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (_errById) {
    try {
      const file = DriveApp.getFileById(spreadsheetId);
      return SpreadsheetApp.open(file);
    } catch (errByDrive) {
      throw httpError_(500, `Unable to open spreadsheet. Detail: ${errByDrive.message}`);
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

function getNumericProperty_(name, defaultValue) {
  const raw = PropertiesService.getScriptProperties().getProperty(name);
  if (raw === null || raw === undefined || raw === '') return Number(defaultValue);
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number(defaultValue);
}

function setNumericProperty_(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, String(Number(value) || 0));
}

function extractSpreadsheetId_(rawRef) {
  const ref = String(rawRef || '').trim();
  if (!ref) throw httpError_(500, 'SPREADSHEET_ID is empty');

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

function getEmployeeMapByIds_(employeeIds) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.EMPLOYEES);
  const values = sheet.getDataRange().getValues();

  const map = new Map();
  const idSet = new Set(Array.from(employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean));

  values.slice(1).forEach((row) => {
    const id = String(row[0] || '').trim();
    if (!id || !idSet.has(id)) return;

    map.set(id, {
      id,
      dailySalary: toNumber_(row[4]),
      hourlySalary: toNumber_(row[5]),
      expectedStartRaw: row[6],
      expectedEndRaw: row[7],
    });
  });

  return map;
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
  const cols = CONFIG.COLS.ATTENDANCE;
  sheet.appendRow([
    row.attendanceId,
    row.employeeId,
    row.datetime,
    row.status,
    row.imagePath,
    row.imageSyncStatus || CONFIG.IMAGE_SYNC.PENDING,
    row.imageSyncAt || '',
  ]);
}

function attendanceIdExists_(attendanceId) {
  if (!attendanceId) return false;

  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = getAttendanceTailValues_(sheet, 1, 1, CONFIG.PERF.ATTENDANCE_LOOKBACK_ROWS);

  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (String(values[i][0] || '').trim() === attendanceId) return true;
  }

  return false;
}

function isConsecutiveDuplicate_(employeeId, status) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  // cols: employee id (2), datetime (3), status (4)
  const values = getAttendanceTailValues_(sheet, 2, 3, CONFIG.PERF.ATTENDANCE_LOOKBACK_ROWS);

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const rowEmployeeId = String(values[i][0] || '').trim();
    if (rowEmployeeId !== employeeId) continue;

    const lastStatus = String(values[i][2] || '').trim();
    return lastStatus === status;
  }

  return false;
}

function getAttendanceTailValues_(sheet, startCol, numCols, lookbackRows) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const dataRows = lastRow - 1;
  const rowsToRead = Math.min(dataRows, Math.max(1, Number(lookbackRows) || 1000));
  const startRow = lastRow - rowsToRead + 1;
  return sheet.getRange(startRow, startCol, rowsToRead, numCols).getValues();
}

/* ------------------------------ Image Storage ------------------------------ */

function storeAttendanceImagePath_(imageDataUrl, requestId, preferredPath) {
  try {
    return {
      path: saveAttendanceImageToDrive_(imageDataUrl, requestId, preferredPath),
      uploaded: true,
    };
  } catch (err) {
    // Keep attendance write reliable even when Drive upload fails.
    console.error(`Image upload failed, fallback path used: ${err.message}`);
    const fallbackPath = preferredPath || `${CONFIG.DRIVE.ATTENDANCE_FOLDER_NAME}/${makeAttendanceImageFileName_(requestId, 'jpg')}`;
    return {
      path: fallbackPath,
      uploaded: false,
    };
  }
}

function saveAttendanceImageToDrive_(imageDataUrl, requestId, preferredPath) {
  const parsed = parseDataUrlImage_(imageDataUrl);
  const folder = getAttendanceImageFolder_();
  const ext = extensionFromMimeType_(parsed.mimeType);
  const preferredFileName = fileNameFromPath_(preferredPath);
  const fileName = preferredFileName || makeAttendanceImageFileName_(requestId, ext);

  // Retry-safe idempotency: if same filename already uploaded, reuse it.
  const existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    return `${CONFIG.DRIVE.ATTENDANCE_FOLDER_NAME}/${fileName}`;
  }

  const bytes = Utilities.base64Decode(parsed.base64Data);
  const blob = Utilities.newBlob(bytes, parsed.mimeType, fileName);
  const file = folder.createFile(blob);

  return `${CONFIG.DRIVE.ATTENDANCE_FOLDER_NAME}/${file.getName()}`;
}

function fileNameFromPath_(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) return '';
  const parts = raw.split('/');
  return String(parts[parts.length - 1] || '').trim();
}

function parseDataUrlImage_(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw httpError_(400, 'Invalid image data URL format');

  return { mimeType: match[1], base64Data: match[2] };
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
  try {
    return DriveApp.getFolderById(CONFIG.DRIVE.ATTENDANCE_FOLDER_ID);
  } catch (err) {
    throw httpError_(500, `Attendance image folder is not accessible. Detail: ${err.message}`);
  }
}

function updateAttendanceImagePathById_(attendanceId, imagePath) {
  const rowNumber = findAttendanceRowById_(attendanceId);
  if (!rowNumber) return false;

  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  sheet.getRange(rowNumber, CONFIG.COLS.ATTENDANCE.IMAGE_PATH).setValue(imagePath);
  return true;
}

function updateAttendanceImageSyncById_(attendanceId, syncStatus, syncAt) {
  const rowNumber = findAttendanceRowById_(attendanceId);
  if (!rowNumber) return false;

  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  sheet.getRange(rowNumber, CONFIG.COLS.ATTENDANCE.IMAGE_SYNC_STATUS).setValue(syncStatus);
  sheet.getRange(rowNumber, CONFIG.COLS.ATTENDANCE.IMAGE_SYNC_AT).setValue(syncAt || '');
  return true;
}

function findAttendanceRowById_(attendanceId) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const id = String(attendanceId || '').trim();
  if (!id) return 0;

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  // Fast pass over recent rows.
  const rowsToRead = Math.min(lastRow - 1, CONFIG.PERF.ATTENDANCE_LOOKBACK_ROWS);
  const startRow = lastRow - rowsToRead + 1;
  const recentIds = sheet.getRange(startRow, 1, rowsToRead, 1).getValues();
  for (let i = recentIds.length - 1; i >= 0; i -= 1) {
    if (String(recentIds[i][0] || '').trim() === id) {
      return startRow + i;
    }
  }

  // Full fallback for older rows.
  const allIds = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = allIds.length - 1; i >= 0; i -= 1) {
    if (String(allIds[i][0] || '').trim() === id) {
      return i + 2;
    }
  }

  return 0;
}

/* ------------------------------ Daily Stats Worker ------------------------------ */

function getAttendanceLogsByKeys_(keySet) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1 || keySet.size === 0) return new Map();

  // cols: employee id (2), datetime (3), status (4)
  const values = sheet.getRange(2, 2, lastRow - 1, 3).getValues();
  const map = new Map();

  values.forEach((row) => {
    const employeeId = String(row[0] || '').trim();
    const datetime = asDate_(row[1]);
    const status = String(row[2] || '').trim();
    if (!employeeId || !datetime || !status) return;

    const day = stripTime_(datetime);
    const key = employeeDateKey_(employeeId, day);
    if (!keySet.has(key)) return;

    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ employeeId, datetime, status });
  });

  return map;
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

function upsertDailyEntries_(entries) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.DAILY);
  const values = sheet.getDataRange().getValues();

  const existing = new Map();
  for (let i = 1; i < values.length; i += 1) {
    const rowId = String(values[i][0] || '').trim();
    const employeeId = String(values[i][1] || '').trim();
    const date = asDate_(values[i][2]);
    if (!employeeId || !date) continue;

    const key = employeeDateKey_(employeeId, date);
    existing.set(key, { rowNumber: i + 1, rowId });
  }

  const toAppend = [];
  let updated = 0;

  entries.forEach((entry) => {
    const key = employeeDateKey_(entry.employeeId, entry.date);
    const found = existing.get(key);
    const rowValues = [
      found && found.rowId ? found.rowId : Utilities.getUuid(),
      entry.employeeId,
      stripTime_(entry.date),
      entry.lateMinutes,
      entry.earlyMinutes,
      entry.outworkMinutes,
      entry.penalty,
      entry.todaySalary,
    ];

    if (found) {
      sheet.getRange(found.rowNumber, 1, 1, rowValues.length).setValues([rowValues]);
      updated += 1;
    } else {
      toAppend.push(rowValues);
    }
  });

  if (toAppend.length > 0) {
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }

  return { updated, inserted: toAppend.length };
}

/* ------------------------------ Monthly Worker ------------------------------ */

function getDailyRowsForMonth_(month, year) {
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
    .filter((r) => r.employeeId && r.date)
    .filter((r) => (r.date.getMonth() + 1) === month && r.date.getFullYear() === year);
}

function getAttendanceRowsForMonth_(month, year) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.ATTENDANCE);
  const values = sheet.getDataRange().getValues();

  return values
    .slice(1)
    .map((row) => ({
      employeeId: String(row[1] || '').trim(),
      datetime: asDate_(row[2]),
      status: String(row[3] || '').trim(),
    }))
    .filter((r) => r.employeeId && r.datetime)
    .filter((r) => (r.datetime.getMonth() + 1) === month && r.datetime.getFullYear() === year);
}

function aggregateDailyByEmployee_(dailyRows) {
  const map = new Map();

  dailyRows.forEach((r) => {
    if (!map.has(r.employeeId)) {
      map.set(r.employeeId, {
        lateCount: 0,
        overallLateHrs: 0,
        earlyCount: 0,
        overallEarlyHrs: 0,
        overallOutworkHrs: 0,
        totalPenalty: 0,
        salary: 0,
      });
    }

    const agg = map.get(r.employeeId);
    if (r.lateMinutes > 0) agg.lateCount += 1;
    if (r.earlyMinutes > 0) agg.earlyCount += 1;

    agg.overallLateHrs += r.lateMinutes;
    agg.overallEarlyHrs += r.earlyMinutes;
    agg.overallOutworkHrs += r.outworkMinutes;
    agg.totalPenalty += r.penalty;
    agg.salary += r.todaySalary;
  });

  return map;
}

function aggregateAttendanceByEmployee_(attendanceRows) {
  const map = new Map();

  attendanceRows.forEach((r) => {
    if (!map.has(r.employeeId)) {
      map.set(r.employeeId, {
        workedDayKeys: new Set(),
        outworkCount: 0,
      });
    }

    const agg = map.get(r.employeeId);

    if (r.status === CONFIG.STATUS.ARRIVED) {
      agg.workedDayKeys.add(formatDateKey_(r.datetime));
    }

    if (r.status === CONFIG.STATUS.OUT_START) {
      agg.outworkCount += 1;
    }
  });

  const compact = new Map();
  map.forEach((v, k) => {
    compact.set(k, {
      workedDays: v.workedDayKeys.size,
      outworkCount: v.outworkCount,
    });
  });

  return compact;
}

function upsertMonthlyEntries_(entries, month, year) {
  const sheet = getSheetOrThrow_(CONFIG.SHEETS.MONTHLY);
  const values = sheet.getDataRange().getValues();

  const existing = new Map();
  for (let i = 1; i < values.length; i += 1) {
    const employeeId = String(values[i][1] || '').trim();
    const rowMonth = toNumber_(values[i][2]);
    const rowYear = toNumber_(values[i][3]);
    const rowId = String(values[i][0] || '').trim();

    if (!employeeId) continue;
    if (rowMonth === month && rowYear === year) {
      existing.set(employeeId, { rowNumber: i + 1, rowId });
    }
  }

  const toAppend = [];
  let updated = 0;

  entries.forEach((m) => {
    const found = existing.get(m.employeeId);
    const rowValues = [
      found && found.rowId ? found.rowId : Utilities.getUuid(),
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
    ];

    if (found) {
      sheet.getRange(found.rowNumber, 1, 1, rowValues.length).setValues([rowValues]);
      updated += 1;
    } else {
      toAppend.push(rowValues);
    }
  });

  if (toAppend.length > 0) {
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }

  return { updated, inserted: toAppend.length };
}

/* ------------------------------ Helpers ------------------------------ */

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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

function employeeDateKey_(employeeId, dateValue) {
  return `${employeeId}|${formatDateKey_(dateValue)}`;
}
