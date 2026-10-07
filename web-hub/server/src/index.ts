import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceInfo, FleetState, NodeState, RunBatchPayload } from './types.js';

const PORT = parseInt(process.env.PORT || '4020', 10);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://heist.endrisusanto.my.id';

function resolveClientDist(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../client/dist'),
    path.resolve(currentDir, '../client/dist'),
    path.resolve(process.cwd(), 'web-hub/client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
    '/app/web-hub/client/dist'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return path.resolve(process.cwd(), 'web-hub/client/dist');
}

const CLIENT_DIST = resolveClientDist();
const RESULTS_ROOT = process.env.RESULTS_DIR || path.join(process.cwd(), 'data');

// In-memory fleet state
const fleetState: FleetState = {
  nodes: {}
};

// Server-side active runs map (runId -> ActiveRun)
const activeRunsMap = new Map<string, import('./types.js').ActiveRun>();

// WebSocket connections
const bridgeConnections = new Map<string, WebSocket>(); // nodeId -> WebSocket
const uiConnections = new Set<WebSocket>();

function getFleetPayload(): FleetState {
  const busySerials = new Set<string>();
  for (const r of activeRunsMap.values()) {
    for (const d of r.devices) {
      busySerials.add(d);
    }
  }

  const nodesCopy: Record<string, NodeState> = {};
  for (const [nId, node] of Object.entries(fleetState.nodes)) {
    nodesCopy[nId] = {
      ...node,
      devices: (node.devices || []).map((dev) => ({
        ...dev,
        busy: busySerials.has(dev.serial)
      }))
    };
  }

  const activeRunsObj: Record<string, import('./types.js').ActiveRun> = {};
  for (const [rId, rInfo] of activeRunsMap.entries()) {
    activeRunsObj[rId] = rInfo;
  }

  return {
    nodes: nodesCopy,
    activeRuns: activeRunsObj,
    busyDevices: Array.from(busySerials)
  };
}

function broadcastFleetState() {
  broadcastToUI({ type: 'FLEET_STATE', payload: getFleetPayload() });
}

// Ring buffer for logs (run_id -> lines[])
const logBuffers = new Map<string, string[]>();
const MAX_LOG_LINES = 3000;

function appendLog(runId: string, line: string) {
  let buf = logBuffers.get(runId);
  if (!buf) {
    buf = [];
    logBuffers.set(runId, buf);
  }
  buf.push(line);
  if (buf.length > MAX_LOG_LINES) {
    buf.shift();
  }
}

function broadcastToUI(msg: object) {
  const data = JSON.stringify(msg);
  for (const client of uiConnections) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}


// ---- Unified server-side app state (shared by every UI session) ----
type ToolStatus = 'STANDBY' | 'RUNNING' | 'PASSED' | 'WARNING' | 'FAILED' | 'ERROR';
interface ToolRow {
  status: ToolStatus;
  subtext: string;
  duration?: string;
  durationSecs?: number;
  bvtSummary?: { total: number; passed: number; failed: number };
  failedSubtests?: Array<{ name: string; status: string; detail: string }>;
  serial?: string;
  nodeId?: string;
}
interface DeviceWorkflow {
  serial: string;
  nodeId: string;
  model: string;
  pda: string;
  buildType: string;
  tools: string[];
  toolStatus: Record<string, ToolRow>;
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
interface HistoryRecord {
  id: string; nodeId: string; mode: string; devices: string[]; pda?: string; model?: string; runtimeSecs: number;
  passed: number; failed: number; total: number; status: 'FINISHED' | 'CANCELLED';
  archiveName: string; timestamp: number;
}

const STATE_FILE = path.join(RESULTS_ROOT, 'state.json');
const app = {
  workflows: {} as Record<string, DeviceWorkflow>,
  history: [] as HistoryRecord[],
};
const logs: Array<{ line: string; level: string }> = [];

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  app.workflows = saved.workflows || {};
  app.history = saved.history || [];
  // Reset any stale RUNNING statuses upon server boot
  for (const wf of Object.values(app.workflows)) {
    if (wf.run) {
      wf.run = null;
    }
    for (const row of Object.values(wf.toolStatus || {})) {
      if (row.status === 'RUNNING') {
        row.status = 'STANDBY';
        row.subtext = 'Interrupted.';
      }
    }
  }
} catch {
  // first start, nothing persisted yet
}

function saveState() {
  try {
    fs.mkdirSync(RESULTS_ROOT, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ workflows: app.workflows, history: app.history }));
  } catch (err) {
    console.error('[State] save failed', err);
  }
}

function appSnapshot() {
  return {
    workflows: app.workflows,
    history: app.history,
    serverNow: Date.now()
  };
}

function broadcastApp(persist = true) {
  if (persist) saveState();
  broadcastToUI({ type: 'APP_STATE', payload: appSnapshot() });
}

