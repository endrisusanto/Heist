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

interface HistoryItem {
  id: string;
  nodeId: string;
  mode: string;
  devices: string[];
  runtimeSecs: number;
  passed: number;
  failed: number;
  total: number;
  status: 'FINISHED' | 'CANCELLED';
  archiveName: string;
  timestamp: number;
}

// State
let fleet: FleetState = { nodes: {} };
const selectedStandbySerials = new Set<string>(); // serials checked in Standby table
const workflowDevices = new Map<string, { serial: string; nodeId: string; model: string; pda: string; buildType: string }>(); // serial -> meta

let selectedModelFilter = 'ALL';
let globalSearchQuery = '';
let selectedNodeFilter = 'all';
let selectedDeviceModeFilter = 'all';

let activeRunId: string | null = null;
let activeRunStartTime: number | null = null;
let activeRunTimerInterval: any = null;
let activeRunNodeId: string = 'syncmaster';
let activeRunDevices: string[] = [];
let activeRunTools: string[] = ['getprop', 'bvt', 'svt', 'sdt'];

let ws: WebSocket | null = null;
interface LogEntry {
  line: string;
  level: 'normal' | 'sys' | 'warn' | 'err' | 'success';
}
const logEntries: LogEntry[] = [];
let logHistory: string[] = [];
let historyList: HistoryItem[] = loadHistoryFromDisk();
let selectedModalDevice = 'all';
let selectedModalTc = 'all';

// DOM Elements
const els = {
  themeToggleBtn: document.getElementById('themeToggleBtn') as HTMLButtonElement,
  statNodesCount: document.getElementById('statNodesCount') as HTMLElement,
  statDevicesCount: document.getElementById('statDevicesCount') as HTMLElement,
  statJobsCount: document.getElementById('statJobsCount') as HTMLElement,
  preflightBtn: document.getElementById('preflightBtn') as HTMLButtonElement,

  globalSearchInput: document.getElementById('globalSearchInput') as HTMLInputElement,
  clearSearchBtn: document.getElementById('clearSearchBtn') as HTMLButtonElement,
  nodeFilterSelect: document.getElementById('nodeFilterSelect') as HTMLSelectElement,
  deviceModeSelect: document.getElementById('deviceModeSelect') as HTMLSelectElement,
  openTerminalLogsBtn: document.getElementById('openTerminalLogsBtn') as HTMLButtonElement,
  terminalActivePulse: document.getElementById('terminalActivePulse') as HTMLElement,

  // Workflow
  workflowCard: document.getElementById('workflowCard') as HTMLElement,
  workflowModelChipsWrap: document.getElementById('workflowModelChipsWrap') as HTMLElement,
  startAutomationBtn: document.getElementById('startAutomationBtn') as HTMLButtonElement,
  cancelAutomationBtn: document.getElementById('cancelAutomationBtn') as HTMLButtonElement,
  deleteWorkflowBtn: document.getElementById('deleteWorkflowBtn') as HTMLButtonElement,
  uncheckAllToolsBtn: document.getElementById('uncheckAllToolsBtn') as HTMLButtonElement,
  toolSwitches: document.querySelectorAll('.tool-switch') as NodeListOf<HTMLInputElement>,
  workflowDevicesHeaderTitle: document.getElementById('workflowDevicesHeaderTitle') as HTMLElement,
  selectAllWorkflowDevsBtn: document.getElementById('selectAllWorkflowDevsBtn') as HTMLButtonElement,
  workflowDevicesList: document.getElementById('workflowDevicesList') as HTMLElement,

  // Standby
  standbyCard: document.getElementById('standbyCard') as HTMLElement,
  standbyCountBadge: document.getElementById('standbyCountBadge') as HTMLElement,
  resetBusyBtn: document.getElementById('resetBusyBtn') as HTMLButtonElement,
  addToWorkflowBtn: document.getElementById('addToWorkflowBtn') as HTMLButtonElement,
  standbyFilterChips: document.getElementById('standbyFilterChips') as HTMLElement,
  selectAllStandbyCheck: document.getElementById('selectAllStandbyCheck') as HTMLInputElement,
  standbyTableBody: document.getElementById('standbyTableBody') as HTMLElement,

  // History
  historyCard: document.getElementById('historyCard') as HTMLElement,
  historyCountBadge: document.getElementById('historyCountBadge') as HTMLElement,
  clearAllHistoryBtn: document.getElementById('clearAllHistoryBtn') as HTMLButtonElement,
  historyTableBody: document.getElementById('historyTableBody') as HTMLElement,

  // Terminal Modal
  terminalModal: document.getElementById('terminalModal') as HTMLElement,
  modalRunStatusBadge: document.getElementById('modalRunStatusBadge') as HTMLElement,
  modalNodeIdLabel: document.getElementById('modalNodeIdLabel') as HTMLElement,
  modalDeviceSelect: document.getElementById('modalDeviceSelect') as HTMLSelectElement,
  modalTestcaseChips: document.getElementById('modalTestcaseChips') as HTMLElement,
  modalRuntimeTag: document.getElementById('modalRuntimeTag') as HTMLElement,
  modalClearLogBtn: document.getElementById('modalClearLogBtn') as HTMLButtonElement,
  modalCopyLogBtn: document.getElementById('modalCopyLogBtn') as HTMLButtonElement,
  modalCloseBtn: document.getElementById('modalCloseBtn') as HTMLButtonElement,
  modalChipsBar: document.getElementById('modalChipsBar') as HTMLElement,
  modalConsoleOutput: document.getElementById('modalConsoleOutput') as HTMLElement,

  // Preflight Modal
  preflightModal: document.getElementById('preflightModal') as HTMLElement,
  closePreflightModal: document.getElementById('closePreflightModal') as HTMLButtonElement,
  preflightReportsContainer: document.getElementById('preflightReportsContainer') as HTMLElement,
};

