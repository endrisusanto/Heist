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
  busy?: boolean;
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
  activeRuns?: Record<string, { runId: string; nodeId: string; devices: string[]; tools: string[]; startedAt: number }>;
  busyDevices?: string[];
}

interface HistoryItem {
  id: string;
  nodeId: string;
  mode: string;
  devices: string[];
  pda?: string;
  model?: string;
  runtimeSecs: number;
  passed: number;
  failed: number;
  total: number;
  status: 'FINISHED' | 'CANCELLED';
  archiveName: string;
  timestamp: number;
}

interface DeviceWorkflow {
  serial: string;
  nodeId: string;
  model: string;
  pda: string;
  android?: string;
  buildType: string;
  tools: string[];
  toolStatus: Record<
    string,
    {
      status: string;
      subtext: string;
      duration?: string;
      durationSecs?: number;
      bvtSummary?: { total: number; passed: number; failed: number };
      failedSubtests?: Array<{ name: string; status: string; detail: string }>;
      ctsvSubtestResults?: Record<string, string>;
      sdtDebuggableApps?: string[];
      sdtSecurityPassed?: boolean;
      serial?: string;
      nodeId?: string;
    }
  >;
  ctsvSubtests?: {
    DeviceOwnerTestsNormal: boolean;
    BYODManagedProvisioningNormal: boolean;
  };
  run: {
    runId: string;
    startedAt: number;
    failed: boolean;
  } | null;
}

// State
let fleet: FleetState = { nodes: {} };
let workflows: Record<string, DeviceWorkflow> = {};
const collapsedCardSerials = new Set<string>();
const selectedStandbySerials = new Set<string>(); // serials checked in Standby table

function isDeviceTesting(serial: string): boolean {
  if (workflows[serial]?.run) return true;
  if (fleet.busyDevices && fleet.busyDevices.includes(serial)) return true;
  for (const node of Object.values(fleet.nodes)) {
    const dev = (node.devices || []).find((d) => d.serial === serial);
    if (dev && dev.busy) return true;
  }
  return false;
}

let selectedModelFilter = 'ALL';
let globalSearchQuery = '';
let selectedNodeFilter = 'all';
let selectedDeviceModeFilter = 'all';

let ws: WebSocket | null = null;
interface LogEntry {
  line: string;
  level: 'normal' | 'sys' | 'warn' | 'err' | 'success';
}
const logEntries: LogEntry[] = [];
let logHistory: string[] = [];
let historyList: HistoryItem[] = [];
let clockSkew = 0;
let scrollToWorkflowOnAdd = false;
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

  // Workflows Container
  workflowsContainer: document.getElementById('workflowsContainer') as HTMLElement,

  // Standby
  standbyCard: document.getElementById('standbyCard') as HTMLElement,
  standbyCountBadge: document.getElementById('standbyCountBadge') as HTMLElement,
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
  updateToolsBtn: document.getElementById('updateToolsBtn') as HTMLButtonElement | null,
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

    case 'APP_STATE': {
      applyAppState(payload);
      break;
    }

    case 'LOG': {
      appendModalLog(payload.line, payload.level);
      break;
    }

    case 'LOGS_SNAPSHOT': {
      logEntries.length = 0;
      logHistory = [];
      for (const e of payload.logs) {
        logEntries.push(e);
        logHistory.push(e.line);
      }
      renderModalConsole();
      break;
    }

    case 'PREFLIGHT_REPORT': {
      renderPreflightReport(payload.nodeId, payload.report);
      break;
    }

    case 'ACTION_RESPONSE': {
      const isSuccess = payload.success;
      appendModalLog(`[${payload.nodeId}] Action ${payload.action}: ${payload.message}`, isSuccess ? 'sys' : 'err');
      if (els.preflightModal && els.preflightModal.style.display !== 'none') {
        const block = document.createElement('div');
        block.className = 'diag-node-block';
        block.innerHTML = `<strong>Node ${payload.nodeId} [${payload.action}]</strong>:\n<span style="color: ${isSuccess ? '#10b981' : '#ef4444'}; font-weight: 600;">${payload.message}</span>`;
        els.preflightReportsContainer.appendChild(block);
      }
      break;
    }
  }
}

// Render All Components
function renderAll() {
  renderStats();
  renderStandbyDevices();
  renderWorkflows();
  renderHistory();
  updateModalControls();
}

