use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub node_id: String,
    pub hub_url: String,
    #[serde(default)]
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
        "/home/endri-pro/Videos/ATM/ATMv5_20260429",
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
    #[serde(default)]
    pub ctsv_subtests: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFinished {
    pub run_id: String,
    pub exit_code: i32,
    pub devices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultFile {
    pub path: String,
    pub b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultSet {
    pub serial: String,
    pub model: String,
    pub pda: String,
    pub tool: String,
    pub files: Vec<ResultFile>,
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
    RunResults {
        run_id: String,
        sets: Vec<ResultSet>,
    },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cookies: Option<serde_json::Value>,
    },
}

impl BridgeToHubMessage {
    pub fn action_response(action: impl Into<String>, success: bool, message: impl Into<String>) -> Self {
        Self::ActionResponse {
            action: action.into(),
            success,
            message: message.into(),
            cookies: None,
        }
    }

    pub fn action_response_with_cookies(
        action: impl Into<String>,
        success: bool,
        message: impl Into<String>,
        cookies: Option<serde_json::Value>,
    ) -> Self {
        Self::ActionResponse {
            action: action.into(),
            success,
            message: message.into(),
            cookies,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitHubPayload {
    pub title: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub hub_base_url: String,
    #[serde(default)]
    pub board_srl: String,
    #[serde(default)]
    pub archive_path: Option<String>,
    #[serde(default)]
    pub archive_base64: Option<String>,
    #[serde(default)]
    pub archive_filename: Option<String>,
    #[serde(default)]
    pub cookies: serde_json::Value,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_headless_true")]
    pub headless: bool,
}

fn default_headless_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckAuthPayload {
    pub hub_base_url: String,
    #[serde(default)]
    pub cookies: serde_json::Value,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_headless_true")]
    pub headless: bool,
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
    UpdateBridge {
        download_url: Option<String>,
    },
    SubmitToHub(SubmitHubPayload),
    CheckAuth(CheckAuthPayload),
    Ping,
}

pub trait CommandHiddenExt {
    fn hide_window(&mut self) -> &mut Self;
}

impl CommandHiddenExt for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        self
    }
}

#[allow(dead_code)]
pub fn new_hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.hide_window();
    cmd
}
