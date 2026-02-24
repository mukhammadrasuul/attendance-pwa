const API = Object.freeze({
  bootstrap: '/api/bootstrap',
  attendance: '/api/attendance',
});

const BRANCH_KEY = 'attendance.branch.v1';
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

  const branch = resolveBranch_();
  if (!branch && isStandalonePwa_()) {
    showMessage_('Filial topilmadi. Ilovani ?branch=... bilan brauzerdan bir marta oching.', 'err');
    return;
  }
  el.branchText.textContent = `Filial: ${branch || 'Barchasi'}`;

  await loadBootstrap_(branch);
  await initCamera_({ fromUserGesture: false });
  updateActionState_();
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

    const width = 720;
    const height = Math.round((el.liveVideo.videoHeight / el.liveVideo.videoWidth) * width);

    el.captureCanvas.width = width;
    el.captureCanvas.height = height;

    const ctx = el.captureCanvas.getContext('2d', { alpha: false });
    ctx.drawImage(el.liveVideo, 0, 0, width, height);

    state.capturedImageData = el.captureCanvas.toDataURL('image/jpeg', 0.82);

    el.snapshot.src = state.capturedImageData;
    showSnapshot_();
    updateActionState_();
    showMessage_('Rasm olindi.', 'ok');
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

    const request = {
      requestId: randomId_(),
      employeeId: state.selectedEmployeeId,
      status: state.selectedStatus,
      imageData: state.capturedImageData,
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

  el.employeeSelect.value = '';
  [...el.statusGrid.querySelectorAll('.status-btn')].forEach((node) => node.classList.remove('active'));

  showLive_();
  updateActionState_();
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
  el.message.className = `message ${type} show`;
  el.message.textContent = text;

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