function renderStats() {
  const nodes = Object.values(fleet.nodes);
  let devCount = 0;
  for (const n of nodes) {
    devCount += n.devices?.length || 0;
  }

  let jobCount = 0;
  for (const wf of Object.values(workflows)) {
    if (wf.run) jobCount++;
  }

  els.statNodesCount.textContent = nodes.length.toString();
  els.statDevicesCount.textContent = devCount.toString();
  els.statJobsCount.textContent = jobCount.toString();
  els.terminalActivePulse.style.display = jobCount > 0 ? 'inline-block' : 'none';
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
    const isBusy = isDeviceTesting(device.serial);
    if (isBusy && selectedStandbySerials.has(device.serial)) {
      selectedStandbySerials.delete(device.serial);
    }
    const isChecked = selectedStandbySerials.has(device.serial);
    const isUserDebug = (device.build_type || '').toLowerCase().includes('userdebug');

    tableHtml += `
      <tr data-serial="${device.serial}" data-node="${nodeId}" class="${isBusy ? 'row-busy' : ''}">
        <td style="text-align: center;">
          <input type="checkbox" class="standby-dev-check" data-serial="${device.serial}" data-node="${nodeId}" data-model="${device.model || 'Unknown'}" data-pda="${device.build || '-'}" data-android="${device.android || ''}" data-type="${device.build_type || 'user'}" ${isChecked ? 'checked' : ''} ${isBusy ? 'disabled' : ''} title="${isBusy ? 'Perangkat sedang menjalankan pengujian' : 'Pilih perangkat'}" />
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
          <span class="status-pill ${isBusy ? 'running' : 'ready'}">${isBusy ? 'RUNNING' : 'READY'}</span>
        </td>
      </tr>
    `;
  }

  els.standbyTableBody.innerHTML = tableHtml;

  // Standby Checkbox Listeners
  els.standbyTableBody.querySelectorAll('.standby-dev-check:not(:disabled)').forEach((cb) => {
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

  const enabledChecks = Array.from(els.standbyTableBody.querySelectorAll('.standby-dev-check:not(:disabled)')) as HTMLInputElement[];
  if (enabledChecks.length > 0) {
    const allChecked = enabledChecks.every((c) => c.checked);
    els.selectAllStandbyCheck.checked = allChecked;
    els.selectAllStandbyCheck.disabled = false;
  } else {
    els.selectAllStandbyCheck.checked = false;
    els.selectAllStandbyCheck.disabled = true;
  }
}

// Workflow Area - Per-device Accordion Cards
interface ToolDef {
  id: string;
  name: string;
  desc: string;
}

const TOOL_DEFS: ToolDef[] = [
  {
    id: 'ctsv',
    name: 'CTS Verifier',
    desc: 'Android Compatibility Test Suite Verifier Auto'
  },
  {
    id: 'getprop',
    name: 'GetpropsSnapshot',
    desc: 'Pengumpulan Informasi Build Property Perangkat'
  },
  {
    id: 'bvt',
    name: 'BasicInfoTests (BVT)',
    desc: 'Pengujian Informasi Dasar & Kompatibilitas BVT'
  },
  {
    id: 'svt',
    name: 'SVTPreloadValidation',
    desc: 'Validasi Preload Aplikasi & Komponen SVT'
  },
  {
    id: 'sdt',
    name: 'SDTDeviceTest',
    desc: 'Eksekusi Paket Pengujian Tersembunyi SDT'
  }
];

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getStatusDisplay(status: string): string {
  switch (status.toUpperCase()) {
    case 'PASSED': return 'Pass';
    case 'RUNNING': return 'Running';
    case 'STANDBY': return 'Standby';
    case 'WARNING': return 'Warning';
    case 'ERROR':
    case 'FAILED': return 'Error (Periksa Log)';
    default: return status;
  }
}

function getStatusClass(status: string): string {
  switch (status.toUpperCase()) {
    case 'PASSED': return 'passed';
    case 'RUNNING': return 'running';
    case 'STANDBY': return 'standby';
    case 'WARNING': return 'warning';
    case 'ERROR':
    case 'FAILED': return 'failed';
    default: return 'standby';
  }
}

function renderCtsvBadge(subName: string, subResults?: Record<string, string>, toolStatus?: string): string {
  if (toolStatus === 'RUNNING') return '';
  if (!subResults) return '';
  const result = subResults[subName];
  if (!result) return '';
  const lower = result.toLowerCase();
  if (lower === 'pass' || lower === 'passed') {
    return `<span class="badge-passed">Passed</span>`;
  }
  if (lower === 'fail' || lower === 'failed') {
    return `<span class="badge-failed">Failed</span>`;
  }
  if (lower.includes('not') || lower.includes('executed')) {
    return `<span class="badge-not-executed">Not Executed</span>`;
  }
  return `<span class="badge-not-executed">${escapeHtml(result)}</span>`;
}

function renderToolDetail(toolId: string, wf: DeviceWorkflow, isRunning: boolean): string {
  const rowState = wf.toolStatus[toolId];
  if (toolId === 'ctsv') {
    const ctsvSub = wf.ctsvSubtests || { DeviceOwnerTestsNormal: true, BYODManagedProvisioningNormal: true };
    const count = (ctsvSub.DeviceOwnerTestsNormal ? 1 : 0) + (ctsvSub.BYODManagedProvisioningNormal ? 1 : 0);
    const status = rowState?.status || 'STANDBY';
    const subResults = rowState?.ctsvSubtestResults;
    const doBadge = renderCtsvBadge('DeviceOwnerTestsNormal', subResults, status);
    const byodBadge = renderCtsvBadge('BYODManagedProvisioningNormal', subResults, status);

    return `
      <div class="ctsv-subtests-container">
        <div class="ctsv-subtests-header">${count}/2 selected</div>
        <div class="ctsv-subtest-row">
          <label class="custom-checkbox-label" title="DeviceOwnerTestsNormal">
            <input type="checkbox" class="ctsv-subtest-chk" data-serial="${wf.serial}" data-subtest="DeviceOwnerTestsNormal" ${ctsvSub.DeviceOwnerTestsNormal ? 'checked' : ''} ${isRunning ? 'disabled' : ''} />
            <span title="DeviceOwnerTestsNormal">DeviceOwnerTestsNormal</span>
          </label>
          ${doBadge}
        </div>
        <div class="ctsv-subtest-row">
          <label class="custom-checkbox-label" title="BYODManagedProvisioningNormal">
            <input type="checkbox" class="ctsv-subtest-chk" data-serial="${wf.serial}" data-subtest="BYODManagedProvisioningNormal" ${ctsvSub.BYODManagedProvisioningNormal ? 'checked' : ''} ${isRunning ? 'disabled' : ''} />
            <span title="BYODManagedProvisioningNormal">BYODManagedProvisioningNormal</span>
          </label>
          ${byodBadge}
        </div>
      </div>
    `;
  }

  if (toolId === 'bvt') {
    const summary = rowState?.bvtSummary;
    const failedList: Array<{ name: string; status: string; detail: string }> = rowState?.failedSubtests || [];
    if (!summary && failedList.length === 0) return `<span class="empty-dash">-</span>`;
    return `
      <div class="bvt-detail-container">
        ${summary ? `<div class="bvt-summary-text">Total: ${summary.total} · Passed: ${summary.passed} · Failed: ${summary.failed}</div>` : ''}
        ${failedList.map((f) => `
          <div class="bvt-failed-item">
            <span class="bvt-failed-name" title="${escapeHtml(f.name + (f.detail ? ': ' + f.detail : ''))}">${escapeHtml(f.name + (f.detail ? ': ' + f.detail : ''))}</span>
            <span class="badge-failed">Failed</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (toolId === 'sdt') {
    const status = rowState?.status || 'STANDBY';
    const apps: string[] = rowState?.sdtDebuggableApps || [];
    const isPassed = status === 'PASSED' || rowState?.sdtSecurityPassed === true;
    const isFailed = status === 'FAILED' || status === 'ERROR' || apps.length > 0;

    if (isFailed && apps.length > 0) {
      return `
        <div class="sdt-detail-container">
          <div class="sdt-failed-row">
            <span class="sdt-failed-title">Debuggable Apps (${apps.length})</span>
            <span class="badge-failed">Failed</span>
          </div>
          <div class="sdt-apps-list">
            ${apps.map((app) => `
              <div class="sdt-app-pill">
                <span class="sdt-app-name" title="${escapeHtml(app)}">${escapeHtml(app)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (isPassed) {
      return `
        <div class="sdt-passed-row">
          <span class="sdt-passed-text">No debuggable apps</span>
          <span class="badge-passed">Passed</span>
        </div>
      `;
    }

    if (status === 'FAILED' || status === 'ERROR') {
      return `
        <div class="sdt-failed-row">
          <span class="sdt-failed-title" title="${escapeHtml(rowState?.subtext || 'SDT Failed')}">${escapeHtml(rowState?.subtext || 'Security Check Failed')}</span>
          <span class="badge-failed">Failed</span>
        </div>
      `;
    }

    return `<span class="empty-dash">-</span>`;
  }

  return `<span class="empty-dash">-</span>`;
}

function renderResultArchiveCell(toolId: string, wf: DeviceWorkflow, status: string, pda: string): string {
  const isPassedOrWarning = status === 'PASSED' || status === 'WARNING';
  const isFailedOrError = status === 'FAILED' || status === 'ERROR';
  const rowState = wf.toolStatus[toolId];

  const toolUpper = toolId === 'getprop' ? 'Getprop' : toolId === 'ctsv' ? 'CTSV' : toolId.toUpperCase();
  const zipName = `${toolUpper}_${pda}.zip`;

  if (!isPassedOrWarning && !isFailedOrError) {
    return `<button class="btn-download-sm" disabled>Download</button>`;
  }

  let passCount = 0;
  let failCount = 0;

  if (toolId === 'ctsv') {
    if (rowState?.ctsvSubtestResults) {
      for (const res of Object.values(rowState.ctsvSubtestResults)) {
        const l = res.toLowerCase();
        if (l === 'pass' || l === 'passed') passCount++;
        else if (l === 'fail' || l === 'failed') failCount++;
      }
    } else {
      passCount = isPassedOrWarning ? (wf.ctsvSubtests?.BYODManagedProvisioningNormal && wf.ctsvSubtests?.DeviceOwnerTestsNormal ? 2 : 1) : 0;
      failCount = isFailedOrError ? 1 : 0;
    }
  } else if (toolId === 'bvt') {
    if (rowState?.bvtSummary) {
      passCount = rowState.bvtSummary.passed || 0;
      failCount = rowState.bvtSummary.failed || 0;
    } else {
      passCount = isPassedOrWarning ? 1 : 0;
      failCount = isFailedOrError ? 1 : 0;
    }
  } else {
    // getprop, svt, sdt
    passCount = isPassedOrWarning ? 1 : 0;
    failCount = isFailedOrError ? 1 : 0;
  }

  const downloadBtn = isPassedOrWarning
    ? `<button class="btn-download-sm" onclick="window.downloadFile('${zipName}', '${toolId}', '${wf.serial}', '${wf.nodeId}', '${pda}', '${wf.model}')">Download</button>`
    : `<button class="btn-download-sm" disabled>Download</button>`;

  let badgesHtml = '';
  if (passCount > 0) {
    badgesHtml += `<span class="badge-res pass">Pass ${passCount}</span>`;
  }
  if (failCount > 0) {
    badgesHtml += `<span class="badge-res fail">Fail ${failCount}</span>`;
  }
  if (!badgesHtml) {
    badgesHtml = isPassedOrWarning ? `<span class="badge-res pass">Pass 1</span>` : `<span class="badge-res fail">Fail 1</span>`;
  }

  return `${downloadBtn}${badgesHtml}`;
}

function renderWorkflows() {
  const list = Object.values(workflows);
  if (list.length === 0) {
    els.workflowsContainer.innerHTML = '';
    ensureRuntimeInterval();
    return;
  }

  // ponytail: check if existing card elements match current devices
  const currentSerials = Object.keys(workflows);
  const existingCards = Array.from(els.workflowsContainer.querySelectorAll<HTMLElement>('[data-workflow-serial]'));
  const existingSerials = existingCards.map((c) => c.dataset.workflowSerial!);
  const isSame = existingSerials.length === currentSerials.length &&
    existingSerials.every((s, i) => s === currentSerials[i]);

  if (!isSame) {
    // Rebuild cards only when devices are added or removed
    let html = '';
    for (const wf of list) {
      const isRunning = wf.run !== null;
      const isBusy = isDeviceTesting(wf.serial) && !isRunning;
      const isCollapsed = collapsedCardSerials.has(wf.serial);
      const allChecked = TOOL_DEFS.every((t) => wf.tools.includes(t.id));
      const activeElapsed = isRunning && wf.run ? Math.max(0, Math.floor((Date.now() - (wf.run.startedAt - clockSkew)) / 1000)) : 0;
      const activeTimeStr = formatTimeDigital(activeElapsed);
      const pda = wf.pda || getDevicePda(wf.serial);
      const rawAndroid = wf.android || getDeviceAndroid(wf.serial);
      const androidVer = rawAndroid ? rawAndroid.replace(/^Android\s*/i, '').trim() : '';

      let rowsHtml = '';
      TOOL_DEFS.forEach((tool) => {
        const isSelected = wf.tools.includes(tool.id);
        const rowState = wf.toolStatus[tool.id];
        const status: string = isRunning
          ? (rowState?.status || (isSelected ? 'STANDBY' : 'STANDBY'))
          : (rowState?.status || 'STANDBY');
        const statusDisplay = getStatusDisplay(status);
        const statusClass = getStatusClass(status);
        const durDisplay = rowState?.duration && rowState.duration !== '-' ? rowState.duration : (status === 'RUNNING' && isRunning ? activeTimeStr : '-');
        const detailHtml = renderToolDetail(tool.id, wf, isRunning);
        const resultHtml = renderResultArchiveCell(tool.id, wf, status, pda);

        rowsHtml += `
          <tr>
            <td style="text-align: center; width: 44px;">
              <input type="checkbox" class="tool-switch custom-checkbox-sq" data-serial="${wf.serial}" data-tool="${tool.id}" ${isSelected ? 'checked' : ''} ${isRunning ? 'disabled' : ''} />
            </td>
            <td style="width: 250px;">
              <div class="tc-cell-content">
                <div class="tc-name-bold">${tool.name}</div>
                <div class="tc-subdesc">${tool.desc}</div>
                <div id="bar_${wf.serial}_${tool.id}" class="tc-progress-bar ${statusClass}"></div>
              </div>
            </td>
            <td style="width: 140px;">
              <span id="status_${wf.serial}_${tool.id}" class="status-pill ${statusClass}">${statusDisplay}</span>
            </td>
            <td>
              <div id="detail_${wf.serial}_${tool.id}">
                ${detailHtml}
              </div>
            </td>
            <td style="width: 90px; text-align: right;">
              <span id="dur_${wf.serial}_${tool.id}" class="time-col">${durDisplay}</span>
            </td>
            <td style="width: 150px; text-align: center;">
              <div id="res_${wf.serial}_${tool.id}">
                ${resultHtml}
              </div>
            </td>
          </tr>
        `;
      });

      const statusPill = isRunning
        ? `<span class="status-pill running">RUNNING</span>`
        : isBusy
        ? `<span class="status-pill warning">BUSY</span>`
        : `<span class="status-pill ready">READY</span>`;

      html += `
        <div class="dashboard-card ${isCollapsed ? '' : 'expanded'}" data-workflow-serial="${wf.serial}">
          <div class="card-main-header" data-card-serial="${wf.serial}">
            <div class="card-header-left">
              <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              <div class="card-title-group">
                <div class="card-title-row">
                  <h2 class="card-heading">ATM Workflow ${wf.model || wf.serial}</h2>
                  ${statusPill}
                </div>
                <div class="card-meta-chips">
                  <span class="pill-pc-id">${escapeHtml(wf.nodeId || 'Node')}</span>
                  <span class="card-header-chip mono">${escapeHtml(wf.serial)}</span>
                  ${pda ? `<span class="card-header-chip mono">${escapeHtml(pda)}</span>` : ''}
                  ${androidVer ? `<span class="card-header-chip">${escapeHtml(androidVer)}</span>` : ''}
                </div>
              </div>
            </div>

            <div class="card-header-right">
              ${
                isRunning
                  ? `
                    <button class="btn btn-blue btn-sm running" disabled>
                      <span>Menjalankan Automasi...</span>
                    </button>
                    <button class="btn-icon-danger btn-cancel-device" data-serial="${wf.serial}" title="Batal Automasi">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                  `
                  : `
                    <button class="btn btn-blue btn-sm btn-start-device" data-serial="${wf.serial}" ${wf.tools.length === 0 || isBusy ? 'disabled' : ''} ${isBusy ? 'title="Perangkat sedang sibuk di sesi lain"' : ''}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      <span>Jalankan Automasi</span>
                    </button>
                    <button class="btn-icon-danger btn-remove-device" data-serial="${wf.serial}" title="Hapus dari workflow">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  `
              }
            </div>
          </div>

          <div class="card-main-body">
            <div class="sub-accordion-box expanded">
              <div class="sub-accordion-header" data-toggle-sub="tools">
                <div class="sub-header-left">
                  <svg class="accordion-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  <span class="sub-heading-text">ATM TEST SUITES</span>
                </div>
              </div>

              <div class="sub-accordion-content">
                <div class="table-responsive">
                  <table class="workflow-table">
                    <thead>
                      <tr>
                        <th style="width: 44px; text-align: center;">
                          <input type="checkbox" class="btn-toggle-tools-checkbox custom-checkbox-sq" data-serial="${wf.serial}" ${allChecked ? 'checked' : ''} ${isRunning ? 'disabled' : ''} title="Toggle Semua Testcase" />
                        </th>
                        <th style="width: 250px;">Testcase</th>
                        <th style="width: 140px;">Status Pengujian</th>
                        <th>Sub-Testcase / Detail</th>
                        <th style="width: 90px; text-align: right;">Durasi</th>
                        <th style="width: 150px; text-align: center;">Result Archive</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rowsHtml}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    els.workflowsContainer.innerHTML = html;
  } else {
    // ponytail: in-place DOM updates without wiping container (eliminates glitch/flicker)
    for (const wf of list) {
      const card = els.workflowsContainer.querySelector<HTMLElement>(`[data-workflow-serial="${wf.serial}"]`);
      if (!card) continue;

      const isRunning = wf.run !== null;
      const isBusy = isDeviceTesting(wf.serial) && !isRunning;
      const allChecked = TOOL_DEFS.every((t) => wf.tools.includes(t.id));
      const activeElapsed = isRunning && wf.run ? Math.max(0, Math.floor((Date.now() - (wf.run.startedAt - clockSkew)) / 1000)) : 0;
      const activeTimeStr = formatTimeDigital(activeElapsed);

      // 0. Update Heading & Meta Chips
      const headingEl = card.querySelector<HTMLElement>('.card-heading');
      if (headingEl) {
        const expectedTitle = `ATM Workflow ${wf.model || wf.serial}`;
        if (headingEl.textContent !== expectedTitle) headingEl.textContent = expectedTitle;
      }
      const chipsEl = card.querySelector<HTMLElement>('.card-meta-chips');
      if (chipsEl) {
        const pda = wf.pda || getDevicePda(wf.serial);
        const rawAndroid = wf.android || getDeviceAndroid(wf.serial);
        const androidVer = rawAndroid ? rawAndroid.replace(/^Android\s*/i, '').trim() : '';
        const chipsHtml = `
          <span class="pill-pc-id">${escapeHtml(wf.nodeId || 'Node')}</span>
          <span class="card-header-chip mono">${escapeHtml(wf.serial)}</span>
          ${pda ? `<span class="card-header-chip mono">${escapeHtml(pda)}</span>` : ''}
          ${androidVer ? `<span class="card-header-chip">${escapeHtml(androidVer)}</span>` : ''}
        `;
        if (chipsEl.innerHTML.replace(/\s+/g, ' ') !== chipsHtml.replace(/\s+/g, ' ')) {
          chipsEl.innerHTML = chipsHtml;
        }
      }

      // 1. Update Card Status Pill
      const cardStatusEl = card.querySelector<HTMLElement>('.card-header-left .status-pill');
      if (cardStatusEl) {
        const nextClass = isRunning ? 'status-pill running' : isBusy ? 'status-pill warning' : 'status-pill ready';
        const nextText = isRunning ? 'RUNNING' : isBusy ? 'BUSY' : 'READY';
        if (cardStatusEl.className !== nextClass) cardStatusEl.className = nextClass;
        if (cardStatusEl.textContent !== nextText) cardStatusEl.textContent = nextText;
      }

      // 2. Update Header Actions
      const headerRight = card.querySelector<HTMLElement>('.card-header-right');
      if (headerRight) {
        const wasRunning = headerRight.querySelector('.btn-cancel-device') !== null;
        if (isRunning !== wasRunning) {
          headerRight.innerHTML = `
            ${
              isRunning
                ? `
                  <button class="btn btn-blue btn-sm running" disabled>
                    <span>Menjalankan Automasi...</span>
                  </button>
                  <button class="btn-icon-danger btn-cancel-device" data-serial="${wf.serial}" title="Batal Automasi">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                  </button>
                `
                : `
                  <button class="btn btn-blue btn-sm btn-start-device" data-serial="${wf.serial}" ${wf.tools.length === 0 || isBusy ? 'disabled' : ''} ${isBusy ? 'title="Perangkat sedang sibuk di sesi lain"' : ''}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <span>Jalankan Automasi</span>
                  </button>
                  <button class="btn-icon-danger btn-remove-device" data-serial="${wf.serial}" title="Hapus dari workflow">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                `
            }
          `;
        } else if (!isRunning) {
          const startBtn = headerRight.querySelector<HTMLButtonElement>('.btn-start-device');
          if (startBtn) {
            startBtn.disabled = wf.tools.length === 0 || isBusy;
          }
        }
      }

      // 3. Update Check/Uncheck button
      const btnToggle = card.querySelector<HTMLInputElement>('.btn-toggle-tools-checkbox');
      if (btnToggle) {
        if (btnToggle.checked !== allChecked) btnToggle.checked = allChecked;
        btnToggle.disabled = isRunning;
      }

      // 4. Update Switches and Tool Rows
      for (const tool of TOOL_DEFS) {
        const isSelected = wf.tools.includes(tool.id);
        const rowState = wf.toolStatus[tool.id];
        const status: string = isRunning
          ? (rowState?.status || (isSelected ? 'STANDBY' : 'STANDBY'))
          : (rowState?.status || 'STANDBY');
        const statusDisplay = getStatusDisplay(status);
        const statusClass = getStatusClass(status);

        const sw = card.querySelector<HTMLInputElement>(`.tool-switch[data-tool="${tool.id}"]`);
        if (sw) {
          if (sw.checked !== isSelected) sw.checked = isSelected;
          sw.disabled = isRunning;
        }

        const barEl = document.getElementById(`bar_${wf.serial}_${tool.id}`);
        if (barEl && barEl.className !== `tc-progress-bar ${statusClass}`) {
          barEl.className = `tc-progress-bar ${statusClass}`;
        }

        const statusEl = document.getElementById(`status_${wf.serial}_${tool.id}`);
        if (statusEl) {
          const sClass = `status-pill ${statusClass}`;
          if (statusEl.className !== sClass) statusEl.className = sClass;
          if (statusEl.textContent !== statusDisplay) statusEl.textContent = statusDisplay;
        }

        const detailEl = document.getElementById(`detail_${wf.serial}_${tool.id}`);
        if (detailEl) {
          const expectedDetail = renderToolDetail(tool.id, wf, isRunning);
          if (detailEl.innerHTML.trim() !== expectedDetail.trim()) {
            detailEl.innerHTML = expectedDetail;
          }
        }

        const durEl = document.getElementById(`dur_${wf.serial}_${tool.id}`);
        if (durEl) {
          const durDisplay = rowState?.duration && rowState.duration !== '-' ? rowState.duration : (status === 'RUNNING' && isRunning ? activeTimeStr : '-');
          if (durEl.textContent !== durDisplay) durEl.textContent = durDisplay;
        }

        const resEl = document.getElementById(`res_${wf.serial}_${tool.id}`);
        if (resEl) {
          const pda = wf.pda || getDevicePda(wf.serial);
          const expectedHtml = renderResultArchiveCell(tool.id, wf, status, pda);
          if (resEl.innerHTML.trim() !== expectedHtml.trim()) {
            resEl.innerHTML = expectedHtml;
          }
        }
      }
    }
  }

  ensureRuntimeInterval();
}

function applyAppState(st: any) {
  clockSkew = st.serverNow - Date.now();
  workflows = st.workflows || {};
  historyList = st.history || [];

  renderAll();

  if (scrollToWorkflowOnAdd && Object.keys(workflows).length > 0) {
    scrollToWorkflowOnAdd = false;
    els.workflowsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

let runtimeInterval: number | null = null;

function ensureRuntimeInterval() {
  const anyRunning = Object.values(workflows).some((w) => w.run !== null);
  if (anyRunning && !runtimeInterval) {
    runtimeInterval = window.setInterval(tickAllRuntimes, 1000);
  } else if (!anyRunning && runtimeInterval) {
    clearInterval(runtimeInterval);
    runtimeInterval = null;
  }
}

function tickAllRuntimes() {
  for (const wf of Object.values(workflows)) {
    if (!wf.run) continue;
    const elapsed = Math.max(0, Math.floor((Date.now() - (wf.run.startedAt - clockSkew)) / 1000));
    const timeStr = formatTimeDigital(elapsed);
    for (const tool of TOOL_DEFS) {
      const rowState = wf.toolStatus[tool.id];
      const durEl = document.getElementById(`dur_${wf.serial}_${tool.id}`);
      if (durEl) {
        if (rowState?.status === 'RUNNING') {
          durEl.textContent = timeStr;
        } else if (rowState?.duration && rowState.duration !== '-') {
          durEl.textContent = rowState.duration;
        }
      }
    }
  }

  const runningList = Object.values(workflows).filter((w) => w.run);
  if (runningList.length > 0 && els.modalRuntimeTag) {
    const maxElapsed = Math.max(
      ...runningList.map((w) => Math.max(0, Math.floor((Date.now() - (w.run!.startedAt - clockSkew)) / 1000)))
    );
    els.modalRuntimeTag.textContent = formatDuration(maxElapsed);
  }
}

function getDeviceAndroid(serial: string): string {
  if (workflows[serial]?.android) {
    return workflows[serial].android!;
  }
  for (const node of Object.values(fleet.nodes)) {
    const dev = node.devices.find((d) => d.serial === serial);
    if (dev && dev.android && dev.android !== '-' && dev.android !== 'UNKNOWN' && dev.android.trim() !== '') {
      return dev.android.trim();
    }
  }
  return '';
}

function getDevicePda(serial: string): string {
  for (const node of Object.values(fleet.nodes)) {
    const dev = node.devices.find((d) => d.serial === serial);
    if (dev) {
      if (dev.build && dev.build !== '-' && dev.build !== 'UNKNOWN' && dev.build.trim() !== '') {
        return dev.build.trim();
      }
      if (dev.csc && dev.csc !== '-' && dev.csc.trim() !== '') {
        return dev.csc.trim();
      }
    }
  }
  return serial;
}

function getDeviceModel(serial: string): string {
  for (const node of Object.values(fleet.nodes)) {
    const dev = node.devices.find((d) => d.serial === serial);
    if (dev && dev.model && dev.model !== '-' && dev.model !== 'UNKNOWN') {
      return dev.model;
    }
  }
  return 'SM-A055F';
}

// Real Download Trigger Function
(window as any).downloadFile = function(fileName: string, tool?: string, serial?: string, nodeId?: string, pda?: string, model?: string, mode?: string) {
  const effectivePda = pda || (serial ? getDevicePda(serial) : '');
  const effectiveModel = model || (serial ? getDeviceModel(serial) : '');
  const params = new URLSearchParams({
    file: fileName,
    ...(tool ? { tool } : {}),
    ...(serial ? { serial } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(effectivePda ? { pda: effectivePda } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(mode ? { mode } : {}),
  });
  const url = `/api/download?${params.toString()}`;
  const link = document.createElement('a');
  link.href = url;
  const isCtsv = (tool && (tool.toLowerCase().includes('cts') || tool.toLowerCase().includes('verifier'))) || fileName.toLowerCase().includes('ctsv');
  if (!isCtsv && fileName) {
    link.download = fileName;
  }
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

function formatModeChips(modeStr: string): string {
  if (!modeStr) return `<span class="mode-chip gray">-</span>`;
  const modes = modeStr.split(/[,+]/).map((m) => m.trim()).filter(Boolean);
  if (modes.length === 0) return `<span class="mode-chip gray">${modeStr}</span>`;

  return modes
    .map((m) => {
      const lower = m.toLowerCase();
      let colorClass = 'blue';
      if (lower.includes('getprop')) colorClass = 'cyan';
      else if (lower.includes('bvt') || lower.includes('basic')) colorClass = 'indigo';
      else if (lower.includes('svt') || lower.includes('preload')) colorClass = 'purple';
      else if (lower.includes('sdt') || lower.includes('device')) colorClass = 'amber';
      else if (lower.includes('full') || lower.includes('auto')) colorClass = 'emerald';
      else if (lower.includes('custom')) colorClass = 'rose';

      return `<span class="mode-chip ${colorClass}">${m}</span>`;
    })
    .join(' ');
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

// History
function renderHistory() {
  els.historyCountBadge.textContent = historyList.length.toString();

  if (historyList.length === 0) {
    els.historyTableBody.innerHTML = `
      <tr>
        <td colspan="11" class="empty-table-cell">Belum ada riwayat pengujian.</td>
      </tr>
    `;
    return;
  }

  let html = '';
  for (const item of historyList) {
    const isFinished = item.status === 'FINISHED';
    const itemPda = item.pda || (item.archiveName?.match(/^ATM_([^\.]+)\.zip$/i)?.[1] || '');
    const itemModel = item.model || '';
    html += `
      <tr data-history-id="${item.id}">
        <td><span class="timestamp-text">${formatTimestamp(item.timestamp)}</span></td>
        <td><span class="pill-pc-id">${item.nodeId}</span></td>
        <td class="history-mode-cell"><div class="history-mode-chips">${formatModeChips(item.mode)}</div></td>
        <td><span class="pill-pc-id">${item.devices[0] || 'device'}</span></td>
        <td class="time-col">${formatDuration(item.runtimeSecs)}</td>
        <td><span class="count-pill-sm ${item.passed > 0 ? 'green' : 'gray'}">${item.passed}</span></td>
        <td><span class="count-pill-sm ${item.failed > 0 ? 'red' : 'gray'}">${item.failed}</span></td>
        <td><span class="count-pill-sm gray">${item.total}</span></td>
        <td><span class="status-pill ${isFinished ? 'finished' : 'cancelled'}">${item.status}</span></td>
        <td>
          ${
            isFinished
              ? `<a href="#" class="archive-pill-link" onclick="window.downloadFile('${item.archiveName}', 'all', '${item.devices[0] || 'device'}', '${item.nodeId}', '${itemPda}', '${itemModel}', '${item.mode}'); return false;">${item.archiveName}</a>`
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
      sendToHub({ type: 'HISTORY_DELETE', payload: { id } });
    });
  });
}

// Terminal Modal Controls & Filters
function updateModalControls() {
  const runningList = Object.values(workflows).filter((w) => w.run);
  if (els.modalNodeIdLabel) {
    const activeNode = runningList[0]?.nodeId || (selectedNodeFilter !== 'all' ? selectedNodeFilter : Object.keys(fleet.nodes)[0] || 'syncmaster');
    els.modalNodeIdLabel.textContent = activeNode;
  }

  if (els.modalRunStatusBadge) {
    if (runningList.length > 0) {
      els.modalRunStatusBadge.textContent = '[RUNNING]';
      els.modalRunStatusBadge.className = 'modal-status-badge running';
    } else {
      const last = historyList[0];
      if (last) {
        els.modalRunStatusBadge.textContent = `[${last.status}]`;
        els.modalRunStatusBadge.className = `modal-status-badge ${last.status.toLowerCase()}`;
      } else {
        els.modalRunStatusBadge.textContent = '[IDLE]';
        els.modalRunStatusBadge.className = 'modal-status-badge idle';
      }
    }
  }

  // 1. Devices: display devices currently queued/active in the workflows
  if (els.modalDeviceSelect) {
    const currentVal = selectedModalDevice;
    els.modalDeviceSelect.innerHTML = '<option value="all">Semua Perangkat Workflow</option>';
    
    const wfList = Object.values(workflows);
    const devList = wfList.length > 0
      ? wfList.map((d) => ({ serial: d.serial, model: d.model }))
      : getAllConnectedDevices().map((d) => ({ serial: d.device.serial, model: d.device.model }));

    for (const dev of devList) {
      const opt = document.createElement('option');
      opt.value = dev.serial;
      opt.textContent = `${dev.model || 'Device'} (${dev.serial})`;
      els.modalDeviceSelect.appendChild(opt);
    }

    if (Array.from(els.modalDeviceSelect.options).some((o) => o.value === currentVal)) {
      els.modalDeviceSelect.value = currentVal;
    } else {
      els.modalDeviceSelect.value = 'all';
      selectedModalDevice = 'all';
    }
  }

  // 2. Testcase Chips: display chips for testcases
  if (els.modalTestcaseChips) {
    let chipsHtml = `<button class="terminal-tc-chip ${selectedModalTc === 'all' ? 'active' : ''}" data-tc="all">ALL</button>`;
    for (const t of TOOL_DEFS) {
      const isActive = selectedModalTc === t.id;
      chipsHtml += `<button class="terminal-tc-chip ${isActive ? 'active' : ''}" data-tc="${t.id}">${t.id.toUpperCase()}</button>`;
    }

    els.modalTestcaseChips.innerHTML = chipsHtml;

    // Attach click events to dynamic testcase chips
    els.modalTestcaseChips.querySelectorAll('.terminal-tc-chip').forEach((chipBtn) => {
      chipBtn.addEventListener('click', (e) => {
        els.modalTestcaseChips.querySelectorAll('.terminal-tc-chip').forEach((c) => c.classList.remove('active'));
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
    els.standbyTableBody.querySelectorAll('.standby-dev-check:not(:disabled)').forEach((cb) => {
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
    const devices = Array.from(els.standbyTableBody.querySelectorAll('.standby-dev-check:checked')).map((cb) => {
      const d = (cb as HTMLInputElement).dataset;
      return { serial: d.serial, nodeId: d.node, model: d.model, pda: d.pda, android: d.android, buildType: d.type };
    });
    selectedStandbySerials.clear();
    scrollToWorkflowOnAdd = true;
    sendToHub({ type: 'WORKFLOW_ADD', payload: { devices } });
    renderStandbyDevices();
  });

  // Workflows Container Event Delegation (Clicks)
  els.workflowsContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // 1. Toggle Tools (Check/Uncheck All for device)
    const toggleToolsBtn = target.closest<HTMLButtonElement>('.btn-toggle-tools');
    if (toggleToolsBtn && toggleToolsBtn.dataset.serial) {
      const serial = toggleToolsBtn.dataset.serial;
      const wf = workflows[serial];
      if (wf && !wf.run) {
        const allChecked = TOOL_DEFS.every((t) => wf.tools.includes(t.id));
        const tools = allChecked ? [] : TOOL_DEFS.map((t) => t.id);
        // ponytail: immediate local feedback
        wf.tools = tools;
        renderWorkflows();
        sendToHub({ type: 'SET_TOOLS', payload: { serial, tools } });
      }
      return;
    }

    // 2. Start Device Run
    const startBtn = target.closest<HTMLButtonElement>('.btn-start-device');
    if (startBtn && startBtn.dataset.serial) {
      sendToHub({ type: 'START_RUN', payload: { serial: startBtn.dataset.serial } });
      return;
    }

    // 3. Cancel Device Run
    const cancelBtn = target.closest<HTMLButtonElement>('.btn-cancel-device');
    if (cancelBtn && cancelBtn.dataset.serial) {
      sendToHub({ type: 'CANCEL_RUN', payload: { serial: cancelBtn.dataset.serial } });
      return;
    }

    // 4. Remove Device from Workflow
    const removeBtn = target.closest<HTMLButtonElement>('.btn-remove-device');
    if (removeBtn && removeBtn.dataset.serial) {
      sendToHub({ type: 'WORKFLOW_REMOVE', payload: { serial: removeBtn.dataset.serial } });
      return;
    }

    // 5. Toggle Sub-Accordion (Test Suites)
    const subHeader = target.closest<HTMLElement>('.sub-accordion-header');
    if (subHeader && !target.closest('.sub-header-right')) {
      const box = subHeader.closest<HTMLElement>('.sub-accordion-box');
      if (box) box.classList.toggle('expanded');
      return;
    }

    // 6. Toggle Card Accordion
    const cardHeader = target.closest<HTMLElement>('.card-main-header[data-card-serial]');
    if (cardHeader && !target.closest('.card-header-right')) {
      const serial = cardHeader.dataset.cardSerial!;
      const card = cardHeader.closest<HTMLElement>('.dashboard-card');
      if (card) {
        if (card.classList.contains('expanded')) {
          card.classList.remove('expanded');
          collapsedCardSerials.add(serial);
        } else {
          card.classList.add('expanded');
          collapsedCardSerials.delete(serial);
        }
      }
      return;
    }
  });

  // Workflows Container Event Delegation (Tool Switches, Toggle All, Subtests)
  els.workflowsContainer.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (!target) return;

    // 1. Tool selection toggle
    if (target.classList.contains('tool-switch')) {
      const serial = target.dataset.serial;
      if (!serial) return;
      const card = target.closest<HTMLElement>('.dashboard-card');
      if (!card) return;
      const checkedTools = Array.from(card.querySelectorAll<HTMLInputElement>('.tool-switch:checked')).map(
        (sw) => sw.dataset.tool!
      );
      if (workflows[serial]) {
        workflows[serial].tools = checkedTools;
      }
      renderWorkflows();
      sendToHub({ type: 'SET_TOOLS', payload: { serial, tools: checkedTools } });
      return;
    }

    // 2. Toggle All Checkbox
    if (target.classList.contains('btn-toggle-tools-checkbox')) {
      const serial = target.dataset.serial;
      if (!serial) return;
      const wf = workflows[serial];
      if (wf && !wf.run) {
        const tools = target.checked ? TOOL_DEFS.map((t) => t.id) : [];
        wf.tools = tools;
        renderWorkflows();
        sendToHub({ type: 'SET_TOOLS', payload: { serial, tools } });
      }
      return;
    }

    // 3. CTS-V Subtest Checkbox
    if (target.classList.contains('ctsv-subtest-chk')) {
      const serial = target.dataset.serial;
      const subtest = target.dataset.subtest;
      if (!serial || !subtest) return;
      const wf = workflows[serial];
      if (wf && !wf.run) {
        if (!wf.ctsvSubtests) {
          wf.ctsvSubtests = { DeviceOwnerTestsNormal: true, BYODManagedProvisioningNormal: true };
        }
        (wf.ctsvSubtests as any)[subtest] = target.checked;
        renderWorkflows();
        sendToHub({ type: 'SET_CTSV_SUBTESTS', payload: { serial, subtests: wf.ctsvSubtests } });
      }
      return;
    }
  });

  // Clear History
  els.clearAllHistoryBtn.addEventListener('click', () => {
    if (confirm('Hapus seluruh riwayat pengujian?')) {
      sendToHub({ type: 'HISTORY_CLEAR', payload: {} });
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
    sendToHub({ type: 'LOGS_CLEAR', payload: {} });
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

  if (els.updateToolsBtn) {
    els.updateToolsBtn.addEventListener('click', () => {
      const nodes = Object.values(fleet.nodes);
      if (nodes.length === 0) {
        alert('Tidak ada PC Node yang terhubung.');
        return;
      }
      const btn = els.updateToolsBtn!;
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = `<span>Updating...</span>`;

      for (const n of nodes) {
        const block = document.createElement('div');
        block.className = 'diag-node-block';
        block.innerHTML = `<span style="color: var(--accent-blue); font-weight: 600;">[Update Tools] Requesting ATM tools update for node <strong>${n.nodeId}</strong>...</span>`;
        els.preflightReportsContainer.appendChild(block);
        sendToHub({ type: 'UPDATE_TOOLS', payload: { nodeId: n.nodeId } });
      }

      setTimeout(() => {
        if (els.updateToolsBtn) {
          els.updateToolsBtn.disabled = false;
          els.updateToolsBtn.innerHTML = originalHtml;
        }
      }, 4000);
    });
  }

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