function cleanSpec(val?: string): string {
  if (!val || val === '-') return '-';
  const parts = val.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  const unique = Array.from(new Set(parts));
  return unique.length > 0 ? unique.join('/') : '-';
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function formatTimeDigital(totalSeconds: number): string {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// WebSocket Connection
function connectWS() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${loc.host}/ws/ui`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    appendModalLog('[Heist Hub] Connected to Central Automation Server', 'sys');
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
    appendModalLog('[Heist Hub] Connection lost. Reconnecting in 3s...', 'warn');
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
      updateNodeDropdown();
      renderAll();
      break;
    }

    case 'LOG_STREAM': {
      appendModalLog(`[${payload.nodeId}][${payload.runId}] ${payload.line}`);
      parseTestcaseProgress(payload.line);
      break;
    }

    case 'RUN_FINISHED': {
      const isOk = payload.exit_code === 0;
      appendModalLog(
        `[${payload.nodeId}] Run ${payload.run_id} finished with exit code ${payload.exit_code}`,
        isOk ? 'success' : 'err'
      );
      finishCurrentRun(isOk ? 'FINISHED' : 'CANCELLED');
      break;
    }

    case 'PREFLIGHT_REPORT': {
      renderPreflightReport(payload.nodeId, payload.report);
      break;
    }

    case 'ACTION_RESPONSE': {
      const isSuccess = payload.success;
      appendModalLog(`[${payload.nodeId}] Action ${payload.action}: ${payload.message}`, isSuccess ? 'sys' : 'err');
      break;
    }
  }
}

// Render All Components
function renderAll() {
  renderStats();
  renderStandbyDevices();
  renderWorkflow();
  renderHistory();
  updateModalControls();
}

function renderStats() {
  const nodes = Object.values(fleet.nodes);
  let devCount = 0;
  let jobCount = 0;

  for (const n of nodes) {
    devCount += n.devices?.length || 0;
    jobCount += n.activeRuns?.length || 0;
  }

  els.statNodesCount.textContent = nodes.length.toString();
  els.statDevicesCount.textContent = devCount.toString();
  els.statJobsCount.textContent = jobCount.toString();

  if (activeRunId || jobCount > 0) {
    els.terminalActivePulse.style.display = 'inline-block';
  } else {
    els.terminalActivePulse.style.display = 'none';
  }
}

function updateNodeDropdown() {
  const currentVal = els.nodeFilterSelect.value;
  const nodes = Object.values(fleet.nodes);
  els.nodeFilterSelect.innerHTML = '<option value="all">Semua PC Node</option>';
  for (const n of nodes) {
    const opt = document.createElement('option');
    opt.value = n.nodeId;
    opt.textContent = `${n.nodeId} (${n.os})`;
    els.nodeFilterSelect.appendChild(opt);
  }
  if (Array.from(els.nodeFilterSelect.options).some(o => o.value === currentVal)) {
    els.nodeFilterSelect.value = currentVal;
  }
}

// Standby Devices & Filter Chips
function getAllConnectedDevices(): Array<{ device: DeviceInfo; nodeId: string }> {
  const list: Array<{ device: DeviceInfo; nodeId: string }> = [];
  for (const node of Object.values(fleet.nodes)) {
    if (selectedNodeFilter !== 'all' && node.nodeId !== selectedNodeFilter) {
      continue;
    }
    for (const dev of node.devices || []) {
      // Filter mode
      if (selectedDeviceModeFilter === 'user' && !dev.build_type.toLowerCase().includes('user') && !dev.build.toLowerCase().includes('user')) {
        continue;
      }
      if (selectedDeviceModeFilter === 'userdebug' && !dev.build_type.toLowerCase().includes('userdebug')) {
        continue;
      }
      // Global search
      if (globalSearchQuery) {
        const hay = `${dev.model} ${dev.serial} ${dev.build} ${dev.csc} ${node.nodeId}`.toLowerCase();
        if (!hay.includes(globalSearchQuery)) continue;
      }
      list.push({ device: dev, nodeId: node.nodeId });
    }
  }
  return list;
}

function renderStandbyDevices() {
  const allDevs = getAllConnectedDevices();
  els.standbyCountBadge.textContent = allDevs.length.toString();

  // 1. Calculate Model Counts for Filter Chips
  const modelCounts = new Map<string, number>();
  for (const { device } of allDevs) {
    const m = (device.model || 'UNKNOWN').trim();
    modelCounts.set(m, (modelCounts.get(m) || 0) + 1);
  }

  // Render Filter Chips with Icons
  let chipsHtml = `
    <button class="filter-chip ${selectedModelFilter === 'ALL' ? 'active' : ''}" data-model="ALL">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <span>SEMUA</span>
      <span class="chip-count">${allDevs.length}</span>
    </button>
  `;

  Array.from(modelCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([model, count]) => {
      const isActive = selectedModelFilter === model;
      chipsHtml += `
        <button class="filter-chip ${isActive ? 'active' : ''}" data-model="${model}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          <span>${model}</span>
          <span class="chip-count">${count}</span>
        </button>
      `;
    });

  els.standbyFilterChips.innerHTML = chipsHtml;

  // Attach chip listeners
  els.standbyFilterChips.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      selectedModelFilter = target.dataset.model || 'ALL';
      renderStandbyDevices();
    });
  });

  // 2. Filter devices for table display
  const filteredDevs = allDevs.filter(({ device }) => {
    if (selectedModelFilter === 'ALL') return true;
    return (device.model || '').trim() === selectedModelFilter;
  });

  if (filteredDevs.length === 0) {
    els.standbyTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-table-cell">
          ${allDevs.length === 0 ? 'Tidak ada perangkat standby terdeteksi. Pastikan ADB bridge berjalan.' : 'Tidak ada perangkat yang cocok dengan filter model.'}
        </td>
      </tr>
    `;
    els.addToWorkflowBtn.disabled = true;
    return;
  }

  let tableHtml = '';
  for (const { device, nodeId } of filteredDevs) {
    const isChecked = selectedStandbySerials.has(device.serial);
    const isBusy = activeRunDevices.includes(device.serial);
    const isUserDebug = (device.build_type || '').toLowerCase().includes('userdebug');

    tableHtml += `
      <tr data-serial="${device.serial}" data-node="${nodeId}">
        <td style="text-align: center;">
          <input type="checkbox" class="standby-dev-check" data-serial="${device.serial}" data-node="${nodeId}" data-model="${device.model || 'Unknown'}" data-pda="${device.build || '-'}" data-type="${device.build_type || 'user'}" ${isChecked ? 'checked' : ''} />
        </td>
        <td>
          <span class="pill-pc-id">${nodeId}</span>
        </td>
        <td>
          <div class="model-title-wrap">
            <span class="model-bold">${device.model || 'Unknown Device'}</span>
            <span class="type-pill ${isUserDebug ? 'userdebug' : 'user'}">${isUserDebug ? 'USERDEBUG' : 'USER'}</span>
          </div>
          <div class="pda-subtext">${device.build || '-'}</div>
        </td>
        <td>
          <span class="serial-mono">${device.serial}</span>
        </td>
        <td>
          <span class="status-pill ${isBusy ? 'busy' : 'ready'}">${isBusy ? 'BUSY' : 'READY'}</span>
        </td>
      </tr>
    `;
  }

  els.standbyTableBody.innerHTML = tableHtml;

  // Standby Checkbox Listeners
  els.standbyTableBody.querySelectorAll('.standby-dev-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const serial = target.dataset.serial!;
      if (target.checked) {
        selectedStandbySerials.add(serial);
      } else {
        selectedStandbySerials.delete(serial);
      }
      updateStandbySelectionUI();
    });
  });

  updateStandbySelectionUI();
}

