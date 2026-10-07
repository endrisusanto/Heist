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

function cleanSpec(val?: string): string {
  if (!val || val === '-') return '-';
  const parts = val.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  const unique = Array.from(new Set(parts));
  return unique.length > 0 ? unique.join('/') : '-';
}

// State
let fleet: FleetState = { nodes: {} };
const selectedDevices = new Map<string, string>(); // serial -> nodeId
const expandedNodes = new Set<string>(); // nodeIds that are expanded in accordion
let activeRunId: string | null = null;
let ws: WebSocket | null = null;
let logLinesCount = 0;
let currentMobileTab: 'fleet' | 'runner' | 'logs' = 'fleet';
let deviceSearchQuery = '';

// DOM Elements
const els = {
  appContent: document.querySelector('.app-content') as HTMLElement,
  hubStatusDot: document.getElementById('hubStatusDot') as HTMLElement,
  hubStatusText: document.getElementById('hubStatusText') as HTMLElement,
  metricNodes: document.getElementById('metricNodes') as HTMLElement,
  metricDevices: document.getElementById('metricDevices') as HTMLElement,
  metricRuns: document.getElementById('metricRuns') as HTMLElement,
  mobileDevCount: document.getElementById('mobileDevCount') as HTMLElement,
  mobileRunIndicator: document.getElementById('mobileRunIndicator') as HTMLElement,
  selectionPill: document.getElementById('selectionPill') as HTMLElement,
  selectAllBtn: document.getElementById('selectAllBtn') as HTMLButtonElement,
  deselectAllBtn: document.getElementById('deselectAllBtn') as HTMLButtonElement,
  deviceSearchInput: document.getElementById('deviceSearchInput') as HTMLInputElement,
  clearSearchBtn: document.getElementById('clearSearchBtn') as HTMLButtonElement,
  fleetAccordionList: document.getElementById('fleetAccordionList') as HTMLElement,
  emptyFleetCard: document.getElementById('emptyFleetCard') as HTMLElement,
  batchStatusTag: document.getElementById('batchStatusTag') as HTMLElement,
  activeDevicesSummary: document.getElementById('activeDevicesSummary') as HTMLElement,
  toolChipGrid: document.getElementById('toolChipGrid') as HTMLElement,
  concurrencyInput: document.getElementById('concurrencyInput') as HTMLInputElement,
  updateToolsCheck: document.getElementById('updateToolsCheck') as HTMLInputElement,
  runBatchBtn: document.getElementById('runBatchBtn') as HTMLButtonElement,
  cancelBatchBtn: document.getElementById('cancelBatchBtn') as HTMLButtonElement,
  consoleTerminal: document.getElementById('consoleTerminal') as HTMLElement,
  logCount: document.getElementById('logCount') as HTMLElement,
  logFilterInput: document.getElementById('logFilterInput') as HTMLInputElement,
  autoScrollCheck: document.getElementById('autoScrollCheck') as HTMLInputElement,
  clearLogsBtn: document.getElementById('clearLogsBtn') as HTMLButtonElement,
  copyLogsBtn: document.getElementById('copyLogsBtn') as HTMLButtonElement,
  preflightAllBtn: document.getElementById('preflightAllBtn') as HTMLButtonElement,
  refreshBtn: document.getElementById('refreshBtn') as HTMLButtonElement,
  preflightModal: document.getElementById('preflightModal') as HTMLElement,
  closePreflightModal: document.getElementById('closePreflightModal') as HTMLButtonElement,
  preflightReportsContainer: document.getElementById('preflightReportsContainer') as HTMLElement,
};

