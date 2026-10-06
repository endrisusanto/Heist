export interface DeviceInfo {
  serial: String;
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

export interface NodeState {
  nodeId: string;
  os: string;
  version: string;
  atmRoot: string;
  lastSeen: number;
  devices: DeviceInfo[];
  activeRuns: string[];
}

export interface FleetState {
  nodes: Record<string, NodeState>;
}

export interface RunBatchPayload {
  nodeId: string;
  runId: string;
  devices: string[];
  tools: string[];
  concurrency?: number;
  update?: boolean;
}