function pushLog(line: string, level = 'normal') {
  logs.push({ line, level });
  if (logs.length > 2000) logs.shift();
  broadcastToUI({ type: 'LOG', payload: { line, level } });
}

function findWorkflowByRunId(runId: string): DeviceWorkflow | undefined {
  return Object.values(app.workflows).find((w) => w.run?.runId === runId);
}

function normalizeToolId(toolName: string): string | null {
  const t = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t.includes('getprop')) return 'getprop';
  if (t.includes('bvt') || t.includes('basicinfo')) return 'bvt';
  if (t.includes('svt') || t.includes('preload')) return 'svt';
  if (t.includes('sdt') || t.includes('devicetest')) return 'sdt';
  if (t.includes('cts') || t.includes('verifier')) return 'ctsv';
  return null;
}

function formatDurationSecs(secs: number): string {
  if (isNaN(secs) || secs < 0) return '00:00:00';
  const h = Math.floor(secs / 3600).toString().padStart(2, '0');
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function setDeviceToolStatus(wf: DeviceWorkflow, tool: string, status: ToolStatus, subtext: string) {
  if (!wf.tools.includes(tool)) return;
  wf.toolStatus[tool] = {
    ...wf.toolStatus[tool],
    status,
    subtext,
    serial: wf.serial,
    nodeId: wf.nodeId
  };
  broadcastApp(false);
}

function parseProgress(wf: DeviceWorkflow, line: string) {
  // 1. Tool START event
  const startMatch = line.match(/\[([^\]]+)\]\s+START\s+([^:]+):/i);
  if (startMatch) {
    const toolId = normalizeToolId(startMatch[2]);
    if (toolId && wf.tools.includes(toolId)) {
      wf.toolStatus[toolId] = {
        ...wf.toolStatus[toolId],
        status: 'RUNNING',
        subtext: 'Sedang menjalankan pengujian...',
        duration: wf.toolStatus[toolId]?.duration || '-',
        serial: wf.serial,
        nodeId: wf.nodeId
      };
      broadcastApp(false);
      return;
    }
  }

  // 2. BVT Summary event
  const bvtSummaryMatch = line.match(/\[([^\]]+)\]\s+BVT_SUMMARY\t(\d+)\t(\d+)\t(\d+)/);
  if (bvtSummaryMatch) {
    const total = parseInt(bvtSummaryMatch[2], 10);
    const passed = parseInt(bvtSummaryMatch[3], 10);
    const failed = parseInt(bvtSummaryMatch[4], 10);
    if (!wf.toolStatus['bvt']) wf.toolStatus['bvt'] = { status: 'RUNNING', subtext: '', serial: wf.serial, nodeId: wf.nodeId };
    wf.toolStatus['bvt'].bvtSummary = { total, passed, failed };
    broadcastApp(false);
    return;
  }

  // 3. BVT Subtest failure event
  const bvtSubtestMatch = line.match(/\[([^\]]+)\]\s+BVT_SUBTEST\t([^\t]+)\t([^\t]+)\t?(.*)/);
  if (bvtSubtestMatch) {
    const status = bvtSubtestMatch[2].trim();
    const name = bvtSubtestMatch[3].trim();
    const detail = bvtSubtestMatch[4] ? bvtSubtestMatch[4].trim() : '';
    if (!wf.toolStatus['bvt']) wf.toolStatus['bvt'] = { status: 'RUNNING', subtext: '', serial: wf.serial, nodeId: wf.nodeId };
    if (!wf.toolStatus['bvt'].failedSubtests) wf.toolStatus['bvt'].failedSubtests = [];
    if (!wf.toolStatus['bvt'].failedSubtests.some((f) => f.name === name)) {
      wf.toolStatus['bvt'].failedSubtests.push({ name, status, detail });
    }
    broadcastApp(false);
    return;
  }

  // 4. Tool END event
  const endMatch = line.match(/\[([^\]]+)\]\s+END\s+([^\s]+)\s+exit=(-?\d+)\s+duration=(\d+)s\s+result=([A-Z_]+)(?:\s+(.*))?/i);
  if (endMatch) {
    const toolId = normalizeToolId(endMatch[2]);
    if (toolId && wf.tools.includes(toolId)) {
      const exitCode = parseInt(endMatch[3], 10);
      const durSecs = parseInt(endMatch[4], 10);
      const rawResult = endMatch[5].toUpperCase();
      const detail = endMatch[6] ? endMatch[6].trim() : '';

      let status: ToolStatus = 'PASSED';
      if (rawResult === 'PASS') status = 'PASSED';
      else if (rawResult === 'WARNING') status = 'WARNING';
      else if (rawResult === 'ERROR' || rawResult === 'FAILED' || exitCode !== 0) status = 'ERROR';
      else if (rawResult === 'CANCELLED') status = 'STANDBY';

      const durationStr = formatDurationSecs(durSecs);
      let subtext = detail;
      if (!subtext) {
        if (status === 'PASSED') subtext = 'Pengujian sukses.';
        else if (status === 'WARNING') subtext = 'Pengujian selesai dengan peringatan.';
        else if (status === 'ERROR') subtext = 'Error (Periksa Log)';
        else subtext = 'Standby.';
      }

      wf.toolStatus[toolId] = {
        ...wf.toolStatus[toolId],
        status,
        subtext,
        duration: durationStr,
        durationSecs: durSecs,
        serial: wf.serial,
        nodeId: wf.nodeId
      };
      broadcastApp(false);
      return;
    }
  }
}