function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/ui`;

  els.hubStatusDot.className = 'stat-dot';
  els.hubStatusText.textContent = 'Connecting...';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    els.hubStatusDot.className = 'stat-dot live';
    els.hubStatusText.textContent = 'Live';
    appendConsole('[Heist Hub] Connected to Central Orchestration Hub', 'sys');
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
    els.hubStatusDot.className = 'stat-dot dead';
    els.hubStatusText.textContent = 'Offline';
    appendConsole('[Heist Hub] Connection lost. Reconnecting in 3s...', 'warn');
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
      // Auto-expand all nodes initially
      for (const nodeId of Object.keys(fleet.nodes)) {
        if (!expandedNodes.has(nodeId)) {
          expandedNodes.add(nodeId);
        }
      }
      renderFleetAccordion();
      updateMetrics();
      break;
    }

    case 'LOG_STREAM': {
      appendConsole(`[${payload.nodeId}][${payload.runId}] ${payload.line}`);
      break;
    }

    case 'RUN_FINISHED': {
      const isOk = payload.exit_code === 0;
      appendConsole(
        `[${payload.nodeId}] Run ${payload.run_id} finished with exit code ${payload.exit_code}`,
        isOk ? 'success' : 'err'
      );
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
      const isSuccess = payload.success;
      appendConsole(`[${payload.nodeId}] Action ${payload.action}: ${payload.message}`, isSuccess ? 'sys' : 'err');
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
  els.mobileDevCount.textContent = deviceCount.toString();

  if (activeRunsCount > 0) {
    els.mobileRunIndicator.className = 'tab-dot active';
    setRunState(true);
  } else {
    els.mobileRunIndicator.className = 'tab-dot';
    if (activeRunId === null) {
      setRunState(false);
    }
  }
}

function renderFleetAccordion() {
  const nodes = Object.values(fleet.nodes);
  if (nodes.length === 0) {
    els.fleetAccordionList.innerHTML = '';
    els.fleetAccordionList.appendChild(els.emptyFleetCard);
    updateSelectionUI();
    return;
  }

  els.fleetAccordionList.innerHTML = '';

  for (const node of nodes) {
    const isExpanded = expandedNodes.has(node.nodeId);
    const nodeItem = document.createElement('div');
    nodeItem.className = `node-accordion-item ${isExpanded ? 'expanded' : ''}`;
    nodeItem.dataset.nodeId = node.nodeId;

    // Filter devices based on search query
    const filteredDevices = (node.devices || []).filter((dev) => {
      if (!deviceSearchQuery) return true;
      const haystack = `${dev.model} ${dev.serial} ${dev.android} ${dev.csc} ${dev.build} ${dev.modem}`.toLowerCase();
      return haystack.includes(deviceSearchQuery);
    });

    const devCount = node.devices?.length || 0;

    nodeItem.innerHTML = `
      <div class="node-accordion-header" data-toggle-node="${node.nodeId}">
        <div class="node-header-left">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="node-name-text">${node.nodeId}</span>
          <span class="node-os-pill">${node.os}</span>
          <span class="node-dev-count-tag">${devCount} dev</span>
        </div>
        <div class="node-header-right" onclick="event.stopPropagation()">
          <button class="btn btn-xs btn-outline" data-action="update-node" data-node="${node.nodeId}">Update</button>
          <button class="btn btn-xs btn-ghost" data-action="preflight-node" data-node="${node.nodeId}">Preflight</button>
          <button class="btn btn-xs btn-ghost" data-action="select-node-devs" data-node="${node.nodeId}">All</button>
        </div>
      </div>

      <div class="node-accordion-body">
        <div class="node-devices-inner">
          ${
            filteredDevices.length === 0
              ? `<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 11px;">${devCount === 0 ? 'No ADB devices detected' : 'No devices match search'}</div>`
              : filteredDevices
                  .map((dev) => {
                    const isSelected = selectedDevices.has(dev.serial);
                    return `
                <div class="device-card-modern ${isSelected ? 'selected' : ''}" data-serial="${dev.serial}" data-node-id="${node.nodeId}">
                  <div class="device-check-col">
                    <input type="checkbox" class="device-checkbox" data-serial="${dev.serial}" data-node-id="${node.nodeId}" ${isSelected ? 'checked' : ''} />
                  </div>
                  <div class="device-content-col">
                    <div class="device-title-row">
                      <span class="device-model-bold">${dev.model || 'Unknown Device'}</span>
                      <span class="state-badge-sm ${dev.state}">${dev.state}</span>
                    </div>
                    <div class="device-specs-grid">
                      <div><span class="spec-key">SN:</span> ${dev.serial || '-'}</div>
                      <div><span class="spec-key">OS:</span> Android ${dev.android || '-'}</div>
                      <div><span class="spec-key">CSC:</span> ${cleanSpec(dev.csc)}</div>
                      <div><span class="spec-key">Build:</span> ${dev.build || '-'}</div>
                      <div><span class="spec-key">Modem:</span> ${cleanSpec(dev.modem)}</div>
                      <div><span class="spec-key">Patch:</span> ${dev.security_patch || '-'}</div>
                    </div>
                    <div class="device-actions-row">
                      <button class="btn btn-xs btn-outline" data-dev-act="home" data-serial="${dev.serial}" data-node="${node.nodeId}">Home</button>
                      <button class="btn btn-xs btn-outline" data-dev-act="lamp" data-serial="${dev.serial}" data-node="${node.nodeId}">Lamp</button>
                      <button class="btn btn-xs btn-outline" data-dev-act="clear" data-serial="${dev.serial}" data-node="${node.nodeId}">Clear Res</button>
                    </div>
                  </div>
                </div>
              `;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    els.fleetAccordionList.appendChild(nodeItem);
  }

  attachAccordionListeners();
  updateSelectionUI();
}

function attachAccordionListeners() {
  // Accordion Toggle
  document.querySelectorAll('[data-toggle-node]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const nodeId = (e.currentTarget as HTMLElement).dataset.toggleNode!;
      if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
      } else {
        expandedNodes.add(nodeId);
      }
      renderFleetAccordion();
    });
  });

  // Node Header Quick Actions
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const act = target.dataset.action;
      const nodeId = target.dataset.node!;

      if (act === 'update-node') {
        if (confirm(`Trigger remote silent update on node ${nodeId}?`)) {
          appendConsole(`[System] Dispatching update to node ${nodeId}...`, 'sys');
          sendToHub({ type: 'UPDATE_BRIDGE', payload: { nodeId } });
        }
      } else if (act === 'preflight-node') {
        runPreflightForNode(nodeId);
      } else if (act === 'select-node-devs') {
        const node = fleet.nodes[nodeId];
        if (node && node.devices) {
          for (const dev of node.devices) {
            selectedDevices.set(dev.serial, nodeId);
          }
          renderFleetAccordion();
        }
      }
    });
  });

  // Device Selection Checkbox
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
      renderFleetAccordion();
    });
  });

  // Device Action Buttons
  document.querySelectorAll('[data-dev-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const act = target.dataset.devAct;
      const serial = target.dataset.serial!;
      const nodeId = target.dataset.node!;

      if (act === 'home') {
        sendToHub({ type: 'PRESS_HOME', payload: { nodeId, serial } });
      } else if (act === 'lamp') {
        sendToHub({ type: 'SET_LAMP', payload: { nodeId, serial, state: true } });
      } else if (act === 'clear') {
        if (confirm(`Archive and clear result directory for ${serial}?`)) {
          sendToHub({ type: 'CLEAR_RESULTS', payload: { nodeId, serial } });
        }
      }
    });
  });
}

