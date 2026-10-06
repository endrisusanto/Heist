interface DeviceInfo {
  serial: string;
  state: string;
  model: string;
  build_type: string;
  android: string;
  build: string;
  csc: string;
  security_patch: string;
  carrier: string;
  region: string;
  modem: string;
}

interface NodeState {
  nodeId: string;
  os: string;
  version: string;
  atmRoot: string;
  lastSeen: number;
  devices: DeviceInfo[];
  activeRuns: string[];
}

interface FleetState {
  nodes: Record<string, NodeState>;
}

// Global State
let fleet: FleetState = { nodes: {} };
const selectedDevices = new Map<string, string>(); // serial -> nodeId
let activeRunId: string | null = null;
let ws: WebSocket | null = null;
let logLinesCount = 0;

// DOM Elements
const els = {
  hubStatusDot: document.getElementById('hubStatusDot') as HTMLElement,
  hubStatusText: document.getElementById('hubStatusText') as HTMLElement,
  metricNodes: document.getElementById('metricNodes') as HTMLElement,
  metricDevices: document.getElementById('metricDevices') as HTMLElement,
  metricRuns: document.getElementById('metricRuns') as HTMLElement,
  deviceFleetContainer: document.getElementById('deviceFleetContainer') as HTMLElement,
  emptyFleetState: document.getElementById('emptyFleetState') as HTMLElement,
  selectedCountBadge: document.getElementById('selectedCountBadge') as HTMLElement,
  selectAllBtn: document.getElementById('selectAllBtn') as HTMLButtonElement,
  deselectAllBtn: document.getElementById('deselectAllBtn') as HTMLButtonElement,
  runBatchBtn: document.getElementById('runBatchBtn') as HTMLButtonElement,
  cancelBatchBtn: document.getElementById('cancelBatchBtn') as HTMLButtonElement,
  batchStatusTag: document.getElementById('batchStatusTag') as HTMLElement,
  toolChips: document.getElementById('toolChips') as HTMLElement,
  concurrencyInput: document.getElementById('concurrencyInput') as HTMLInputElement,
  updateToolsCheck: document.getElementById('updateToolsCheck') as HTMLInputElement,
  consoleTerminal: document.getElementById('consoleTerminal') as HTMLElement,
  logCount: document.getElementById('logCount') as HTMLElement,
  logFilter: document.getElementById('logFilter') as HTMLInputElement,
  autoScrollCheck: document.getElementById('autoScrollCheck') as HTMLInputElement,
  clearLogsBtn: document.getElementById('clearLogsBtn') as HTMLButtonElement,
  copyLogsBtn: document.getElementById('copyLogsBtn') as HTMLButtonElement,
  preflightBtn: document.getElementById('preflightBtn') as HTMLButtonElement,
  refreshBtn: document.getElementById('refreshBtn') as HTMLButtonElement,
  preflightModal: document.getElementById('preflightModal') as HTMLElement,
  closePreflightModal: document.getElementById('closePreflightModal') as HTMLButtonElement,
  preflightReportsContainer: document.getElementById('preflightReportsContainer') as HTMLElement,
};