function finishDeviceRun(serial: string, status: 'FINISHED' | 'CANCELLED') {
  const wf = app.workflows[serial];
  if (!wf || !wf.run) return;
  const runInfo = wf.run;
  wf.run = null;

  activeRunsMap.delete(`${runInfo.runId}:${wf.nodeId}`);
  if (fleetState.nodes[wf.nodeId]) {
    fleetState.nodes[wf.nodeId].activeRuns = fleetState.nodes[wf.nodeId].activeRuns.filter(
      (id) => id !== runInfo.runId
    );
  }

  let pda = wf.pda || serial;
  let devModel = wf.model || '';
  for (const node of Object.values(fleetState.nodes)) {
    const dev = (node.devices || []).find((d) => d.serial === serial);
    if (dev) {
      const v = [dev.build, dev.csc].find((x) => x && x !== '-' && x !== 'UNKNOWN' && x.trim());
      if (v) { pda = v.trim(); }
      if (!devModel && dev.model && dev.model !== '-' && dev.model !== 'UNKNOWN') {
        devModel = dev.model.trim();
      }
    }
  }

  const total = wf.tools.length;
  let passedCount = 0;
  let failedCount = 0;
  for (const t of wf.tools) {
    const st = wf.toolStatus[t]?.status;
    if (st === 'PASSED' || st === 'WARNING') passedCount++;
    else if (st === 'ERROR' || st === 'FAILED') failedCount++;
    if (status === 'CANCELLED' && st === 'RUNNING') {
      wf.toolStatus[t].status = 'STANDBY';
      wf.toolStatus[t].subtext = 'Dibatalkan.';
    }
  }

  app.history.unshift({
    id: runInfo.runId,
    nodeId: wf.nodeId,
    mode: wf.tools.map((t) => t.toUpperCase()).join(', '),
    devices: [serial],
    pda,
    model: devModel,
    runtimeSecs: Math.floor((Date.now() - runInfo.startedAt) / 1000),
    passed: passedCount,
    failed: failedCount,
    total,
    status,
    archiveName: `ATM_${pda}.zip`,
    timestamp: Date.now()
  });
  app.history = app.history.slice(0, 200);

  pushLog(`[Hub] Run ${runInfo.runId} on ${serial} ${status}`, status === 'FINISHED' ? 'success' : 'warn');
  broadcastApp();
  broadcastFleetState();
}

function startDeviceRun(serial: string, ui: WebSocket) {
  const fail = (message: string) =>
    ui.send(JSON.stringify({ type: 'ACTION_RESPONSE', payload: { nodeId: 'hub', action: 'trigger_run', success: false, message } }));
  const wf = app.workflows[serial];
  if (!wf) return fail(`Perangkat ${serial} tidak ada di workflow.`);
  if (wf.run) return fail(`Perangkat ${serial} sudah menjalankan pengujian.`);
  if (wf.tools.length === 0) return fail(`Pilih minimal 1 testcase untuk ${wf.model || serial}.`);

  const busy = new Set(getFleetPayload().busyDevices);
  if (busy.has(wf.serial)) return fail(`Perangkat ${wf.serial} sedang menjalankan pengujian.`);

  const targetWs = bridgeConnections.get(wf.nodeId);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) return fail(`Node ${wf.nodeId} offline atau tidak terhubung.`);

  const runId = `run-${wf.serial}-${Date.now()}`;
  wf.run = {
    runId,
    startedAt: Date.now(),
    failed: false
  };
  for (const t of wf.tools) {
    wf.toolStatus[t] = {
      status: 'STANDBY',
      subtext: 'Menunggu giliran pengujian...',
      duration: '-',
      durationSecs: 0,
      bvtSummary: undefined,
      failedSubtests: [],
      serial: wf.serial,
      nodeId: wf.nodeId
    };
  }
  pushLog(`[Hub] Starting Automation Suite ${runId} on ${wf.model} (${wf.serial})...`, 'sys');

  activeRunsMap.set(`${runId}:${wf.nodeId}`, {
    runId,
    nodeId: wf.nodeId,
    devices: [wf.serial],
    tools: [...wf.tools],
    startedAt: wf.run.startedAt
  });

  const selectedCtsvSubtests: string[] = [];
  const ctsvSub = wf.ctsvSubtests || { DeviceOwnerTestsNormal: true, BYODManagedProvisioningNormal: true };
  if (ctsvSub.DeviceOwnerTestsNormal) selectedCtsvSubtests.push('DeviceOwnerTestsNormal');
  if (ctsvSub.BYODManagedProvisioningNormal) selectedCtsvSubtests.push('BYODManagedProvisioningNormal');

  targetWs.send(JSON.stringify({
    type: 'TriggerRun',
    payload: {
      run_id: runId,
      devices: [wf.serial],
      tools: wf.tools,
      ctsv_subtests: selectedCtsvSubtests,
      concurrency: 1,
      update: false
    }
  }));

  const node = fleetState.nodes[wf.nodeId];
  if (node && !node.activeRuns.includes(runId)) {
    node.activeRuns.push(runId);
  }

  broadcastApp();
  broadcastFleetState();
}

