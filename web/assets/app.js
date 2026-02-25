const API = Object.freeze({
  bootstrap: '/api/bootstrap',
  attendance: '/api/attendance',
  attendanceImage: '/api/attendance-image',
});

const BRANCH_KEY = 'attendance.branch.v1';
const IMAGE_QUEUE_KEY = 'attendance.image_upload_queue.v1';
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

    const capturedImageData = state.capturedImageData;
    const attendanceId = state.draftAttendanceId || randomId_();
    const imagePath = state.preUploadedImagePath || state.draftImagePath || makeImagePath_(attendanceId);
    const request = {
      requestId: attendanceId,
      employeeId: state.selectedEmployeeId,
      status: state.selectedStatus,
      deferImageUpload: true,
      imagePath,
      imageSyncStatus: state.preUploadStatus === 'uploaded' ? 'uploaded' : 'pending',
      capturedAt: new Date().toISOString(),
    };

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

      if (result.wroteNewRow && result.attendanceId) {
        const needsRetryUpload = state.preUploadStatus !== 'uploaded';
        enqueueImageUpload_({
          attendanceId: result.attendanceId,
          imagePath: imagePath || result.imagePath || '',
          imageData: capturedImageData,
          tries: 0,
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
  if (state.imageUploadQueue.length >= 20) {
    showMessage_('Rasm navbati to‘lib qoldi. Internetni tekshirib qayta urinib ko‘ring.', 'err');
    return;
  }
  state.imageUploadQueue.push(entry);
  writeImageUploadQueue_();
}

async function flushImageUploads_() {
  if (state.imageUploadInFlight) return;
  if (state.imageUploadQueue.length === 0) return;
  if (!navigator.onLine) return;

  state.imageUploadInFlight = true;
  try {
    while (state.imageUploadQueue.length > 0) {
      const current = state.imageUploadQueue[0];
      try {
        const result = await submitAttendanceImageRequest_(current);
        if (!result.ok) {
          throw new Error(result.error || 'Image upload failed');
        }
        state.imageUploadQueue.shift();
        writeImageUploadQueue_();
      } catch (err) {
        current.tries = Number(current.tries || 0) + 1;
        writeImageUploadQueue_();
        if (current.tries >= 3) {
          showMessage_('Davomat saqlandi, lekin rasm hali yuklanmadi. Internetni tekshirib ilovani ochiq qoldiring.', 'err');
          break;
        } else {
          // Retry later without blocking user workflow.
          await waitMs_(1200 * current.tries);
        }
      }
    }
  } finally {
    state.imageUploadInFlight = false;
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

function waitMs_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readImageUploadQueue_() {
  try {
    const raw = localStorage.getItem(IMAGE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

function writeImageUploadQueue_() {
  try {
    localStorage.setItem(IMAGE_QUEUE_KEY, JSON.stringify(state.imageUploadQueue));
  } catch (_err) {
    // If storage quota is exceeded, keep in-memory queue and alert user.
    showMessage_('Rasm navbatini saqlab bo‘lmadi. Internetni tekshirib yuborishni yakunlang.', 'err');
  }
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
