const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke || (async () => {});
const event = tauri?.event;

const MAX_LOGS = 400;

const els = {
  statusDot: document.getElementById('statusDot'),
  statusTitle: document.getElementById('statusTitle'),
  statusDetail: document.getElementById('statusDetail'),
  nodeId: document.getElementById('nodeId'),
  hubUrl: document.getElementById('hubUrl'),
  atmRoot: document.getElementById('atmRoot'),
  browseBtn: document.getElementById('browseBtn'),
  configForm: document.getElementById('configForm'),
  saveBtn: document.getElementById('saveBtn'),
  hideBtn: document.getElementById('hideBtn'),
  deviceCount: document.getElementById('deviceCount'),
  terminalLogs: document.getElementById('terminalLogs'),
  clearLogsBtn: document.getElementById('clearLogsBtn'),
};

function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendLog(level, msg) {
  if (!els.terminalLogs) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${level || 'info'}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${formatTime()}]`;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = typeof msg === 'object' ? JSON.stringify(msg) : msg;

  entry.appendChild(timeSpan);
  entry.appendChild(msgSpan);
  els.terminalLogs.appendChild(entry);

  // Keep log size bounded
  while (els.terminalLogs.children.length > MAX_LOGS) {
    els.terminalLogs.removeChild(els.terminalLogs.firstChild);
  }

  // Auto scroll
  els.terminalLogs.scrollTop = els.terminalLogs.scrollHeight;
}

function updateStatus(status, detail) {
  els.statusDot.className = 'status-indicator';
  if (status === 'connected') {
    els.statusDot.classList.add('connected');
    els.statusTitle.textContent = 'Connected to Hub';
    els.statusDetail.textContent = detail || 'Listening for fleet commands';
  } else if (status === 'disconnected') {
    els.statusDot.classList.add('disconnected');
    els.statusTitle.textContent = 'Disconnected';
    els.statusDetail.textContent = detail || 'Attempting to reconnect...';
  } else {
    els.statusTitle.textContent = 'Connecting...';
    els.statusDetail.textContent = detail || 'Connecting to hub';
  }
}

async function init() {
  try {
    const config = await invoke('get_config');
    if (config) {
      els.nodeId.value = config.node_id || '';
      els.hubUrl.value = config.hub_url || 'wss://heist.endrisusanto.my.id/ws/bridge';
      els.atmRoot.value = config.atm_root || '';
      appendLog('sys', `Loaded configuration for node "${config.node_id || 'unknown'}"`);
    }
  } catch (err) {
    appendLog('error', `Failed to load bridge config: ${err}`);
  }

  els.browseBtn.addEventListener('click', async () => {
    try {
      const selected = await invoke('browse_atm_root');
      if (selected) {
        els.atmRoot.value = selected;
        appendLog('info', `ATM root set to: ${selected}`);
      }
    } catch (err) {
      appendLog('error', `Folder selection failed: ${err}`);
    }
  });

  els.configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Saving...';
    try {
      await invoke('save_config', {
        config: {
          node_id: els.nodeId.value.trim(),
          hub_url: els.hubUrl.value.trim(),
          bridge_token: '',
          atm_root: els.atmRoot.value.trim(),
        }
      });
      updateStatus('connecting', 'Reconnecting with new settings...');
      appendLog('info', `Settings saved. Reconnecting to ${els.hubUrl.value.trim()}`);
    } catch (err) {
      appendLog('error', `Error saving config: ${err}`);
      alert('Error saving config: ' + err);
    } finally {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = 'Save & Reconnect';
    }
  });

  els.hideBtn.addEventListener('click', async () => {
    try {
      await invoke('hide_window');
    } catch (err) {
      console.error('Failed to hide window:', err);
    }
  });

  els.clearLogsBtn.addEventListener('click', () => {
    if (els.terminalLogs) {
      els.terminalLogs.innerHTML = '';
      appendLog('sys', 'Terminal logs cleared.');
    }
  });

  if (event) {
    event.listen('bridge-status', (e) => {
      const payload = e.payload || {};
      updateStatus(payload.status, payload.detail);
      if (payload.detail) {
        appendLog(payload.status === 'connected' ? 'success' : (payload.status === 'disconnected' ? 'warn' : 'info'), payload.detail);
      }
    });

    event.listen('device-count-update', (e) => {
      const count = e.payload || 0;
      els.deviceCount.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
    });

    event.listen('bridge-log', (e) => {
      const payload = e.payload || {};
      appendLog(payload.level || 'info', payload.message || '');
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