function cancelDeviceRun(serial: string) {
  const wf = app.workflows[serial];
  if (!wf || !wf.run) return;
  const runId = wf.run.runId;
  pushLog(`[Hub] Cancelling active automation suite ${runId} on ${serial}...`, 'warn');

  activeRunsMap.delete(`${runId}:${wf.nodeId}`);
  const node = fleetState.nodes[wf.nodeId];
  if (node) node.activeRuns = node.activeRuns.filter((id) => id !== runId);

  const targetWs = bridgeConnections.get(wf.nodeId);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({ type: 'CancelRun', payload: { run_id: runId } }));
  }
  finishDeviceRun(serial, 'CANCELLED');
}

function handleAppIntent(type: string, payload: any, ui: WebSocket): boolean {
  const str = (v: unknown) => String(v ?? '');
  switch (type) {
    case 'START_RUN': {
      if (payload.serial) {
        startDeviceRun(payload.serial, ui);
      } else {
        for (const wf of Object.values(app.workflows)) {
          if (!wf.run && wf.tools.length > 0) startDeviceRun(wf.serial, ui);
        }
      }
      return true;
    }
    case 'CANCEL_RUN': {
      if (payload.serial) {
        cancelDeviceRun(payload.serial);
      } else {
        for (const wf of Object.values(app.workflows)) {
          if (wf.run) cancelDeviceRun(wf.serial);
        }
      }
      return true;
    }
    case 'LOGS_CLEAR':
      logs.length = 0;
      broadcastToUI({ type: 'LOGS_SNAPSHOT', payload: { logs } });
      return true;
    case 'HISTORY_DELETE':
      app.history = app.history.filter((h) => h.id !== payload.id);
      broadcastApp();
      return true;
    case 'HISTORY_CLEAR':
      app.history = [];
      broadcastApp();
      return true;
    case 'WORKFLOW_ADD': {
      const busy = new Set(getFleetPayload().busyDevices);
      for (const d of payload.devices || []) {
        const s = str(d.serial);
        if (busy.has(s) || app.workflows[s]) continue;
        app.workflows[s] = {
          serial: s,
          nodeId: str(d.nodeId),
          model: str(d.model),
          pda: str(d.pda),
          buildType: str(d.buildType),
          tools: ['ctsv', 'getprop', 'bvt', 'svt', 'sdt'],
          toolStatus: {},
          ctsvSubtests: { DeviceOwnerTestsNormal: true, BYODManagedProvisioningNormal: true },
          run: null
        };
      }
      broadcastApp();
      return true;
    }
    case 'WORKFLOW_REMOVE': {
      const s = str(payload.serial);
      const wf = app.workflows[s];
      if (wf && !wf.run) {
        delete app.workflows[s];
        broadcastApp();
      }
      return true;
    }
    case 'WORKFLOW_CLEAR': {
      for (const [s, wf] of Object.entries(app.workflows)) {
        if (!wf.run) delete app.workflows[s];
      }
      broadcastApp();
      return true;
    }
    case 'SET_TOOLS': {
      const s = str(payload.serial);
      const wf = app.workflows[s];
      if (wf && !wf.run) {
        wf.tools = (payload.tools || []).filter((t: string) => ['getprop', 'bvt', 'svt', 'sdt', 'ctsv'].includes(t));
        broadcastApp();
      }
      return true;
    }
    case 'SET_CTSV_SUBTESTS': {
      const s = str(payload.serial);
      const wf = app.workflows[s];
      if (wf && !wf.run) {
        wf.ctsvSubtests = {
          DeviceOwnerTestsNormal: Boolean(payload.subtests?.DeviceOwnerTestsNormal),
          BYODManagedProvisioningNormal: Boolean(payload.subtests?.BYODManagedProvisioningNormal)
        };
        broadcastApp();
      }
      return true;
    }
  }
  return false;
}

