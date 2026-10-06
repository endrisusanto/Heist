const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke || (async () => {});
const event = tauri?.event;

const els = {
  statusDot: document.getElementById('statusDot'),
  statusTitle: document.getElementById('statusTitle'),
  statusDetail: document.getElementById('statusDetail'),
  nodeId: document.getElementById('nodeId'),
  hubUrl: document.getElementById('hubUrl'),
  bridgeToken: document.getElementById('bridgeToken'),
  atmRoot: document.getElementById('atmRoot'),
  browseBtn: document.getElementById('browseBtn'),
  configForm: document.getElementById('configForm'),
  saveBtn: document.getElementById('saveBtn'),
  hideBtn: document.getElementById('hideBtn'),
  deviceCount: document.getElementById('deviceCount'),
};

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
      els.bridgeToken.value = config.bridge_token || '';
      els.atmRoot.value = config.atm_root || '';
    }
  } catch (err) {
    console.error('Failed to load bridge config:', err);
  }

  els.browseBtn.addEventListener('click', async () => {
    try {
      const selected = await invoke('browse_atm_root');
      if (selected) {
        els.atmRoot.value = selected;
      }
    } catch (err) {
      console.error('Folder selection failed:', err);
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
          bridge_token: els.bridgeToken.value.trim(),
          atm_root: els.atmRoot.value.trim(),
        }
      });
      updateStatus('connecting', 'Reconnecting with new settings...');
    } catch (err) {
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

  if (event) {
    event.listen('bridge-status', (e) => {
      const payload = e.payload || {};
      updateStatus(payload.status, payload.detail);
    });

    event.listen('device-count-update', (e) => {
      const count = e.payload || 0;
      els.deviceCount.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
