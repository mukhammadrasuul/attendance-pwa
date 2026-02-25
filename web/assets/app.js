const API = Object.freeze({
  bootstrap: '/api/bootstrap',
  attendance: '/api/attendance',
  attendanceImage: '/api/attendance-image',
});

const BRANCH_KEY = 'attendance.branch.v1';
const IMAGE_QUEUE_KEY = 'attendance.image_upload_queue.v1';
const IMAGE_QUEUE_POLICY = Object.freeze({
  BASE_RETRY_DELAY_MS: 1500,
  MAX_RETRY_DELAY_MS: 5 * 60 * 1000,
  ERROR_POPUP_COOLDOWN_MS: 5 * 60 * 1000,
  MAX_TRIES: 24,
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
});
const STATUS_META = Object.freeze({
  Keldim: { iconType: 'material', iconName: 'login' },
  Ketdim: { iconType: 'material', iconName: 'logout' },
  'Ishim bor': { icon: '🚶' },
  'Ishim bitdi': { icon: '↩' },
});

const state = {
  employees: [],
  selectedEmployeeId: '',
  selectedStatus: '',
  capturedImageData: '',
  stream: null,
  cameraReady: false,
  saveInFlight: false,
  imageUploadInFlight: false,
  imageUploadQueue: [],
  draftAttendanceId: '',
  draftImagePath: '',
  preUploadStatus: 'idle',
  preUploadedImagePath: '',
  toastTimer: null,
};

const el = {
  branchText: document.getElementById('branchText'),
  employeeSelect: document.getElementById('employeeSelect'),
  statusGrid: document.getElementById('statusGrid'),
  liveVideo: document.getElementById('liveVideo'),
  snapshot: document.getElementById('snapshot'),
  captureCanvas: document.getElementById('captureCanvas'),
  btnCapture: document.getElementById('btnCapture'),
  btnSave: document.getElementById('btnSave'),
  message: document.getElementById('message'),
  cameraHint: document.getElementById('cameraHint'),
};

window.addEventListener('DOMContentLoaded', async () => {
  registerServiceWorker_();
  bindEvents_();
  state.imageUploadQueue = readImageUploadQueue_();

  const branch = resolveBranch_();
  if (!branch && isStandalonePwa_()) {
    showMessage_('Filial topilmadi. Ilovani ?branch=... bilan brauzerdan bir marta oching.', 'err');
    return;
  }
  el.branchText.textContent = `Filial: ${branch || 'Barchasi'}`;

  await loadBootstrap_(branch);
  await initCamera_({ fromUserGesture: false });
  updateActionState_();
  void flushImageUploads_();

  // Keep retrying background image sync while app is open.
  setInterval(() => {
    void flushImageUploads_();
  }, 60000);
});

window.addEventListener('online', () => {
  // Best-effort retry for deferred image uploads.
  void flushImageUploads_();
});