function updateStandbySelectionUI() {
  const count = selectedStandbySerials.size;
  els.addToWorkflowBtn.disabled = count === 0;

  const allChecks = els.standbyTableBody.querySelectorAll('.standby-dev-check') as NodeListOf<HTMLInputElement>;
  if (allChecks.length > 0) {
    const allChecked = Array.from(allChecks).every(c => c.checked);
    els.selectAllStandbyCheck.checked = allChecked;
  } else {
    els.selectAllStandbyCheck.checked = false;
  }
}

// Workflow Area
function renderWorkflow() {
  const count = workflowDevices.size;

  // Initial state / Empty state: Hide the entire ATM Workflow card
  if (count === 0) {
    els.workflowCard.style.display = 'none';
    if (els.workflowModelChipsWrap) els.workflowModelChipsWrap.innerHTML = '';
    els.workflowDevicesHeaderTitle.textContent = `DEVICES (0 Unit)`;
    els.workflowDevicesList.innerHTML = `<div class="empty-sub-placeholder">Tidak ada perangkat aktif di workflow ini. Centang perangkat di tabel Standby dan klik [Add to Workflow].</div>`;
    els.startAutomationBtn.disabled = true;
    return;
  }

  // Show ATM Workflow card when devices are present
  els.workflowCard.style.display = 'block';

  // Render individual model chips with counts
  const modelCounts = new Map<string, number>();
  for (const dev of workflowDevices.values()) {
    const m = dev.model || 'Unknown';
    modelCounts.set(m, (modelCounts.get(m) || 0) + 1);
  }
  let modelChipsHtml = '';
  for (const [m, c] of modelCounts.entries()) {
    modelChipsHtml += `<span class="model-badge-tag">${m} <span class="badge-inner-count">${c}</span></span>`;
  }
  if (els.workflowModelChipsWrap) {
    els.workflowModelChipsWrap.innerHTML = modelChipsHtml;
  }

  // Render Workflow Devices List (Nested chip-inside-chip)
  els.workflowDevicesHeaderTitle.textContent = `DEVICES (${count} Unit)`;
  let devChipsHtml = '';
  for (const [serial, dev] of workflowDevices.entries()) {
    devChipsHtml += `
      <div class="nested-parent-chip">
        <span class="nested-inner-chip pc-id">${dev.nodeId || 'Node'}</span>
        <span class="nested-inner-chip model">${dev.model || 'Unknown'}</span>
        <span class="nested-inner-chip serial">${serial}</span>
        <span class="nested-inner-chip pda">${dev.pda || '-'}</span>
        <button class="btn-nested-remove" data-remove-serial="${serial}" title="Hapus dari workflow">&times;</button>
      </div>
    `;
  }
  els.workflowDevicesList.innerHTML = devChipsHtml;

  els.workflowDevicesList.querySelectorAll('[data-remove-serial]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const s = (e.currentTarget as HTMLElement).dataset.removeSerial!;
      workflowDevices.delete(s);
      renderWorkflow();
    });
  });

  els.startAutomationBtn.disabled = activeRunId !== null || getSelectedTools().length === 0;
}

