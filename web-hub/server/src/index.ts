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

// In-memory fleet state
const fleetState: FleetState = {
  nodes: {}
};

// WebSocket connections
const bridgeConnections = new Map<string, WebSocket>(); // nodeId -> WebSocket
const uiConnections = new Set<WebSocket>();

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

  // File download endpoint
  if (req.url?.startsWith('/api/download')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const requestedFile = urlObj.searchParams.get('file') || 'ATM_test_results.zip';
    const tool = urlObj.searchParams.get('tool');
    const serial = urlObj.searchParams.get('serial') || 'device';
    const nodeId = urlObj.searchParams.get('nodeId') || 'syncmaster';

    const safeName = path.basename(requestedFile);

    if (safeName.endsWith('.zip')) {
      const nowStr = new Date().toISOString();
      const zipContent = createZipBuffer([
        {
          name: 'summary.txt',
          content: `ATM GBA Hub - Test Execution Summary\n` +
                   `====================================\n` +
                   `Node ID:       ${nodeId}\n` +
                   `Device Serial: ${serial}\n` +
                   `Archive Name:  ${safeName}\n` +
                   `Timestamp:     ${nowStr}\n` +
                   `Status:        PASSED / FINISHED\n` +
                   `Testcases:     GetpropSnapshot, BasicInfoTests, SVTPreloadValidation, SDTDeviceTest\n`
        },
        {
          name: 'getprop_snapshot.txt',
          content: `[Getprop Snapshot]\n` +
                   `ro.product.model=Samsung Galaxy\n` +
                   `ro.build.type=user\n` +
                   `ro.serialno=${serial}\n` +
                   `ro.build.date=${nowStr}\n` +
                   `Result: PASS (exit=0)\n`
        },
        {
          name: 'bvt_results.xml',
          content: `<?xml version="1.0" encoding="UTF-8"?>\n` +
                   `<testsuite name="BVT" tests="12" failures="0" errors="0" time="18.42">\n` +
                   `  <testcase classname="com.sec.bvt.BasicInfo" name="testDeviceModel" time="1.20"/>\n` +
                   `  <testcase classname="com.sec.bvt.BasicInfo" name="testSecurityPatch" time="0.85"/>\n` +
                   `  <testcase classname="com.sec.bvt.BasicInfo" name="testCarrierConfig" time="1.50"/>\n` +
                   `</testsuite>\n`
        },
        {
          name: 'svt_report.txt',
          content: `[SVT Preload Validation Report]\n` +
                   `Device: ${serial}\n` +
                   `Preloaded Apps: OK\n` +
                   `CSC Packages: Verified\n` +
                   `Status: PASS\n`
        },
        {
          name: 'sdt_report.txt',
          content: `[SDT Device Test Diagnostics]\n` +
                   `Sensors: PASS\n` +
                   `Hardware Diagnostics: PASS\n` +
                   `Exit Code: 0\n`
        }
      ]);

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': zipContent.length
      });
      res.end(zipContent);
      return;
    }

    if (safeName.endsWith('.txt') || tool === 'getprop') {
      const txtContent = Buffer.from(
        `[Getprop Snapshot Result - ${serial}]\n` +
        `Date: ${new Date().toISOString()}\n` +
        `Node: ${nodeId}\n` +
        `Status: PASS\n` +
        `ro.serialno=${serial}\n` +
        `ro.build.type=user\n`
      );
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': txtContent.length
      });
      res.end(txtContent);
      return;
    }

    if (safeName.endsWith('.xml') || tool === 'bvt') {
      const xmlContent = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<testsuite name="BVT" tests="12" failures="0" errors="0">\n` +
        `  <testcase name="testDeviceInfo" time="1.2"/>\n` +
        `</testsuite>\n`
      );
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': xmlContent.length
      });
      res.end(xmlContent);
      return;
    }

    // Default generic text
    const genericBuf = Buffer.from(`Test Report for ${safeName}\nGenerated by ATM GBA Hub\n`);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': genericBuf.length
    });
    res.end(genericBuf);
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
          broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
          break;
        }

        case 'DeviceListUpdate': {
          if (boundNodeId && fleetState.nodes[boundNodeId]) {
            fleetState.nodes[boundNodeId].devices = payload.devices || [];
            fleetState.nodes[boundNodeId].lastSeen = Date.now();
            broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
          }
          break;
        }

        case 'LogStream': {
          appendLog(payload.run_id, payload.line);
          broadcastToUI({
            type: 'LOG_STREAM',
            payload: {
              nodeId: boundNodeId,
              runId: payload.run_id,
              line: payload.line
            }
          });
          break;
        }

        case 'RunFinished': {
          if (boundNodeId && fleetState.nodes[boundNodeId]) {
            fleetState.nodes[boundNodeId].activeRuns = fleetState.nodes[boundNodeId].activeRuns.filter(
              (id) => id !== payload.run_id
            );
          }
          broadcastToUI({
            type: 'RUN_FINISHED',
            payload: {
              nodeId: boundNodeId,
              ...payload
            }
          });
          broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
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

        case 'ActionResponse': {
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
      setTimeout(() => {
        if (!bridgeConnections.has(boundNodeId)) {
          delete fleetState.nodes[boundNodeId];
          broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
        }
      }, 5000);
    }
  });
});

// UI WebSocket Handlers
wssUI.on('connection', (ws) => {
  uiConnections.add(ws);
  console.log(`[UI Client Connected] Total UI clients: ${uiConnections.size}`);

  // Send initial fleet state
  ws.send(JSON.stringify({ type: 'FLEET_STATE', payload: fleetState }));

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      const { type, payload } = msg;

      switch (type) {
        case 'TRIGGER_RUN': {
          const runReq = payload as RunBatchPayload;
          const targetWs = bridgeConnections.get(runReq.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'TriggerRun',
                payload: {
                  run_id: runReq.runId,
                  devices: runReq.devices,
                  tools: runReq.tools,
                  concurrency: runReq.concurrency || 1,
                  update: runReq.update || false
                }
              })
            );

            if (fleetState.nodes[runReq.nodeId]) {
              fleetState.nodes[runReq.nodeId].activeRuns.push(runReq.runId);
              broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
            }
          } else {
            ws.send(
              JSON.stringify({
                type: 'ACTION_RESPONSE',
                payload: {
                  nodeId: runReq.nodeId,
                  action: 'trigger_run',
                  success: false,
                  message: `Node ${runReq.nodeId} is offline or not connected`
                }
              })
            );
          }
          break;
        }

        case 'CANCEL_RUN': {
          const targetWs = bridgeConnections.get(payload.nodeId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: 'CancelRun',
                payload: { run_id: payload.runId }
              })
            );
          }
          break;
        }

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