function bindEvents_() {
  el.employeeSelect.addEventListener('change', (e) => {
    state.selectedEmployeeId = e.target.value;
    updateActionState_();
  });

  el.btnCapture.addEventListener('click', async () => {
    clearMessage_();

    // Retake mode: first click clears current shot and returns to live framing.
    if (state.capturedImageData) {
      state.capturedImageData = '';
      el.snapshot.src = '';
      state.draftAttendanceId = '';
      state.draftImagePath = '';
      state.preUploadStatus = 'idle';
      state.preUploadedImagePath = '';
      showLive_();
      updateActionState_();
      showMessage_('Yangi rasm olish uchun yana bosing.', 'ok');
      return;
    }

    if (!state.cameraReady) {
      const ok = await initCamera_({ fromUserGesture: true });
      if (!ok) return;
    }

    if (!el.liveVideo.videoWidth || !el.liveVideo.videoHeight) {
      showMessage_('Kamera hali tayyor emas.', 'err');
      return;
    }

    const width = 480;
    const height = Math.round((el.liveVideo.videoHeight / el.liveVideo.videoWidth) * width);

    el.captureCanvas.width = width;
    el.captureCanvas.height = height;

    const ctx = el.captureCanvas.getContext('2d', { alpha: false });
    ctx.drawImage(el.liveVideo, 0, 0, width, height);

    state.capturedImageData = el.captureCanvas.toDataURL('image/jpeg', 0.62);
    state.draftAttendanceId = randomId_();
    state.draftImagePath = makeImagePath_(state.draftAttendanceId);
    state.preUploadStatus = 'uploading';
    state.preUploadedImagePath = '';

    el.snapshot.src = state.capturedImageData;
    showSnapshot_();
    updateActionState_();
    showMessage_('Rasm olindi.', 'ok');
    void startPreUpload_();
  });

  el.btnSave.addEventListener('click', async () => {
    if (state.saveInFlight) return;

    if (!state.selectedEmployeeId) {
      showMessage_('Xodimni tanlang.', 'err');
      return;
    }
    if (!state.selectedStatus) {
      showMessage_('Holatni tanlang.', 'err');
      return;
    }
    if (!state.capturedImageData) {
      showMessage_('Avval rasmga oling.', 'err');
      return;
    }
    if (!navigator.onLine) {
      showMessage_('Internet aloqasi yo‘q. Tarmoqni tekshirib qayta urinib ko‘ring.', 'err');
      return;
    }

    const capturedImageData = state.capturedImageData;
    const attendanceId = state.draftAttendanceId || randomId_();
    const imagePath = state.preUploadedImagePath || state.draftImagePath || makeImagePath_(attendanceId);
    const useInlineImageOnSave = state.preUploadStatus === 'failed';
    const request = {
      requestId: attendanceId,
      employeeId: state.selectedEmployeeId,
      status: state.selectedStatus,
      deferImageUpload: !useInlineImageOnSave,
      imagePath,
      imageSyncStatus: useInlineImageOnSave ? '' : (state.preUploadStatus === 'uploaded' ? 'uploaded' : 'pending'),
      capturedAt: new Date().toISOString(),
    };
    if (useInlineImageOnSave) {
      request.imageData = capturedImageData;
    }

    setSaveLoading_(true);
    clearMessage_();

    try {
      const result = await submitAttendanceRequest_(request);
      if (!result.ok) {
        showMessage_(result.error || 'Saqlashda xatolik yuz berdi. Qayta urinib ko‘ring.', 'err');
        return;
      }

      if (result.deduped && !result.wroteNewRow) {
        showMessage_('Takror holat aniqlandi. Yangi qator qo‘shilmadi.', 'ok', { autoHideMs: 2000 });
      } else {
        showMessage_('Muvaffaqiyatli saqlandi.', 'ok', { autoHideMs: 2000 });
      }

      const shouldEnsureImageSync = result.wroteNewRow || result.idempotent === true;
      if (shouldEnsureImageSync) {
        const imageUploadedByServer = result.imageSyncStatus === 'uploaded';
        const needsRetryUpload = !imageUploadedByServer && state.preUploadStatus !== 'uploaded';
        const effectiveAttendanceId = result.attendanceId || attendanceId;
        enqueueImageUpload_({
          attendanceId: effectiveAttendanceId,
          imagePath: imagePath || result.imagePath || '',
          imageData: capturedImageData,
          tries: 0,
          expectRowUpdate: true,
        }, needsRetryUpload);
        if (needsRetryUpload) {
          void flushImageUploads_();
        }
      }

      resetForm_();
    } catch (err) {
      console.error(err);
      showMessage_('Serverga yuborilmadi. Tarmoqni tekshirib qayta urinib ko‘ring.', 'err');
    } finally {
      setSaveLoading_(false);
    }
  });
}