// Zero-dependency standard ZIP generator
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function createZipBuffer(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const fileEntries: Array<{ name: Buffer; data: Buffer; crc: number; offset: number }> = [];
  const buffers: Buffer[] = [];
  let currentOffset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const dataBuf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8');
    const crc = crc32(dataBuf);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(dataBuf.length, 18);
    header.writeUInt32LE(dataBuf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    buffers.push(header, nameBuf, dataBuf);
    fileEntries.push({ name: nameBuf, data: dataBuf, crc, offset: currentOffset });
    currentOffset += 30 + nameBuf.length + dataBuf.length;
  }

  const centralDirStart = currentOffset;
  let centralDirSize = 0;

  for (const entry of fileEntries) {
    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4);
    cdir.writeUInt16LE(20, 6);
    cdir.writeUInt16LE(0, 8);
    cdir.writeUInt16LE(0, 10);
    cdir.writeUInt16LE(0, 12);
    cdir.writeUInt32LE(entry.crc, 16);
    cdir.writeUInt32LE(entry.data.length, 20);
    cdir.writeUInt32LE(entry.data.length, 24);
    cdir.writeUInt16LE(entry.name.length, 28);
    cdir.writeUInt16LE(0, 30);
    cdir.writeUInt16LE(0, 32);
    cdir.writeUInt16LE(0, 34);
    cdir.writeUInt16LE(0, 36);
    cdir.writeUInt32LE(0, 38);
    cdir.writeUInt32LE(entry.offset, 42);

    buffers.push(cdir, entry.name);
    centralDirSize += 46 + entry.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileEntries.length, 8);
  eocd.writeUInt16LE(fileEntries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);
  buffers.push(eocd);

  return Buffer.concat(buffers);
}