function getSelectedTools(): string[] {
  const tools: string[] = [];
  els.toolSwitches.forEach((sw) => {
    if (sw.checked) {
      tools.push(sw.dataset.tool!);
    }
  });
  return tools;
}

// Test Run Execution
function startAutomation() {
  const tools = getSelectedTools();
  const devices = Array.from(workflowDevices.keys());

  if (devices.length === 0 || tools.length === 0) {
    alert('Pilih minimal 1 perangkat dan 1 testcase.');
    return;
  }

  const runId = `run-${Date.now()}`;
  activeRunId = runId;
  activeRunStartTime = Date.now();
  activeRunDevices = devices;
  activeRunTools = tools;

  const nodeBatches = new Map<string, string[]>();
  for (const [serial, item] of workflowDevices.entries()) {
    let list = nodeBatches.get(item.nodeId);
    if (!list) {
      list = [];
      nodeBatches.set(item.nodeId, list);
    }
    list.push(serial);
  }

  activeRunNodeId = Array.from(nodeBatches.keys())[0] || 'syncmaster';

  // Update UI to running state (Outline with animated progress bar)
  els.startAutomationBtn.classList.add('running');
  els.startAutomationBtn.disabled = true;
  els.startAutomationBtn.innerHTML = `<span>Menjalankan Automasi...</span>`;
  els.cancelAutomationBtn.style.display = 'inline-flex';
  els.terminalActivePulse.style.display = 'inline-block';

  // Reset tool table states
  tools.forEach((t) => {
    setToolRowStatus(t, 'RUNNING', 'Running automated test...');
  });

  // Start timer
  if (activeRunTimerInterval) clearInterval(activeRunTimerInterval);
  activeRunTimerInterval = setInterval(() => {
    if (activeRunStartTime) {
      const elapsed = Math.floor((Date.now() - activeRunStartTime) / 1000);
      const timeStr = formatTimeDigital(elapsed);
      tools.forEach((t) => {
        const timeEl = document.getElementById(`time_${t}`);
        if (timeEl) timeEl.textContent = timeStr;
      });
      els.modalRuntimeTag.textContent = formatDuration(elapsed);
    }
  }, 1000);

  // Update Terminal Modal Tag
  els.modalRunStatusBadge.textContent = '[RUNNING]';
  els.modalRunStatusBadge.className = 'modal-status-badge running';
  if (els.modalNodeIdLabel) {
    els.modalNodeIdLabel.textContent = activeRunNodeId;
  }
  updateModalControls();

  appendModalLog(`[Hub] Starting Automation Suite ${runId} across ${nodeBatches.size} node(s)...`, 'sys');

  // Dispatch TRIGGER_RUN to each node
  for (const [nodeId, devList] of nodeBatches.entries()) {
    sendToHub({
      type: 'TRIGGER_RUN',
      payload: {
        nodeId,
        runId,
        devices: devList,
        tools,
        concurrency: 1,
        update: false
      }
    });
  }

  renderStandbyDevices();
}