async function loadBootstrap_(branch) {
  try {
    const url = `${API.bootstrap}?branch=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();

    if (!data.ok) {
      showMessage_(data.error || 'Serverdan maʼlumot olishda xatolik.', 'err');
      return;
    }

    state.employees = Array.isArray(data.employees) ? data.employees : [];
    renderEmployees_(state.employees);
    renderStatuses_(data.statuses || []);

    if (state.employees.length === 0) {
      showMessage_('Bu filial bo‘yicha faol xodim topilmadi.', 'err');
    }
  } catch (err) {
    console.error(err);
    showMessage_('Tarmoq xatosi: xodimlar yuklanmadi.', 'err');
  }
}

async function initCamera_({ fromUserGesture }) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraHint_('Brauzer kamerani qo‘llab-quvvatlamaydi.');
    return false;
  }

  try {
    stopCamera_();

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    el.liveVideo.srcObject = state.stream;
    await el.liveVideo.play();

    state.cameraReady = true;
    showLive_();
    hideCameraHint_();
    return true;
  } catch (err) {
    console.error(err);
    state.cameraReady = false;

    if (!fromUserGesture) {
      showCameraHint_('Kamerani yoqish uchun "Rasmga Olish" tugmasini bosing.');
    } else {
      showMessage_('Kamera ruxsati berilmagan yoki mavjud emas.', 'err');
      showCameraHint_('Brauzer ruxsatlarini tekshiring va qayta urinib ko‘ring.');
    }
    return false;
  }
}

function stopCamera_() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.cameraReady = false;
}

function renderEmployees_(employees) {
  const options = ['<option value="">Tanlang...</option>'];
  employees.forEach((emp) => {
    options.push(`<option value="${escapeHtml_(emp.id)}">${escapeHtml_(emp.fullName)}</option>`);
  });
  el.employeeSelect.innerHTML = options.join('');
}

function renderStatuses_(statuses) {
  el.statusGrid.innerHTML = '';

  statuses.forEach((status) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-btn';
    const meta = STATUS_META[status] || {};
    const iconHtml = meta.iconType === 'material'
      ? `<span class="status-icon material-symbols-outlined status-material">${escapeHtml_(meta.iconName || 'check')}</span>`
      : `<span class="status-icon">${escapeHtml_(meta.icon || '•')}</span>`;
    btn.innerHTML = `${iconHtml}<span class="status-text">${escapeHtml_(status)}</span>`;
    btn.setAttribute('aria-label', status);

    btn.addEventListener('click', () => {
      state.selectedStatus = status;
      [...el.statusGrid.querySelectorAll('.status-btn')].forEach((node) => node.classList.remove('active'));
      btn.classList.add('active');
      updateActionState_();
    });

    el.statusGrid.appendChild(btn);
  });
}

function showSnapshot_() {
  el.liveVideo.style.display = 'none';
  el.snapshot.style.display = 'block';
}

function showLive_() {
  el.snapshot.style.display = 'none';
  el.liveVideo.style.display = 'block';
}

function resetForm_() {
  state.selectedEmployeeId = '';
  state.selectedStatus = '';
  state.capturedImageData = '';
  state.draftAttendanceId = '';
  state.draftImagePath = '';
  state.preUploadStatus = 'idle';
  state.preUploadedImagePath = '';

  el.employeeSelect.value = '';
  [...el.statusGrid.querySelectorAll('.status-btn')].forEach((node) => node.classList.remove('active'));

  showLive_();
  updateActionState_();
}

async function startPreUpload_() {
  if (!state.capturedImageData || !state.draftAttendanceId) return;
  const draftId = state.draftAttendanceId;
  const imageData = state.capturedImageData;

  if (!navigator.onLine) {
    if (state.draftAttendanceId === draftId) {
      state.preUploadStatus = 'failed';
    }
    return;
  }

  try {
    const result = await submitAttendanceImageRequest_({
      attendanceId: draftId,
      imagePath: state.draftImagePath || makeImagePath_(draftId),
      imageData,
      tries: 0,
    });

    if (state.draftAttendanceId !== draftId) return;

    if (result.ok) {
      state.preUploadStatus = 'uploaded';
      state.preUploadedImagePath = result.imagePath || '';
    } else {
      state.preUploadStatus = 'failed';
    }
  } catch (_err) {
    if (state.draftAttendanceId === draftId) {
      state.preUploadStatus = 'failed';
    }
  }
}

async function submitAttendanceRequest_(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(API.attendance, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  let data = {};
  try {
    data = await res.json();
  } catch (_parseErr) {
    data = { ok: false, error: 'Serverdan noto‘g‘ri javob qaytdi.' };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `HTTP ${res.status} xatolik`,
    };
  }

  return data;
}

function enqueueImageUpload_(entry, shouldQueue = true) {
  if (!shouldQueue) return;
  const key = String(entry && entry.attendanceId || '').trim();
  if (!key) return;

  const existingIndex = state.imageUploadQueue.findIndex((item) => String(item && item.attendanceId || '').trim() === key);
  if (existingIndex >= 0) {
    state.imageUploadQueue[existingIndex] = {
      ...state.imageUploadQueue[existingIndex],
      ...entry,
      tries: Number(state.imageUploadQueue[existingIndex].tries || 0),
      createdAt: Number(state.imageUploadQueue[existingIndex].createdAt || Date.now()),
      nextAttemptAt: 0,
    };
    writeImageUploadQueue_();
    return;
  }

  if (state.imageUploadQueue.length >= 20) {
    showMessage_('Rasm navbati to‘lib qoldi. Internetni tekshirib qayta urinib ko‘ring.', 'err');
    return;
  }
  state.imageUploadQueue.push({
    ...entry,
    tries: Number(entry.tries || 0),
    createdAt: Date.now(),
    nextAttemptAt: 0,
    lastErrorPopupAt: 0,
  });
  writeImageUploadQueue_();
}

async function flushImageUploads_() {
  if (state.imageUploadInFlight) return;
  if (state.imageUploadQueue.length === 0) return;
  if (!navigator.onLine) return;

  state.imageUploadInFlight = true;
  try {
    purgeStaleImageQueueItems_();

    while (state.imageUploadQueue.length > 0) {
      const now = Date.now();
      const dueIndex = state.imageUploadQueue.findIndex((item) => Number(item.nextAttemptAt || 0) <= now);
      if (dueIndex < 0) break;

      const [current] = state.imageUploadQueue.splice(dueIndex, 1);
      try {
        const result = await submitAttendanceImageRequest_(current);
        const expectsRowUpdate = current.expectRowUpdate !== false;
        const synced = result.ok && (!expectsRowUpdate || result.rowUpdated !== false);
        if (!synced) {
          throw new Error(result.error || 'Image upload failed');
        }
        writeImageUploadQueue_();
      } catch (err) {
        current.tries = Number(current.tries || 0) + 1;
        const delay = nextImageRetryDelayMs_(current.tries);
        current.nextAttemptAt = Date.now() + delay;

        const ageMs = Date.now() - Number(current.createdAt || Date.now());
        const expired = current.tries >= IMAGE_QUEUE_POLICY.MAX_TRIES || ageMs >= IMAGE_QUEUE_POLICY.MAX_AGE_MS;
        if (expired) {
          maybeShowImageQueueError_(current, true);
          writeImageUploadQueue_();
          continue;
        }

        maybeShowImageQueueError_(current, false);
        state.imageUploadQueue.push(current);
        writeImageUploadQueue_();
      }
    }
  } finally {
    state.imageUploadInFlight = false;
  }
}

function nextImageRetryDelayMs_(tries) {
  const t = Math.max(1, Number(tries || 1));
  const delay = IMAGE_QUEUE_POLICY.BASE_RETRY_DELAY_MS * (2 ** Math.min(t - 1, 8));
  return Math.min(delay, IMAGE_QUEUE_POLICY.MAX_RETRY_DELAY_MS);
}

function maybeShowImageQueueError_(entry, finalDrop) {
  const now = Date.now();
  const lastShown = Number(entry.lastErrorPopupAt || 0);
  if ((now - lastShown) < IMAGE_QUEUE_POLICY.ERROR_POPUP_COOLDOWN_MS) return;

  entry.lastErrorPopupAt = now;
  if (finalDrop) {
    showMessage_('Baʼzi rasmlar uzoq vaqt yuklanmadi va navbatdan chiqarildi. Internetni tekshirib qayta yozing.', 'err', { autoHideMs: 4500 });
    return;
  }
  showMessage_('Davomat saqlandi, lekin rasm hali yuklanmadi. Internetni tekshirib ilovani ochiq qoldiring.', 'err', { autoHideMs: 3500 });
}

function purgeStaleImageQueueItems_() {
  const now = Date.now();
  let changed = false;

  state.imageUploadQueue = state.imageUploadQueue.filter((item) => {
    const tries = Number(item && item.tries || 0);
    const createdAt = Number(item && item.createdAt || now);
    const tooOld = (now - createdAt) >= IMAGE_QUEUE_POLICY.MAX_AGE_MS;
    const tooMany = tries >= IMAGE_QUEUE_POLICY.MAX_TRIES;
    const keep = !tooOld && !tooMany;
    changed = changed || !keep;
    return keep;
  });

  if (changed) {
    writeImageUploadQueue_();
  }
}

function normalizeImageQueueEntry_(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const attendanceId = String(entry.attendanceId || '').trim();
  const imageData = String(entry.imageData || '').trim();
  if (!attendanceId || !imageData) return null;

  const now = Date.now();
  return {
    attendanceId,
    imagePath: String(entry.imagePath || '').trim(),
    imageData,
    expectRowUpdate: entry.expectRowUpdate !== false,
    tries: Math.max(0, Number(entry.tries || 0)),
    createdAt: Math.max(0, Number(entry.createdAt || now)),
    nextAttemptAt: Math.max(0, Number(entry.nextAttemptAt || 0)),
    lastErrorPopupAt: Math.max(0, Number(entry.lastErrorPopupAt || 0)),
  };
}

function dedupeImageQueue_(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = item.attendanceId;
    const current = map.get(key);
    if (!current) {
      map.set(key, item);
      return;
    }
    map.set(key, {
      ...current,
      ...item,
      tries: Math.min(current.tries, item.tries),
      createdAt: Math.min(current.createdAt, item.createdAt),
      nextAttemptAt: Math.min(current.nextAttemptAt, item.nextAttemptAt),
      lastErrorPopupAt: Math.max(current.lastErrorPopupAt, item.lastErrorPopupAt),
    });
  });
  return Array.from(map.values());
}

function readImageUploadQueue_() {
  try {
    const raw = localStorage.getItem(IMAGE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map((entry) => normalizeImageQueueEntry_(entry))
      .filter(Boolean);
    return dedupeImageQueue_(normalized);
  } catch (_err) {
    return [];
  }
}

function writeImageUploadQueue_() {
  try {
    state.imageUploadQueue = dedupeImageQueue_(state.imageUploadQueue
      .map((entry) => normalizeImageQueueEntry_(entry))
      .filter(Boolean));
    localStorage.setItem(IMAGE_QUEUE_KEY, JSON.stringify(state.imageUploadQueue));
  } catch (_err) {
    // If storage quota is exceeded, keep in-memory queue and alert user.
    showMessage_('Rasm navbatini saqlab bo‘lmadi. Internetni tekshirib yuborishni yakunlang.', 'err');
  }
}

function clearStuckImageQueue_() {
  state.imageUploadQueue = [];
  try {
    localStorage.removeItem(IMAGE_QUEUE_KEY);
  } catch (_err) {
    // no-op
  }
}

async function submitAttendanceImageRequest_(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(API.attendanceImage, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  let data = {};
  try {
    data = await res.json();
  } catch (_parseErr) {
    data = { ok: false, error: 'Serverdan noto‘g‘ri javob qaytdi.' };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `HTTP ${res.status} xatolik`,
    };
  }

  return data;
}

function setSaveLoading_(isLoading) {
  state.saveInFlight = isLoading;
  el.btnSave.textContent = isLoading ? 'Saqlanmoqda...' : 'Saqlash';
  updateActionState_();
}

function registerServiceWorker_() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js')
    .then((registration) => {
      // Pull latest worker on each page load so deploys appear quickly.
      registration.update();
    })
    .catch((err) => {
      console.error('SW registration failed', err);
    });
}

function resolveBranch_() {
  const fromUrl = (new URLSearchParams(window.location.search).get('branch') || '').trim();
  if (fromUrl) {
    localStorage.setItem(BRANCH_KEY, fromUrl);
    return fromUrl;
  }

  const saved = (localStorage.getItem(BRANCH_KEY) || '').trim();
  return saved;
}

function isStandalonePwa_() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function showCameraHint_(text) {
  el.cameraHint.textContent = text;
  el.cameraHint.style.display = 'block';
}

function hideCameraHint_() {
  el.cameraHint.textContent = '';
  el.cameraHint.style.display = 'none';
}

function showMessage_(text, type, options = {}) {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }

  const autoHideMs = Number(options.autoHideMs || 0);
  const decoratedText = type === 'ok' ? `✅ ${text}` : text;
  el.message.className = `message ${type} show`;
  el.message.textContent = decoratedText;

  if (autoHideMs > 0) {
    state.toastTimer = setTimeout(() => {
      clearMessage_();
    }, autoHideMs);
  }
}

function clearMessage_() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  el.message.className = 'message';
  el.message.textContent = '';
}

function escapeHtml_(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function randomId_() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeImagePath_(attendanceId) {
  const raw = String(attendanceId || randomId_()).toLowerCase().replace(/[^a-z0-9]/g, '');
  const shortId = (raw || randomId_().replace(/[^a-z0-9]/gi, '').toLowerCase()).slice(0, 8);
  return `attendance_Images/${shortId}.${Date.now()}.jpg`;
}

function updateActionState_() {
  const hasEmployee = Boolean(state.selectedEmployeeId);
  const hasStatus = Boolean(state.selectedStatus);
  const hasPhoto = Boolean(state.capturedImageData);

  // Save is enabled only when payload is complete.
  el.btnSave.disabled = !(hasEmployee && hasStatus && hasPhoto) || state.saveInFlight;
  el.btnCapture.disabled = state.saveInFlight;

  // Capture button doubles as retake action after first shot.
  if (hasPhoto) {
    el.btnCapture.textContent = 'Qaytadan rasmga olish';
    el.btnCapture.classList.add('retake');
  } else {
    el.btnCapture.textContent = 'Rasmga Olish';
    el.btnCapture.classList.remove('retake');
  }
}