// HTTP Server with static file serving
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', nodes: Object.keys(fleetState.nodes).length, timestamp: Date.now() }));
    return;
  }

  if (req.url === '/api/fleet') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fleetState));
    return;
  }

  // Helper functions for Results generation and packaging
  function findLocalResultFolder(model: string, pda: string, toolFolder: string): string | null {
    const candidateRoots = [RESULTS_ROOT];
    const norm = (s: string) => String(s || '').replace(/[-_]/g, '').toLowerCase().trim();
    const targetPdaNorm = norm(pda);
    const targetModelNorm = model ? norm(model) : '';

    for (const root of candidateRoots) {
      const resultsDir = path.join(root, 'results');
      if (!fs.existsSync(resultsDir) || !fs.statSync(resultsDir).isDirectory()) continue;

      // 1. Direct path check if model and pda are provided
      if (model && pda) {
        const direct1 = path.join(resultsDir, model, pda, toolFolder);
        if (fs.existsSync(direct1) && fs.statSync(direct1).isDirectory()) return direct1;
      }

      // 2. Scan all model directories inside results/
      let modelDirs: string[] = [];
      try {
        modelDirs = fs.readdirSync(resultsDir);
      } catch {
        continue;
      }

      for (const mEntry of modelDirs) {
        const mPath = path.join(resultsDir, mEntry);
        try {
          if (!fs.statSync(mPath).isDirectory()) continue;
        } catch {
          continue;
        }

        const mEntryNorm = norm(mEntry);
        const modelMatches = !targetModelNorm || mEntryNorm === targetModelNorm || mEntryNorm.includes(targetModelNorm) || targetModelNorm.includes(mEntryNorm);

        // Scan PDA subdirectories inside model directory
        let pdaDirs: string[] = [];
        try {
          pdaDirs = fs.readdirSync(mPath);
        } catch {
          continue;
        }

        for (const pEntry of pdaDirs) {
          const pPath = path.join(mPath, pEntry);
          try {
            if (!fs.statSync(pPath).isDirectory()) continue;
          } catch {
            continue;
          }

          const pEntryNorm = norm(pEntry);
          const pdaMatches = !targetPdaNorm || pEntryNorm === targetPdaNorm || pEntryNorm.startsWith(targetPdaNorm) || targetPdaNorm.startsWith(pEntryNorm);

          if (pdaMatches) {
            // Check toolFolder inside pPath
            let toolDirs: string[] = [];
            try {
              toolDirs = fs.readdirSync(pPath);
            } catch {
              continue;
            }

            for (const tEntry of toolDirs) {
              const tPath = path.join(pPath, tEntry);
              try {
                if (fs.statSync(tPath).isDirectory() && tEntry.toLowerCase() === toolFolder.toLowerCase()) {
                  return tPath;
                }
              } catch {
                continue;
              }
            }
          }
        }
      }
    }
    return null;
  }

  function readDirectoryFiles(dir: string, baseDir: string = dir): Array<{ name: string; content: Buffer }> {
    let results: Array<{ name: string; content: Buffer }> = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          results = results.concat(readDirectoryFiles(fullPath, baseDir));
        } else if (entry.isFile()) {
          results.push({ name: relPath, content: fs.readFileSync(fullPath) });
        }
      }
    } catch {
      // ignore read errors
    }
    return results;
  }


  function getTestcaseZipBuffer(toolName: string, pda: string, model: string): Buffer | null {
    const tLower = toolName.toLowerCase();
    let candidateFolders = ['Getprop'];
    if (tLower.includes('bvt')) candidateFolders = ['BVT'];
    else if (tLower.includes('svt')) candidateFolders = ['SVT'];
    else if (tLower.includes('sdt')) candidateFolders = ['SDT'];
    else if (tLower.includes('cts') || tLower.includes('ctsv')) candidateFolders = ['CTSVerifier', 'CTSV', 'CTS-V'];
    else if (tLower.includes('getprop')) candidateFolders = ['Getprop'];

    // 1. Try reading real folder from disk if available
    for (const folderName of candidateFolders) {
      const localDir = findLocalResultFolder(model, pda, folderName);
      if (localDir) {
        const localFiles = readDirectoryFiles(localDir);
        if (localFiles.length > 0) {
          return createZipBuffer(localFiles);
        }
      }
    }

    return null;
  }

  const TOOL_KEYS: Array<[string, (t: string) => boolean]> = [
    ['Getprop', (t) => t.includes('getprop')],
    ['BVT', (t) => t.includes('bvt') || t.includes('basic')],
    ['SVT', (t) => t.includes('svt') || t.includes('preload')],
    ['SDT', (t) => t.includes('sdt')],
    ['CTSVerifier', (t) => t.includes('ctsv') || t.includes('cts')]
  ];

  function getMasterArchiveZipBuffer(pda: string, model: string, activeTools: string[]): Buffer | null {
    const toolsLower = activeTools.map((t) => t.toLowerCase().trim()).filter(Boolean);
    const includeAll = toolsLower.length === 0 || toolsLower.includes('all');
    const files: Array<{ name: string; content: Buffer }> = [];

    for (const [folder, match] of TOOL_KEYS) {
      if (!includeAll && !toolsLower.some(match)) continue;
      const zip = getTestcaseZipBuffer(folder, pda, model);
      if (zip) files.push({ name: `${folder}_${pda}.zip`, content: zip });
    }
    return files.length ? createZipBuffer(files) : null;
  }

  // File download endpoint
  if (req.url?.startsWith('/api/download')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const requestedFile = urlObj.searchParams.get('file') || 'ATM_results.zip';
    const tool = (urlObj.searchParams.get('tool') || '').toLowerCase();
    const rawTools = urlObj.searchParams.get('tools') || urlObj.searchParams.get('mode') || '';
    const serial = urlObj.searchParams.get('serial') || 'device';
    const nodeId = urlObj.searchParams.get('nodeId') || 'syncmaster';
    let pda = urlObj.searchParams.get('pda') || '';
    let model = urlObj.searchParams.get('model') || '';

    // Auto-resolve PDA and Model from fleetState if not explicitly provided
    if (!pda || pda === 'device' || pda === '-' || pda === 'UNKNOWN') {
      for (const node of Object.values(fleetState.nodes)) {
        const found = node.devices.find((d) => d.serial === serial);
        if (found) {
          if (found.build && found.build !== '-' && found.build !== 'UNKNOWN') {
            pda = found.build.trim();
          }
          if ((!model || model === 'UNKNOWN') && found.model && found.model !== '-' && found.model !== 'UNKNOWN') {
            model = found.model.trim();
          }
        }
      }
    }

    // Try extracting PDA from requested filename (e.g. Getprop_A055FXXSIDZI3.zip or ATM_A055FXXSIDZI3.zip or CTSV_A055FXXSIDZI3.zip)
    if (!pda || pda === 'device' || pda === '-') {
      const match = requestedFile.match(/^(?:ATM|Getprop|BVT|SVT|SDT|CTSV|CTSVerifier)_([^.]+)\.zip$/i);
      if (match && match[1]) pda = match[1];
    }

    const safeName = path.basename(requestedFile);

    // 1. Check if user requests Master RESULT ARCHIVE (ATM_{PDA}.zip)
    if (tool === 'all' || safeName.startsWith('ATM_') || safeName.includes('ATM')) {
      const outName = `ATM_${pda}.zip`;
      const activeTools = rawTools ? rawTools.split(/[,+]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
      const masterZip = getMasterArchiveZipBuffer(pda, model, activeTools);
      if (!masterZip) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Result belum tersedia untuk perangkat/PDA ini.');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${outName}"`,
        'Content-Length': masterZip.length
      });
      res.end(masterZip);
      return;
    }

    // 2. Individual Testcase Zip Download (Getprop_{PDA}.zip, BVT_{PDA}.zip, SVT_{PDA}.zip, SDT_{PDA}.zip, CTSV_{PDA}.zip)
    let tcName = 'Getprop';
    if (tool.includes('bvt') || safeName.toLowerCase().startsWith('bvt')) tcName = 'BVT';
    else if (tool.includes('svt') || safeName.toLowerCase().startsWith('svt')) tcName = 'SVT';
    else if (tool.includes('sdt') || safeName.toLowerCase().startsWith('sdt')) tcName = 'SDT';
    else if (tool.includes('cts') || safeName.toLowerCase().startsWith('cts')) tcName = 'CTSV';
    else if (tool.includes('getprop') || safeName.toLowerCase().startsWith('getprop')) tcName = 'Getprop';

    const outTcName = `${tcName}_${pda}.zip`;
    const tcZip = getTestcaseZipBuffer(tcName, pda, model);
    if (!tcZip) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Result belum tersedia untuk perangkat/PDA ini.');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${outTcName}"`,
      'Content-Length': tcZip.length
    });
    res.end(tcZip);
    return;
  }

  // Static file serving
  let reqPath = req.url?.split('?')[0] || '/';
  if (reqPath === '/') reqPath = '/index.html';

  let filePath = path.join(CLIENT_DIST, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(CLIENT_DIST, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Heist Hub</title><style>body{background:#0e1117;color:#f0f6fc;font-family:sans-serif;padding:40px;text-align:center;}h1{color:#D2232A;}</style></head><body><h1>Heist Web Hub</h1><p>Client build not found yet. Run <code>npm run build:client</code></p><p>Port: ${PORT} | Active Nodes: ${Object.keys(fleetState.nodes).length}</p></body></html>`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  };

  const contentType = mimeMap[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

// WebSocket Server
const wssBridge = new WebSocketServer({ noServer: true });
const wssUI = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

  if (pathname === '/ws/bridge') {
    // Check bridge token if configured
    if (BRIDGE_TOKEN) {
      const authHeader = request.headers['x-bridge-token'] || '';
      if (authHeader !== BRIDGE_TOKEN) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wssBridge.handleUpgrade(request, socket, head, (ws) => {
      wssBridge.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/ui') {
    // Check Origin for UI if in production
    const origin = request.headers['origin'] || '';
    if (process.env.NODE_ENV === 'production' && PUBLIC_ORIGIN) {
      if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1') && origin !== PUBLIC_ORIGIN) {
        console.warn(`[UI WS] Rejected origin: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wssUI.handleUpgrade(request, socket, head, (ws) => {
      wssUI.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Bridge WebSocket Handlers
wssBridge.on('connection', (ws, req) => {
  let boundNodeId = (req.headers['x-node-id'] as string) || '';
  console.log(`[Bridge] Connected from ${req.socket.remoteAddress} (initial nodeId: ${boundNodeId})`);

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      const { type, payload } = msg;

      switch (type) {
        case 'RegisterNode': {
          boundNodeId = payload.node_id || boundNodeId;
          bridgeConnections.set(boundNodeId, ws);
          fleetState.nodes[boundNodeId] = {
            nodeId: boundNodeId,
            os: payload.os || 'unknown',
            version: payload.version || '0.1.0',
            atmRoot: payload.atm_root || '',
            lastSeen: Date.now(),
            devices: fleetState.nodes[boundNodeId]?.devices || [],
            activeRuns: fleetState.nodes[boundNodeId]?.activeRuns || []
          };
          console.log(`[Bridge Registered] Node: ${boundNodeId} (${payload.os})`);
          broadcastFleetState();
          break;
        }

        case 'DeviceListUpdate': {
          if (boundNodeId && fleetState.nodes[boundNodeId]) {
            fleetState.nodes[boundNodeId].devices = payload.devices || [];
            fleetState.nodes[boundNodeId].lastSeen = Date.now();
            broadcastFleetState();
          }
          break;
        }

        case 'LogStream': {
          appendLog(payload.run_id, payload.line);
          pushLog(`[${boundNodeId}][${payload.run_id}] ${payload.line}`);
          const wf = findWorkflowByRunId(payload.run_id);
          if (wf) parseProgress(wf, payload.line);
          break;
        }

        case 'RunResults': {
          for (const set of payload.sets || []) {
            const safe = (v: string) => String(v).replace(/[\\/]|\.\./g, '_');
            const dir = path.join(RESULTS_ROOT, 'results', safe(set.model), safe(set.pda), safe(set.tool));
            fs.rmSync(dir, { recursive: true, force: true });
            for (const f of set.files) {
              const target = path.join(dir, path.normalize(f.path).replace(/^(\.\.[\\/])+/, ''));
              if (!target.startsWith(dir)) continue;
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, Buffer.from(f.b64, 'base64'));
            }
          }
          break;
        }

        case 'RunFinished': {
          if (boundNodeId && fleetState.nodes[boundNodeId]) {
            fleetState.nodes[boundNodeId].activeRuns = fleetState.nodes[boundNodeId].activeRuns.filter(
              (id) => id !== payload.run_id
            );
          }
          const ok = payload.exit_code === 0;
          pushLog(`[${boundNodeId}] Run ${payload.run_id} finished with exit code ${payload.exit_code}`, ok ? 'success' : 'err');
          const wf = findWorkflowByRunId(payload.run_id);
          if (wf) {
            finishDeviceRun(wf.serial, ok ? 'FINISHED' : 'CANCELLED');
          } else {
            activeRunsMap.delete(`${payload.run_id}:${boundNodeId}`);
            broadcastFleetState();
          }
          break;
        }

        case 'PreflightReport': {
          broadcastToUI({
            type: 'PREFLIGHT_REPORT',
            payload: {
              nodeId: boundNodeId,
              report: payload.report
            }
          });
          break;
        }

        case 'Heartbeat': {
          if (boundNodeId && fleetState.nodes[boundNodeId]) {
            fleetState.nodes[boundNodeId].lastSeen = Date.now();
          }
          break;
        }

        case 'ActionResult':
        case 'ActionResponse': {
          pushLog(`[${boundNodeId}] Action ${payload.action}: ${payload.message}`, payload.success ? 'success' : 'err');
          broadcastToUI({
            type: 'ACTION_RESPONSE',
            payload: {
              nodeId: boundNodeId,
              ...payload
            }
          });
          break;
        }
      }
    } catch (err) {
      console.error('[Bridge Msg Parse Error]', err);
    }
  });

  ws.on('close', () => {
    console.log(`[Bridge Disconnected] Node: ${boundNodeId}`);
    if (boundNodeId) {
      bridgeConnections.delete(boundNodeId);
      for (const wf of Object.values(app.workflows)) {
        if (wf.nodeId === boundNodeId && wf.run) {
          finishDeviceRun(wf.serial, 'CANCELLED');
        }
      }
      setTimeout(() => {
        if (!bridgeConnections.has(boundNodeId)) {
          delete fleetState.nodes[boundNodeId];
          broadcastFleetState();
        }
      }, 5000);
      broadcastFleetState();
    }
  });
});

// UI WebSocket Handlers
wssUI.on('connection', (ws) => {
  uiConnections.add(ws);
  console.log(`[UI Client Connected] Total UI clients: ${uiConnections.size}`);

  // Send initial fleet state
  ws.send(JSON.stringify({ type: 'FLEET_STATE', payload: getFleetPayload() }));
  ws.send(JSON.stringify({ type: 'APP_STATE', payload: appSnapshot() }));
  ws.send(JSON.stringify({ type: 'LOGS_SNAPSHOT', payload: { logs } }));

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      const { type, payload } = msg;
      if (handleAppIntent(type, payload || {}, ws)) return;

      switch (type) {
        case 'PREFLIGHT': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'RequestPreflight',
                payload: { atm_root: payload.atmRoot }
              })
            );
          }
          break;
        }

        case 'UPDATE_TOOLS': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'UpdateTools',
                payload: { atm_root: payload.atmRoot }
              })
            );
          }
          break;
        }

        case 'UPDATE_BRIDGE': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'UpdateBridge',
                payload: { download_url: payload.downloadUrl }
              })
            );
          }
          break;
        }

        case 'SET_LAMP': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'SetLamp',
                payload: { serial: payload.serial, state: payload.state }
              })
            );
          }
          break;
        }

        case 'PRESS_HOME': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'PressHome',
                payload: { serial: payload.serial }
              })
            );
          }
          break;
        }

        case 'CLEAR_RESULTS': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'ClearResults',
                payload: { serial: payload.serial }
              })
            );
          }
          break;
        }

        case 'GET_LOGS': {
          const buf = logBuffers.get(payload.runId) || [];
          ws.send(
            JSON.stringify({
              type: 'LOG_BUFFER',
              payload: { runId: payload.runId, lines: buf }
            })
          );
          break;
        }
      }
    } catch (err) {
      console.error('[UI Msg Parse Error]', err);
    }
  });

  ws.on('close', () => {
    uiConnections.delete(ws);
    console.log(`[UI Client Disconnected] Remaining UI clients: ${uiConnections.size}`);
  });
});

// Ping bridges every 25 seconds to keep reverse proxy tunnels alive
setInterval(() => {
  for (const [nodeId, ws] of bridgeConnections.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`  HEIST WEB HUB RUNNING ON PORT ${PORT}`);
  console.log(`  Bridge WS:  ws://0.0.0.0:${PORT}/ws/bridge`);
  console.log(`  UI WS:      ws://0.0.0.0:${PORT}/ws/ui`);
  console.log(`  Public URL: ${PUBLIC_ORIGIN}`);
  console.log(`=========================================`);
});
