use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub node_id: String,
    pub hub_url: String,
    pub bridge_token: String,
    pub atm_root: String,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "node-unknown".to_string());
        Self {
            node_id: hostname,
            hub_url: "wss://heist.endrisusanto.my.id/ws/bridge".to_string(),
            bridge_token: "".to_string(),
            atm_root: default_atm_root_path(),
        }
    }
}

pub fn default_atm_root_path() -> String {
    // Check standard candidate paths
    let candidates = [
        "/run/media/endri-pro/BINARY_HDD/AUTO",
        "/run/media/endri-pro/BINARY_HDD1/AUTO",
        "/home/endri-pro/Videos/ATM",
        "D:\\AUTO",
        "C:\\AUTO",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub serial: String,
    pub state: String,
    pub model: String,
    pub build_type: String,
    pub android: String,
    pub build: String,
    pub csc: String,
    pub security_patch: String,
    pub carrier: String,
    pub region: String,
    pub modem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub run_id: String,
    pub devices: Vec<String>,
    pub tools: Vec<String>,
    pub concurrency: Option<u8>,
    pub update: Option<bool>,
    pub atm_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFinished {
    pub run_id: String,
    pub exit_code: i32,
    pub devices: Vec<String>,
}

/// Messages sent from Bridge to Hub Server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum BridgeToHubMessage {
    RegisterNode {
        node_id: String,
        os: String,
        version: String,
        atm_root: String,
    },
    DeviceListUpdate {
        devices: Vec<DeviceInfo>,
    },
    LogStream {
        run_id: String,
        line: String,
    },
    RunFinished(RunFinished),
    PreflightReport {
        report: Vec<String>,
    },
    Heartbeat {
        timestamp: u64,
        active_runs: usize,
    },
    ActionResponse {
        action: String,
        success: bool,
        message: String,
    },
}

/// Messages received by Bridge from Hub Server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum HubToBridgeMessage {
    TriggerRun(RunRequest),
    CancelRun {
        run_id: String,
    },
    RequestPreflight {
        atm_root: Option<String>,
    },
    UpdateTools {
        atm_root: Option<String>,
    },
    SetLamp {
        serial: String,
        state: bool,
    },
    PressHome {
        serial: String,
    },
    ClearResults {
        serial: String,
    },
    Ping,
}