function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/ui`;

  els.hubStatusDot.className = 'status-dot';
  els.hubStatusText.textContent = 'Connecting...';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    els.hubStatusDot.className = 'status-dot live';
    els.hubStatusText.textContent = 'Hub Connected';
    appendConsole('[System] Connected to Heist Hub', 'success');
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleHubMessage(msg);
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  };

  ws.onclose = () => {
    els.hubStatusDot.className = 'status-dot dead';
    els.hubStatusText.textContent = 'Disconnected';
    appendConsole('[System] Connection lost. Reconnecting in 3s...', 'warn');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function handleHubMessage(msg: { type: string; payload: any }) {
  const { type, payload } = msg;

  switch (type) {
    case 'FLEET_STATE': {
      fleet = payload;
      renderFleet();
      updateMetrics();
      break;
    }

    case 'LOG_STREAM': {
      appendConsole(`[${payload.nodeId}][${payload.runId}] ${payload.line}`);
      break;
    }

    case 'RUN_FINISHED': {
      const statusText = payload.exit_code === 0 ? 'SUCCESS' : `FAILED (${payload.exit_code})`;
      appendConsole(`[${payload.nodeId}] Run ${payload.runId} finished: ${statusText}`, payload.exit_code === 0 ? 'success' : 'err');
      if (activeRunId === payload.run_id) {
        setRunState(false);
      }
      break;
    }

    case 'PREFLIGHT_REPORT': {
      renderPreflightReport(payload.nodeId, payload.report);
      break;
    }

    case 'ACTION_RESPONSE': {
      const level = payload.success ? 'info' : 'err';
      appendConsole(`[${payload.nodeId}] Action ${payload.action}: ${payload.message}`, level);
      break;
    }
  }
}

function updateMetrics() {
  const nodes = Object.values(fleet.nodes);
  const nodeCount = nodes.length;
  let deviceCount = 0;
  let activeRunsCount = 0;

  for (const n of nodes) {
    deviceCount += n.devices?.length || 0;
    activeRunsCount += n.activeRuns?.length || 0;
  }

  els.metricNodes.textContent = nodeCount.toString();
  els.metricDevices.textContent = deviceCount.toString();
  els.metricRuns.textContent = activeRunsCount.toString();

  if (activeRunsCount > 0) {
    setRunState(true);
  } else if (activeRunId === null) {
    setRunState(false);
  }
}

function renderFleet() {
  const nodes = Object.values(fleet.nodes);
  if (nodes.length === 0) {
    els.deviceFleetContainer.innerHTML = '';
    els.deviceFleetContainer.appendChild(els.emptyFleetState);
    updateSelectionUI();
    return;
  }

  els.deviceFleetContainer.innerHTML = '';

  for (const node of nodes) {
    const group = document.createElement('div');
    group.className = 'node-group';

    const header = document.createElement('div');
    header.className = 'node-header';
    header.innerHTML = `
      <div class="node-title">
        <span>🖥️ ${node.nodeId}</span>
        <span class="node-tag">${node.os}</span>
        <span class="node-tag">v${node.version}</span>
      </div>
      <div class="node-actions">
        <button class="btn btn-outline btn-xs" data-update-node="${node.nodeId}">Update</button>
        <button class="btn btn-outline btn-xs" data-preflight-node="${node.nodeId}">Preflight</button>
      </div>
    `;
    group.appendChild(header);

    const devList = document.createElement('div');
    devList.className = 'node-devices-list';

    if (!node.devices || node.devices.length === 0) {
      devList.innerHTML = `<div style="padding: 10px; color: var(--text-muted); font-size: 11px;">No ADB devices on this node</div>`;
    } else {
      for (const dev of node.devices) {
        const isSelected = selectedDevices.has(dev.serial);
        const card = document.createElement('div');
        card.className = `device-card ${isSelected ? 'selected' : ''}`;
        card.dataset.serial = dev.serial;
        card.dataset.nodeId = node.nodeId;

        card.innerHTML = `
          <div class="device-select-box">
            <input type="checkbox" class="device-checkbox" data-serial="${dev.serial}" data-node-id="${node.nodeId}" ${isSelected ? 'checked' : ''} />
          </div>
          <div class="device-info-main">
            <div class="device-row-top">
              <span class="device-model-name">${dev.model || 'Unknown Model'}</span>
              <span class="device-state-badge ${dev.state}">${dev.state}</span>
            </div>
            <div class="device-details-grid">
              <div><span class="detail-k">SN:</span> ${dev.serial}</div>
              <div><span class="detail-k">Android:</span> ${dev.android}</div>
              <div><span class="detail-k">CSC:</span> ${dev.csc}</div>
              <div><span class="detail-k">Build:</span> ${dev.build}</div>
              <div><span class="detail-k">Modem:</span> ${dev.modem}</div>
              <div><span class="detail-k">Patch:</span> ${dev.security_patch}</div>
            </div>
            <div class="device-actions">
              <button class="btn btn-outline btn-xs" data-act="home" data-serial="${dev.serial}" data-node="${node.nodeId}">Home</button>
              <button class="btn btn-outline btn-xs" data-act="lamp" data-serial="${dev.serial}" data-node="${node.nodeId}">Lamp</button>
              <button class="btn btn-outline btn-xs" data-act="clear" data-serial="${dev.serial}" data-node="${node.nodeId}">Clear Res</button>
            </div>
          </div>
        `;
        devList.appendChild(card);
      }
    }

    group.appendChild(devList);
    els.deviceFleetContainer.appendChild(group);
  }

  attachDeviceListeners();
  updateSelectionUI();
}

function attachDeviceListeners() {
  document.querySelectorAll('.device-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const serial = target.dataset.serial!;
      const nodeId = target.dataset.nodeId!;
      if (target.checked) {
        selectedDevices.set(serial, nodeId);
      } else {
        selectedDevices.delete(serial);
      }
      renderFleet();
    });
  });

  document.querySelectorAll('[data-preflight-node]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const nodeId = (e.currentTarget as HTMLElement).dataset.preflightNode!;
      runPreflightForNode(nodeId);
    });
  });

  document.querySelectorAll('[data-update-node]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const nodeId = (e.currentTarget as HTMLElement).dataset.updateNode!;
      if (confirm(`Trigger remote silent update on node ${nodeId}?`)) {
        appendConsole(`[System] Sending silent update command to node ${nodeId}...`, 'info');
        sendToHub({ type: 'UPDATE_BRIDGE', payload: { nodeId } });
      }
    });
  });

  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const act = target.dataset.act;
      const serial = target.dataset.serial!;
      const nodeId = target.dataset.node!;

      if (act === 'home') {
        sendToHub({ type: 'PRESS_HOME', payload: { nodeId, serial } });
      } else if (act === 'lamp') {
        sendToHub({ type: 'SET_LAMP', payload: { nodeId, serial, state: true } });
      } else if (act === 'clear') {
        if (confirm(`Archive and clear results for ${serial}?`)) {
          sendToHub({ type: 'CLEAR_RESULTS', payload: { nodeId, serial } });
        }
      }
    });
  });
}

function updateSelectionUI() {
  const count = selectedDevices.size;
  els.selectedCountBadge.textContent = `${count} selected`;
  els.selectedCountBadge.className = `badge ${count > 0 ? 'active' : ''}`;

  const hasTools = getSelectedTools().length > 0;
  els.runBatchBtn.disabled = count === 0 || !hasTools || activeRunId !== null;
}

function getSelectedTools(): string[] {
  const tools: string[] = [];
  els.toolChips.querySelectorAll('input:checked').forEach((input) => {
    tools.push((input as HTMLInputElement).value);
  });
  return tools;
}

function setRunState(running: boolean) {
  if (running) {
    els.batchStatusTag.textContent = 'RUNNING';
    els.batchStatusTag.className = 'batch-status-tag running';
    els.runBatchBtn.disabled = true;
    els.cancelBatchBtn.disabled = false;
  } else {
    activeRunId = null;
    els.batchStatusTag.textContent = 'IDLE';
    els.batchStatusTag.className = 'batch-status-tag';
    els.cancelBatchBtn.disabled = true;
    updateSelectionUI();
  }
}

function sendToHub(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    appendConsole('[System] Cannot send: Hub WebSocket not connected', 'err');
  }
}

function appendConsole(line: string, level: 'normal' | 'info' | 'warn' | 'err' | 'success' = 'normal') {
  logLinesCount++;
  els.logCount.textContent = `${logLinesCount} lines`;

  const filter = els.logFilter.value.toLowerCase().trim();
  const div = document.createElement('div');
  div.className = `log-line ${level}`;
  div.textContent = line;

  if (filter && !line.toLowerCase().includes(filter)) {
    div.style.display = 'none';
  }

  els.consoleTerminal.appendChild(div);

  if (els.autoScrollCheck.checked) {
    els.consoleTerminal.scrollTop = els.consoleTerminal.scrollHeight;
  }
}

function runPreflightForNode(nodeId: string) {
  els.preflightModal.style.display = 'flex';
  els.preflightReportsContainer.innerHTML = `<div class="preflight-block">[Preflight] Requesting report from node ${nodeId}...</div>`;
  sendToHub({ type: 'PREFLIGHT', payload: { nodeId } });
}

function renderPreflightReport(nodeId: string, report: string[]) {
  const block = document.createElement('div');
  block.className = 'preflight-block';
  block.innerHTML = `<strong>Node: ${nodeId}</strong>\n${report.join('\n')}`;
  els.preflightReportsContainer.appendChild(block);
}

// Event Listeners
els.selectAllBtn.addEventListener('click', () => {
  for (const node of Object.values(fleet.nodes)) {
    for (const dev of node.devices || []) {
      selectedDevices.set(dev.serial, node.nodeId);
    }
  }
  renderFleet();
});

els.deselectAllBtn.addEventListener('click', () => {
  selectedDevices.clear();
  renderFleet();
});

els.toolChips.addEventListener('change', updateSelectionUI);

els.runBatchBtn.addEventListener('click', () => {
  const tools = getSelectedTools();
  if (tools.length === 0 || selectedDevices.size === 0) return;

  const concurrency = parseInt(els.concurrencyInput.value, 10) || 1;
  const update = els.updateToolsCheck.checked;

  // Group devices by node
  const nodeBatches = new Map<string, string[]>();
  for (const [serial, nodeId] of selectedDevices.entries()) {
    let list = nodeBatches.get(nodeId);
    if (!list) {
      list = [];
      nodeBatches.set(nodeId, list);
    }
    list.push(serial);
  }

  const runId = `run-${Date.now()}`;
  activeRunId = runId;
  setRunState(true);

  appendConsole(`[System] Initiating Batch Run ${runId} on ${nodeBatches.size} node(s)...`, 'info');

  for (const [nodeId, devices] of nodeBatches.entries()) {
    sendToHub({
      type: 'TRIGGER_RUN',
      payload: {
        nodeId,
        runId,
        devices,
        tools,
        concurrency,
        update
      }
    });
  }
});

els.cancelBatchBtn.addEventListener('click', () => {
  if (!activeRunId) return;
  appendConsole(`[System] Cancelling Batch Run ${activeRunId}...`, 'warn');
  for (const node of Object.values(fleet.nodes)) {
    sendToHub({
      type: 'CANCEL_RUN',
      payload: { nodeId: node.nodeId, runId: activeRunId }
    });
  }
  setRunState(false);
});

els.clearLogsBtn.addEventListener('click', () => {
  els.consoleTerminal.innerHTML = '';
  logLinesCount = 0;
  els.logCount.textContent = '0 lines';
});

els.copyLogsBtn.addEventListener('click', () => {
  const text = Array.from(els.consoleTerminal.querySelectorAll('.log-line'))
    .map((el) => el.textContent)
    .join('\n');
  navigator.clipboard.writeText(text);
  appendConsole('[System] Console logs copied to clipboard', 'info');
});

els.logFilter.addEventListener('input', () => {
  const filter = els.logFilter.value.toLowerCase().trim();
  els.consoleTerminal.querySelectorAll('.log-line').forEach((el) => {
    const text = el.textContent?.toLowerCase() || '';
    (el as HTMLElement).style.display = text.includes(filter) ? '' : 'none';
  });
});

els.preflightBtn.addEventListener('click', () => {
  const nodes = Object.values(fleet.nodes);
  if (nodes.length === 0) {
    alert('No nodes currently connected');
    return;
  }
  els.preflightModal.style.display = 'flex';
  els.preflightReportsContainer.innerHTML = '';
  for (const n of nodes) {
    runPreflightForNode(n.nodeId);
  }
});

els.refreshBtn.addEventListener('click', () => {
  appendConsole('[System] Requesting fleet status update...', 'info');
  // ws will receive next tick
});

els.closePreflightModal.addEventListener('click', () => {
  els.preflightModal.style.display = 'none';
});

// Start WebSocket Connection on load
document.addEventListener('DOMContentLoaded', connectWS);