function updateSelectionUI() {
  const count = selectedDevices.size;
  els.selectionPill.textContent = `${count} Selected`;
  els.selectionPill.className = `selection-pill ${count > 0 ? 'active' : ''}`;
  els.activeDevicesSummary.textContent = `${count} device${count === 1 ? '' : 's'} queued`;

  const hasTools = getSelectedTools().length > 0;
  els.runBatchBtn.disabled = count === 0 || !hasTools || activeRunId !== null;
}

function getSelectedTools(): string[] {
  const tools: string[] = [];
  els.toolChipGrid.querySelectorAll('input:checked').forEach((input) => {
    tools.push((input as HTMLInputElement).value);
  });
  return tools;
}

function setRunState(running: boolean) {
  if (running) {
    els.batchStatusTag.textContent = 'RUNNING';
    els.batchStatusTag.className = 'status-indicator-tag running';
    els.runBatchBtn.disabled = true;
    els.cancelBatchBtn.disabled = false;
  } else {
    activeRunId = null;
    els.batchStatusTag.textContent = 'IDLE';
    els.batchStatusTag.className = 'status-indicator-tag idle';
    els.cancelBatchBtn.disabled = true;
    updateSelectionUI();
  }
}

function sendToHub(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    appendConsole('[System] Cannot send: Hub WebSocket disconnected', 'err');
  }
}

function appendConsole(line: string, level: 'normal' | 'sys' | 'warn' | 'err' | 'success' = 'normal') {
  logLinesCount++;
  els.logCount.textContent = `${logLinesCount} lines`;

  const filter = els.logFilterInput.value.toLowerCase().trim();
  const div = document.createElement('div');
  div.className = `terminal-row ${level}`;
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
  els.preflightReportsContainer.innerHTML = `<div class="diag-node-block">[Preflight] Requesting diagnostic check from node ${nodeId}...</div>`;
  sendToHub({ type: 'PREFLIGHT', payload: { nodeId } });
}

