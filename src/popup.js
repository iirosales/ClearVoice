const toggleEnabled = document.getElementById('toggle-enabled');
const voiceSelect = document.getElementById('voice-select');
const statusBadge = document.getElementById('status-badge');
const statusDetail = document.getElementById('status-detail');
const preloadBtn = document.getElementById('preload-btn');

function renderStatus(status) {
  const state = status?.modelState || 'idle';
  const device = status?.activeDevice;
  const progress = typeof status?.loadProgress === 'number' ? status.loadProgress : 0;

  statusBadge.className = 'badge';

  if (state === 'ready') {
    statusBadge.classList.add('badge-ready');
    statusBadge.textContent = `Ready (${(device || 'wasm').toUpperCase()})`;
    statusDetail.textContent = 'Kokoro-82M neural voice is cached locally and active.';
    preloadBtn.disabled = true;
    preloadBtn.textContent = 'Model Loaded Locally';
  } else if (state === 'loading') {
    statusBadge.classList.add('badge-loading');
    statusBadge.textContent = progress > 0 ? `Loading ${progress}%` : 'Loading...';
    statusDetail.textContent =
      'Downloading Kokoro-82M weights to browser cache. Web Speech fallback is ready.';
    preloadBtn.disabled = true;
    preloadBtn.textContent = 'Downloading Weights...';
  } else if (state === 'error') {
    statusBadge.classList.add('badge-error');
    statusBadge.textContent = 'Fallback Mode';
    statusDetail.textContent =
      status?.lastError || 'Using instant Web Speech fallback; click to retry Kokoro.';
    preloadBtn.disabled = false;
    preloadBtn.textContent = 'Retry Kokoro Model';
  } else {
    statusBadge.classList.add('badge-idle');
    statusBadge.textContent = 'Standby';
    statusDetail.textContent = '100% local in-browser synthesis. No external APIs or keys.';
    preloadBtn.disabled = false;
    preloadBtn.textContent = 'Preload Kokoro Model';
  }
}

async function initPopup() {
  const stored = await chrome.storage.local.get(['enabled', 'voice']);
  toggleEnabled.checked = Boolean(stored.enabled);
  voiceSelect.value = stored.voice || 'af_heart';

  try {
    const status = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'CV_GET_STATUS',
    });
    renderStatus(status);
  } catch {
    renderStatus({ modelState: 'idle' });
  }
}

toggleEnabled.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: toggleEnabled.checked });
});

voiceSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ voice: voiceSelect.value });
});

preloadBtn.addEventListener('click', async () => {
  renderStatus({ modelState: 'loading', loadProgress: 0 });
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'CV_INIT_MODEL',
    });
    renderStatus(res);
  } catch (err) {
    renderStatus({ modelState: 'error', lastError: err?.message });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'popup') return false;
  if (message.type === 'CV_STATUS_CHANGED') {
    renderStatus(message);
  }
  return false;
});

initPopup();