function cancelAutomation() {
  if (!activeRunId) return;
  appendModalLog(`[Hub] Cancelling active automation suite ${activeRunId}...`, 'warn');

  for (const node of Object.values(fleet.nodes)) {
    sendToHub({
      type: 'CANCEL_RUN',
      payload: { nodeId: node.nodeId, runId: activeRunId }
    });
  }

  finishCurrentRun('CANCELLED');
}

function finishCurrentRun(status: 'FINISHED' | 'CANCELLED') {
  if (activeRunTimerInterval) {
    clearInterval(activeRunTimerInterval);
    activeRunTimerInterval = null;
  }

  const elapsed = activeRunStartTime ? Math.floor((Date.now() - activeRunStartTime) / 1000) : 0;
  const tools = [...activeRunTools];
  const devices = [...activeRunDevices];
  const nodeId = activeRunNodeId;

  // Add to History
  const historyItem: HistoryItem = {
    id: activeRunId || `run-${Date.now()}`,
    nodeId,
    mode: tools.map(t => t.toUpperCase()).join(', '),
    devices,
    runtimeSecs: elapsed,
    passed: status === 'FINISHED' ? devices.length * tools.length : 0,
    failed: 0,
    total: devices.length * tools.length,
    status,
    archiveName: `ATM_${devices[0] || 'device'}_results.zip`,
    timestamp: Date.now()
  };

  historyList.unshift(historyItem);
  saveHistoryToDisk(historyList);

  // Update tool table statuses
  tools.forEach((t) => {
    setToolRowStatus(
      t,
      status === 'FINISHED' ? 'PASSED' : 'STANDBY',
      status === 'FINISHED' ? 'Completed successfully.' : 'Cancelled.'
    );
  });

  // Reset running state
  activeRunId = null;
  activeRunStartTime = null;
  activeRunDevices = [];

  els.startAutomationBtn.classList.remove('running');
  els.startAutomationBtn.disabled = false;
  els.startAutomationBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    <span>Jalankan Automasi</span>
  `;
  els.startAutomationBtn.style.display = 'inline-flex';
  els.cancelAutomationBtn.style.display = 'none';
  els.modalRunStatusBadge.textContent = `[${status}]`;
  els.modalRunStatusBadge.className = `modal-status-badge ${status.toLowerCase()}`;

  renderAll();
}

// Real Download Trigger Function
(window as any).downloadFile = function(fileName: string, tool?: string, serial?: string, nodeId?: string) {
  const params = new URLSearchParams({
    file: fileName,
    ...(tool ? { tool } : {}),
    ...(serial ? { serial } : {}),
    ...(nodeId ? { nodeId } : {}),
  });
  const url = `/api/download?${params.toString()}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

function setToolRowStatus(tool: string, status: 'STANDBY' | 'RUNNING' | 'PASSED' | 'WARNING' | 'FAILED', subtext: string) {
  const statusEl = document.getElementById(`status_${tool}`);
  const subtestEl = document.getElementById(`subtest_${tool}`);
  const resEl = document.getElementById(`res_${tool}`);

  if (statusEl) {
    statusEl.textContent = status;
    statusEl.className = `status-pill ${status.toLowerCase()}`;
  }

  if (subtestEl) {
    subtestEl.textContent = subtext;
  }

  if (resEl) {
    if (status === 'PASSED') {
      const devSerial = activeRunDevices[0] || 'device';
      resEl.innerHTML = `
        <button class="btn-download-sm" onclick="window.downloadFile('${tool}_result.txt', '${tool}', '${devSerial}')">Download</button>
        <span class="badge-res pass">Pass 1</span>
      `;
    } else if (status === 'STANDBY') {
      resEl.innerHTML = `<button class="btn-download-sm" disabled>Download</button>`;
    }
  }
}

function parseTestcaseProgress(line: string) {
  // Check for pass/fail/error markers in terminal stream
  if (line.includes('[Getprop] END Getprop') || line.includes('Getprop execution completed')) {
    setToolRowStatus('getprop', 'PASSED', 'Pengumpulan build properties sukses.');
  }
  if (line.includes('BVT') && line.includes('PASS')) {
    setToolRowStatus('bvt', 'PASSED', 'BVT Tests completed successfully.');
  }
  if (line.includes('SVT') && line.includes('PASS')) {
    setToolRowStatus('svt', 'PASSED', 'SVT Preload validation passed.');
  }
  if (line.includes('SDT') && line.includes('PASS')) {
    setToolRowStatus('sdt', 'PASSED', 'SDT Device test passed.');
  }
}

// History
function renderHistory() {
  els.historyCountBadge.textContent = historyList.length.toString();

  if (historyList.length === 0) {
    els.historyTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-table-cell">Belum ada riwayat pengujian.</td>
      </tr>
    `;
    return;
  }

  let html = '';
  for (const item of historyList) {
    const isFinished = item.status === 'FINISHED';
    html += `
      <tr data-history-id="${item.id}">
        <td><span class="pill-pc-id">${item.nodeId}</span></td>
        <td><strong>${item.mode}</strong></td>
        <td><span class="pill-pc-id">${item.devices[0] || 'device'}</span></td>
        <td class="time-col">${formatDuration(item.runtimeSecs)}</td>
        <td><span class="count-pill-sm ${item.passed > 0 ? 'green' : 'gray'}">${item.passed}</span></td>
        <td><span class="count-pill-sm ${item.failed > 0 ? 'red' : 'gray'}">${item.failed}</span></td>
        <td><span class="count-pill-sm gray">${item.total}</span></td>
        <td><span class="status-pill ${isFinished ? 'finished' : 'cancelled'}">${item.status}</span></td>
        <td>
          ${
            isFinished
              ? `<a href="#" class="archive-pill-link" onclick="window.downloadFile('${item.archiveName}', undefined, '${item.devices[0] || 'device'}', '${item.nodeId}'); return false;">${item.archiveName}</a>`
              : `<span style="color: var(--text-muted); font-size: 10.5px;">No Zip</span>`
          }
        </td>
        <td style="text-align: center;">
          <button class="btn-icon-danger" data-delete-hist="${item.id}" title="Delete history entry">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </td>
      </tr>
    `;
  }

  els.historyTableBody.innerHTML = html;

  els.historyTableBody.querySelectorAll('[data-delete-hist]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.deleteHist!;
      historyList = historyList.filter(h => h.id !== id);
      saveHistoryToDisk(historyList);
      renderHistory();
    });
  });
}

function loadHistoryFromDisk(): HistoryItem[] {
  try {
    const raw = localStorage.getItem('heist_history_records');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function saveHistoryToDisk(list: HistoryItem[]) {
  try {
    localStorage.setItem('heist_history_records', JSON.stringify(list));
  } catch (e) {}
}

const TOOL_LABELS: Record<string, string> = {
  getprop: 'GetpropSnapshot',
  bvt: 'BasicInfoTests',
  svt: 'SVTPreloadValidation',
  sdt: 'SDTDeviceTest',
};

// Terminal Modal Controls & Filters
function updateModalControls() {
  if (els.modalNodeIdLabel) {
    const activeNode = activeRunNodeId || (selectedNodeFilter !== 'all' ? selectedNodeFilter : Object.keys(fleet.nodes)[0] || 'syncmaster');
    els.modalNodeIdLabel.textContent = activeNode;
  }

  // 1. Devices: ONLY display devices currently queued/active in the workflow
  if (els.modalDeviceSelect) {
    const currentVal = selectedModalDevice;
    els.modalDeviceSelect.innerHTML = '<option value="all">Semua Perangkat Workflow</option>';
    
    // Only devices in workflow (or active run); fallback to connected only if workflow is completely empty
    const workflowDevList = workflowDevices.size > 0
      ? Array.from(workflowDevices.values()).map(d => ({ serial: d.serial, model: d.model }))
      : getAllConnectedDevices().map(d => ({ serial: d.device.serial, model: d.device.model }));

    for (const dev of workflowDevList) {
      const opt = document.createElement('option');
      opt.value = dev.serial;
      opt.textContent = `${dev.model || 'Device'} (${dev.serial})`;
      els.modalDeviceSelect.appendChild(opt);
    }

    if (Array.from(els.modalDeviceSelect.options).some(o => o.value === currentVal)) {
      els.modalDeviceSelect.value = currentVal;
    } else {
      els.modalDeviceSelect.value = 'all';
      selectedModalDevice = 'all';
    }
  }

  // 2. Testcase Chips: ONLY display chips for testcases currently selected/checked in the workflow
  if (els.modalTestcaseChips) {
    const activeTools = getSelectedTools();
    if (selectedModalTc !== 'all' && !activeTools.includes(selectedModalTc)) {
      selectedModalTc = 'all';
    }

    let chipsHtml = `<button class="terminal-tc-chip ${selectedModalTc === 'all' ? 'active' : ''}" data-tc="all">ALL</button>`;
    for (const tool of activeTools) {
      const label = TOOL_LABELS[tool] || tool.toUpperCase();
      const isActive = selectedModalTc === tool;
      chipsHtml += `<button class="terminal-tc-chip ${isActive ? 'active' : ''}" data-tc="${tool}">${label}</button>`;
    }

    els.modalTestcaseChips.innerHTML = chipsHtml;

    // Attach click events to dynamic testcase chips
    els.modalTestcaseChips.querySelectorAll('.terminal-tc-chip').forEach((chipBtn) => {
      chipBtn.addEventListener('click', (e) => {
        els.modalTestcaseChips.querySelectorAll('.terminal-tc-chip').forEach(c => c.classList.remove('active'));
        const clicked = e.currentTarget as HTMLElement;
        clicked.classList.add('active');
        selectedModalTc = clicked.dataset.tc || 'all';
        renderModalConsole();
      });
    });
  }
}

function renderModalConsole() {
  if (!els.modalConsoleOutput) return;
  els.modalConsoleOutput.innerHTML = '';

  const filtered = logEntries.filter((entry) => {
    if (entry.level === 'sys') return true;

    // Filter by Device
    if (selectedModalDevice !== 'all') {
      if (!entry.line.includes(selectedModalDevice)) {
        return false;
      }
    }

    // Filter by Testcase
    if (selectedModalTc !== 'all') {
      const query = selectedModalTc.toLowerCase();
      const lineLower = entry.line.toLowerCase();
      if (!lineLower.includes(query)) {
        return false;
      }
    }

    return true;
  });

  for (const entry of filtered) {
    const div = document.createElement('div');
    div.className = `term-row ${entry.level}`;
    div.textContent = entry.line;
    els.modalConsoleOutput.appendChild(div);
  }

  els.modalConsoleOutput.scrollTop = els.modalConsoleOutput.scrollHeight;
}

function appendModalLog(line: string, level: 'normal' | 'sys' | 'warn' | 'err' | 'success' = 'normal') {
  logHistory.push(line);
  if (logHistory.length > 2000) logHistory.shift();

  logEntries.push({ line, level });
  if (logEntries.length > 2000) logEntries.shift();

  // Check if active filters allow this line
  let passes = true;
  if (level !== 'sys') {
    if (selectedModalDevice !== 'all' && !line.includes(selectedModalDevice)) {
      passes = false;
    }
    if (selectedModalTc !== 'all' && !line.toLowerCase().includes(selectedModalTc.toLowerCase())) {
      passes = false;
    }
  }

  if (passes) {
    const div = document.createElement('div');
    div.className = `term-row ${level}`;
    div.textContent = line;
    els.modalConsoleOutput.appendChild(div);
    els.modalConsoleOutput.scrollTop = els.modalConsoleOutput.scrollHeight;
  }
}

function sendToHub(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    appendModalLog('[Hub] Error: WebSocket not connected', 'err');
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

// Theme System
function setupTheme() {
  const saved = localStorage.getItem('heist_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);

  els.themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('heist_theme', next);
  });
}

// Accordion Toggles
function setupAccordions() {
  // Main Dashboard Cards (Workflow, Standby, History)
  document.querySelectorAll('[data-toggle]').forEach((header) => {
    header.addEventListener('click', (e) => {
      const card = (e.currentTarget as HTMLElement).closest('.dashboard-card');
      if (card) {
        card.classList.toggle('expanded');
      }
    });
  });

  // Sub Accordions
  document.querySelectorAll('[data-toggle-sub]').forEach((subHeader) => {
    subHeader.addEventListener('click', (e) => {
      const box = (e.currentTarget as HTMLElement).closest('.sub-accordion-box');
      if (box) {
        box.classList.toggle('expanded');
      }
    });
  });

  // Expand all by default
  document.querySelectorAll('.dashboard-card').forEach(c => c.classList.add('expanded'));
  document.querySelectorAll('.sub-accordion-box').forEach(b => b.classList.add('expanded'));
}

// Event Listeners Setup
function setupEventListeners() {
  // Standby Select All Checkbox
  els.selectAllStandbyCheck.addEventListener('change', () => {
    const checked = els.selectAllStandbyCheck.checked;
    els.standbyTableBody.querySelectorAll('.standby-dev-check').forEach((cb) => {
      (cb as HTMLInputElement).checked = checked;
      const s = (cb as HTMLInputElement).dataset.serial!;
      if (checked) {
        selectedStandbySerials.add(s);
      } else {
        selectedStandbySerials.delete(s);
      }
    });
    updateStandbySelectionUI();
  });

  // Add to Workflow button
  els.addToWorkflowBtn.addEventListener('click', () => {
    els.standbyTableBody.querySelectorAll('.standby-dev-check:checked').forEach((cb) => {
      const target = cb as HTMLInputElement;
      const serial = target.dataset.serial!;
      const nodeId = target.dataset.node!;
      const model = target.dataset.model!;
      const pda = target.dataset.pda!;
      const buildType = target.dataset.type!;
      workflowDevices.set(serial, { serial, nodeId, model, pda, buildType });
    });
    selectedStandbySerials.clear();
    renderWorkflow();
    renderStandbyDevices();
    if (workflowDevices.size > 0) {
      els.workflowCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // Reset Busy
  els.resetBusyBtn.addEventListener('click', () => {
    activeRunDevices = [];
    renderStandbyDevices();
  });

  // Uncheck All Tools
  els.uncheckAllToolsBtn.addEventListener('click', () => {
    const allChecked = Array.from(els.toolSwitches).some((s) => s.checked);
    els.toolSwitches.forEach((s) => (s.checked = !allChecked));
    els.uncheckAllToolsBtn.textContent = allChecked ? 'Check All' : 'Uncheck';
    renderWorkflow();
  });

  els.toolSwitches.forEach((sw) => {
    sw.addEventListener('change', () => {
      renderWorkflow();
    });
  });

  // Select All Workflow Devices
  els.selectAllWorkflowDevsBtn.addEventListener('click', () => {
    const allDevs = getAllConnectedDevices();
    for (const { device, nodeId } of allDevs) {
      workflowDevices.set(device.serial, {
        serial: device.serial,
        nodeId,
        model: device.model,
        pda: device.build,
        buildType: device.build_type,
      });
    }
    renderWorkflow();
  });

  // Delete Workflow
  els.deleteWorkflowBtn.addEventListener('click', () => {
    workflowDevices.clear();
    renderWorkflow();
    renderStandbyDevices();
  });

  // Execution buttons
  els.startAutomationBtn.addEventListener('click', startAutomation);
  els.cancelAutomationBtn.addEventListener('click', cancelAutomation);

  // Clear History
  els.clearAllHistoryBtn.addEventListener('click', () => {
    if (confirm('Hapus seluruh riwayat pengujian?')) {
      historyList = [];
      saveHistoryToDisk(historyList);
      renderHistory();
    }
  });

  // Search & Filter Inputs
  els.globalSearchInput.addEventListener('input', () => {
    globalSearchQuery = els.globalSearchInput.value.toLowerCase().trim();
    els.clearSearchBtn.style.display = globalSearchQuery ? 'block' : 'none';
    renderStandbyDevices();
  });

  els.clearSearchBtn.addEventListener('click', () => {
    els.globalSearchInput.value = '';
    globalSearchQuery = '';
    els.clearSearchBtn.style.display = 'none';
    renderStandbyDevices();
  });

  els.nodeFilterSelect.addEventListener('change', () => {
    selectedNodeFilter = els.nodeFilterSelect.value;
    renderStandbyDevices();
  });

  els.deviceModeSelect.addEventListener('change', () => {
    selectedDeviceModeFilter = els.deviceModeSelect.value;
    renderStandbyDevices();
  });

  // Terminal Modal
  els.openTerminalLogsBtn.addEventListener('click', () => {
    updateModalControls();
    renderModalConsole();
    els.terminalModal.style.display = 'flex';
  });

  els.modalCloseBtn.addEventListener('click', () => {
    els.terminalModal.style.display = 'none';
  });

  els.terminalModal.addEventListener('click', (e) => {
    if (e.target === els.terminalModal) {
      els.terminalModal.style.display = 'none';
    }
  });

  els.modalClearLogBtn.addEventListener('click', () => {
    els.modalConsoleOutput.innerHTML = '';
    logHistory = [];
    logEntries.length = 0;
  });

  els.modalCopyLogBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(logHistory.join('\n'));
    alert('Log disalin ke clipboard.');
  });

  // Modal Device Select Filter
  if (els.modalDeviceSelect) {
    els.modalDeviceSelect.addEventListener('change', () => {
      selectedModalDevice = els.modalDeviceSelect.value;
      renderModalConsole();
    });
  }

  // Terminal Testcase Chips Filter
  document.querySelectorAll('.terminal-tc-chip').forEach((chipBtn) => {
    chipBtn.addEventListener('click', (e) => {
      document.querySelectorAll('.terminal-tc-chip').forEach(c => c.classList.remove('active'));
      const clicked = e.currentTarget as HTMLElement;
      clicked.classList.add('active');
      selectedModalTc = clicked.dataset.tc || 'all';
      renderModalConsole();
    });
  });

  // Preflight
  els.preflightBtn.addEventListener('click', () => {
    const nodes = Object.values(fleet.nodes);
    if (nodes.length === 0) {
      alert('Tidak ada PC Node yang terhubung.');
      return;
    }
    for (const n of nodes) {
      runPreflightForNode(n.nodeId);
    }
  });

  els.closePreflightModal.addEventListener('click', () => {
    els.preflightModal.style.display = 'none';
  });

  els.preflightModal.addEventListener('click', (e) => {
    if (e.target === els.preflightModal) {
      els.preflightModal.style.display = 'none';
    }
  });
}

// Initializer
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupAccordions();
  setupEventListeners();
  renderAll();
  connectWS();
});
