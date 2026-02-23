const API = Object.freeze({
  bootstrap: '/api/bootstrap',
  attendance: '/api/attendance',
});

const STATUS_META = Object.freeze({
  Keldim: { icon: '🟢' },
  Ketdim: { icon: '🔴' },
  'Ishim bor': { icon: '🚶' },
  'Ishim bitdi': { icon: '↩' },
});

const QUEUE_KEY = 'attendance.queue.v1';

const state = {
  employees: [],
  selectedEmployeeId: '',
  selectedStatus: '',
  capturedImageData: '',
  stream: null,
  cameraReady: false,
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

  const branch = new URLSearchParams(window.location.search).get('branch') || '';
  el.branchText.textContent = `Filial: ${branch || 'Barchasi'}`;

  await loadBootstrap_(branch);
  await initCamera_({ fromUserGesture: false });
  updateActionState_();

  void flushQueue_();
});

window.addEventListener('online', () => {
  void flushQueue_();
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

  el.btnSave.addEventListener('click', () => {
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

    enqueue_(request);

    // Optimistic UI.
    showMessage_('Muvaffaqiyatli saqlandi.', 'ok');
    resetForm_();

    void flushQueue_();
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
    const icon = STATUS_META[status]?.icon || '•';
    btn.innerHTML = `<span class="status-icon">${icon}</span><span class="status-text">${escapeHtml_(status)}</span>`;
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

function enqueue_(entry) {
  const queue = readQueue_();
  queue.push(entry);
  writeQueue_(queue);
}

async function flushQueue_() {
  if (!navigator.onLine) return;

  const queue = readQueue_();
  if (queue.length === 0) return;

  const failed = [];

  for (const item of queue) {
    try {
      const res = await fetch(API.attendance, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        failed.push(item);
      }
    } catch (_err) {
      failed.push(item);
    }
  }

  writeQueue_(failed);
}

function readQueue_() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

function writeQueue_(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function registerServiceWorker_() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.error('SW registration failed', err);
  });
}

function showCameraHint_(text) {
  el.cameraHint.textContent = text;
  el.cameraHint.style.display = 'block';
}

function hideCameraHint_() {
  el.cameraHint.textContent = '';
  el.cameraHint.style.display = 'none';
}

function showMessage_(text, type) {
  el.message.className = `message ${type}`;
  el.message.textContent = text;
}

function clearMessage_() {
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
  el.btnSave.disabled = !(hasEmployee && hasStatus && hasPhoto);

  // Capture button doubles as retake action after first shot.
  if (hasPhoto) {
    el.btnCapture.textContent = 'Qaytadan rasmga olish';
    el.btnCapture.classList.add('retake');
  } else {
    el.btnCapture.textContent = 'Rasmga Olish';
    el.btnCapture.classList.remove('retake');
  }
}
