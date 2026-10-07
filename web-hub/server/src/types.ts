export interface DeviceInfo {
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

export interface NodeState {
  nodeId: string;
  os: string;
  version: string;
  atmRoot: string;
  lastSeen: number;
  devices: DeviceInfo[];
  activeRuns: string[];
}

export interface ActiveRun {
  runId: string;
  nodeId: string;
  devices: string[];
  tools: string[];
  startedAt: number;
}

export interface FleetState {
  nodes: Record<string, NodeState>;
  activeRuns?: Record<string, ActiveRun>;
  busyDevices?: string[];
}

export interface RunBatchPayload {
  nodeId: string;
  runId: string;
  devices: string[];
  tools: string[];
  concurrency?: number;
  update?: boolean;
}