function renderPreflightReport(nodeId: string, report: string[]) {
  const block = document.createElement('div');
  block.className = 'diag-node-block';
  block.innerHTML = `<strong>Node: ${nodeId}</strong>\n${report.join('\n')}`;
  els.preflightReportsContainer.appendChild(block);
}

// Mobile Tab Switcher
function setupMobileTabs() {
  const tabBtns = document.querySelectorAll('.mobile-tabbar .tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tab = (e.currentTarget as HTMLElement).dataset.tab as 'fleet' | 'runner' | 'logs';
      currentMobileTab = tab;
      tabBtns.forEach((b) => b.classList.remove('active'));
      (e.currentTarget as HTMLElement).classList.add('active');

      els.appContent.className = `app-content tab-${tab}`;
    });
  });
  // Default tab
  els.appContent.className = `app-content tab-fleet`;
}

// Tool Chips Toggle Class Listener
function setupToolChips() {
  els.toolChipGrid.querySelectorAll('.tool-toggle-chip').forEach((chip) => {
    const input = chip.querySelector('input')!;
    input.addEventListener('change', () => {
      chip.classList.toggle('active', input.checked);
      updateSelectionUI();
    });
  });
}

// Device Search Filter
els.deviceSearchInput.addEventListener('input', () => {
  deviceSearchQuery = els.deviceSearchInput.value.toLowerCase().trim();
  els.clearSearchBtn.style.display = deviceSearchQuery ? 'block' : 'none';
  renderFleetAccordion();
});

els.clearSearchBtn.addEventListener('click', () => {
  els.deviceSearchInput.value = '';
  deviceSearchQuery = '';
  els.clearSearchBtn.style.display = 'none';
  renderFleetAccordion();
});

// Select / Deselect All
els.selectAllBtn.addEventListener('click', () => {
  for (const [nodeId, node] of Object.entries(fleet.nodes)) {
    for (const dev of node.devices || []) {
      selectedDevices.set(dev.serial, nodeId);
    }
  }
  renderFleetAccordion();
});

els.deselectAllBtn.addEventListener('click', () => {
  selectedDevices.clear();
  renderFleetAccordion();
});

// Batch Execution
els.runBatchBtn.addEventListener('click', () => {
  const tools = getSelectedTools();
  if (tools.length === 0 || selectedDevices.size === 0) return;

  const concurrency = parseInt(els.concurrencyInput.value, 10) || 1;
  const update = els.updateToolsCheck.checked;

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

  appendConsole(`[System] Initiating Batch Suite ${runId} across ${nodeBatches.size} node(s)...`, 'sys');

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
  appendConsole(`[System] Cancelling Batch Suite ${activeRunId}...`, 'warn');
  for (const node of Object.values(fleet.nodes)) {
    sendToHub({
      type: 'CANCEL_RUN',
      payload: { nodeId: node.nodeId, runId: activeRunId }
    });
  }
  setRunState(false);
});

// Console controls
els.clearLogsBtn.addEventListener('click', () => {
  els.consoleTerminal.innerHTML = '';
  logLinesCount = 0;
  els.logCount.textContent = '0 lines';
});

els.copyLogsBtn.addEventListener('click', () => {
  const text = Array.from(els.consoleTerminal.querySelectorAll('.terminal-row'))
    .map((el) => el.textContent)
    .join('\n');
  navigator.clipboard.writeText(text);
  appendConsole('[System] Console content copied to clipboard', 'sys');
});

els.logFilterInput.addEventListener('input', () => {
  const filter = els.logFilterInput.value.toLowerCase().trim();
  els.consoleTerminal.querySelectorAll('.terminal-row').forEach((el) => {
    const text = el.textContent?.toLowerCase() || '';
    (el as HTMLElement).style.display = text.includes(filter) ? '' : 'none';
  });
});

// Preflight controls
els.preflightAllBtn.addEventListener('click', () => {
  const nodes = Object.values(fleet.nodes);
  if (nodes.length === 0) {
    alert('No PC nodes connected');
    return;
  }
  els.preflightModal.style.display = 'flex';
  els.preflightReportsContainer.innerHTML = '';
  for (const n of nodes) {
    runPreflightForNode(n.nodeId);
  }
});

els.refreshBtn.addEventListener('click', () => {
  appendConsole('[System] Refreshing fleet status...', 'sys');
});

els.closePreflightModal.addEventListener('click', () => {
  els.preflightModal.style.display = 'none';
});

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
  setupMobileTabs();
  setupToolChips();
  connectWS();
});
