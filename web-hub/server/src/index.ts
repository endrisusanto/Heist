import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceInfo, FleetState, NodeState, RunBatchPayload } from './types.js';

const PORT = parseInt(process.env.PORT || '4020', 10);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://heist.endrisusanto.my.id';
const CLIENT_DIST = path.resolve(process.cwd(), '../client/dist');

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
      delete fleetState.nodes[boundNodeId];
      broadcastToUI({ type: 'FLEET_STATE', payload: fleetState });
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
