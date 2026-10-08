#![windows_subsystem = "windows"]

mod preflight;
mod results;
mod runner;
mod scanner;
mod types;
mod updater;

use futures_util::{SinkExt, StreamExt};
use runner::RunnerState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use types::{BridgeConfig, BridgeToHubMessage, HubToBridgeMessage};

static LOG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct AppState {
    config: std::sync::Mutex<BridgeConfig>,
    runner: RunnerState,
    ws_tx: std::sync::Mutex<Option<mpsc::UnboundedSender<BridgeToHubMessage>>>,
    connected: AtomicBool,
    status_detail: std::sync::Mutex<String>,
    device_count: std::sync::atomic::AtomicUsize,
    recent_logs: std::sync::Mutex<Vec<serde_json::Value>>,
    reconnect_notify: Arc<Notify>,
}

pub fn emit_log(app: &AppHandle, level: &str, message: &str) {
    let id = LOG_SEQ.fetch_add(1, Ordering::SeqCst);
    let log_obj = serde_json::json!({
        "id": id,
        "level": level,
        "message": message
    });
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.recent_logs.lock() {
            guard.push(log_obj.clone());
            if guard.len() > 100 {
                guard.remove(0);
            }
        }
    }
    let _ = app.emit("bridge-log", log_obj);
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<BridgeConfig, String> {
    let guard = state.config.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let connected = state.connected.load(Ordering::SeqCst);
    let detail = state.status_detail.lock().unwrap().clone();
    let cfg = state.config.lock().map_err(|e| e.to_string())?.clone();
    let count = state.device_count.load(Ordering::SeqCst);
    let logs = state.recent_logs.lock().unwrap().clone();
    Ok(serde_json::json!({
        "status": if connected { "connected" } else { "disconnected" },
        "detail": detail,
        "connected": connected,
        "node_id": cfg.node_id,
        "hub_url": cfg.hub_url,
        "atm_root": cfg.atm_root,
        "device_count": count,
        "logs": logs,
    }))
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: BridgeConfig,
) -> Result<(), String> {
    {
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        *guard = config.clone();
    }
    save_config_to_disk(&config);
    emit_log(&app, "info", &format!("Config saved. Node ID: {}, Hub: {}", config.node_id, config.hub_url));
    
    let detail = format!("Reconnecting to {}", config.hub_url);
    *state.status_detail.lock().unwrap() = detail.clone();
    let _ = app.emit("bridge-status", serde_json::json!({
        "status": "connecting",
        "detail": detail
    }));

    // Trigger immediate reconnection
    state.reconnect_notify.notify_waiters();
    Ok(())
}

#[tauri::command]
fn browse_atm_root() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select ATM Root Directory")
        .pick_folder();
    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
fn trigger_self_update(download_url: Option<String>) -> Result<String, String> {
    updater::perform_update(download_url)
}

fn config_path() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        let dir = PathBuf::from(home).join(".config").join("heist");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("bridge_config.json");
    }
    if let Ok(mut dir) = std::env::current_exe() {
        dir.pop();
        let local = dir.join("heist_bridge_config.json");
        return local;
    }
    PathBuf::from("heist_bridge_config.json")
}

fn load_config_from_disk() -> BridgeConfig {
    let path = config_path();
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<BridgeConfig>(&data) {
                return cfg;
            }
        }
    }
    BridgeConfig::default()
}

fn save_config_to_disk(cfg: &BridgeConfig) {
    let path = config_path();
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, json);
    }
}

fn main() {
    let initial_config = load_config_from_disk();
    let runner_state = RunnerState::default();

    let app_state = AppState {
        config: std::sync::Mutex::new(initial_config),
        runner: runner_state.clone(),
        ws_tx: std::sync::Mutex::new(None),
        connected: AtomicBool::new(false),
        status_detail: std::sync::Mutex::new("Initializing bridge agent".to_string()),
        device_count: std::sync::atomic::AtomicUsize::new(0),
        recent_logs: std::sync::Mutex::new(Vec::new()),
        reconnect_notify: Arc::new(Notify::new()),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle().clone();

            // Setup Tray Menu
            let show_i = MenuItem::with_id(&handle, "show", "Open Node Settings", true, None::<&str>)?;
            let preflight_i = MenuItem::with_id(&handle, "preflight", "Run Preflight", true, None::<&str>)?;
            let update_i = MenuItem::with_id(&handle, "update", "Check for Updates", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(&handle, "quit", "Quit Heist Bridge", true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&show_i, &preflight_i, &update_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Heist Bridge - Android Fleet Agent")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "preflight" => {
                        let state = app.state::<AppState>();
                        let root = {
                            state.config.lock().unwrap().atm_root.clone()
                        };
                        let report = preflight::check_preflight(&root);
                        println!("[Preflight Report]\n{}", report.join("\n"));
                    }
                    "update" => {
                        tokio::spawn(async {
                            match updater::perform_update(None) {
                                Ok(msg) => println!("[Update] {msg}"),
                                Err(err) => eprintln!("[Update Error] {err}"),
                            }
                        });
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Prevent app exit on window close - hide instead
            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                });
            }

            // Start WebSocket Loop in Tokio background
            let app_handle_for_ws = handle.clone();
            tauri::async_runtime::spawn(async move {
                ws_connection_loop(app_handle_for_ws).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_status,
            save_config,
            browse_atm_root,
            hide_window,
            trigger_self_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Heist Bridge");
}

async fn ws_connection_loop(app: AppHandle) {
    let mut backoff_secs = 1u64;

    let reconnect_notify = {
        let state = app.state::<AppState>();
        state.reconnect_notify.clone()
    };

    loop {
        let (hub_url, bridge_token, node_id, atm_root) = {
            let state = app.state::<AppState>();
            let cfg = state.config.lock().unwrap();
            (
                cfg.hub_url.clone(),
                cfg.bridge_token.clone(),
                cfg.node_id.clone(),
                cfg.atm_root.clone(),
            )
        };

        let detail_connecting = format!("Connecting to {hub_url}...");
        {
            let state = app.state::<AppState>();
            *state.status_detail.lock().unwrap() = detail_connecting.clone();
            let _ = app.emit("bridge-status", serde_json::json!({
                "status": "connecting",
                "detail": detail_connecting
            }));
        }
        emit_log(&app, "info", &format!("Connecting to WebSocket hub at {}...", hub_url));

        let mut req = match hub_url.clone().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                let err_msg = format!("Invalid URL: {e}");
                emit_log(&app, "error", &err_msg);
                let state = app.state::<AppState>();
                *state.status_detail.lock().unwrap() = err_msg.clone();
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "disconnected",
                    "detail": err_msg
                }));
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                    _ = reconnect_notify.notified() => {
                        backoff_secs = 1;
                    }
                }
                continue;
            }
        };

        if !bridge_token.trim().is_empty() {
            if let Ok(val) = HeaderValue::from_str(&bridge_token) {
                req.headers_mut().insert("x-bridge-token", val);
            }
        }
        if let Ok(val) = HeaderValue::from_str(&node_id) {
            req.headers_mut().insert("x-node-id", val);
        }

        match connect_async(req).await {
            Ok((ws_stream, _)) => {
                backoff_secs = 1;
                let state = app.state::<AppState>();
                state.connected.store(true, Ordering::SeqCst);

                let detail_connected = format!("Connected to {hub_url}");
                *state.status_detail.lock().unwrap() = detail_connected.clone();
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "connected",
                    "detail": detail_connected
                }));
                emit_log(&app, "success", &format!("Connected to Hub as node '{}'", node_id));

                let (mut write, mut read) = ws_stream.split();

                enum OutgoingWs {
                    Msg(BridgeToHubMessage),
                    Pong(Vec<u8>),
                }

                let (tx_ws, mut rx_ws) = mpsc::unbounded_channel::<OutgoingWs>();
                let (tx, mut rx) = mpsc::unbounded_channel::<BridgeToHubMessage>();

                {
                    let mut guard = state.ws_tx.lock().unwrap();
                    *guard = Some(tx.clone());
                }

                // BridgeToHubMessage forwarder into OutgoingWs
                let tx_ws_msg = tx_ws.clone();
                let fwd_task = tokio::spawn(async move {
                    while let Some(m) = rx.recv().await {
                        if tx_ws_msg.send(OutgoingWs::Msg(m)).is_err() {
                            break;
                        }
                    }
                });

                // Send RegisterNode
                let register_msg = BridgeToHubMessage::RegisterNode {
                    node_id: node_id.clone(),
                    os: std::env::consts::OS.to_string(),
                    version: "0.1.0".to_string(),
                    atm_root: atm_root.clone(),
                };
                let _ = tx.send(register_msg);

                // Task for outgoing messages from channel to WebSocket
                let write_task = tokio::spawn(async move {
                    while let Some(out) = rx_ws.recv().await {
                        match out {
                            OutgoingWs::Msg(msg) => {
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    if write.send(Message::Text(json)).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            OutgoingWs::Pong(payload) => {
                                if write.send(Message::Pong(payload)).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });

                // Periodic Device Scan & Heartbeat
                let tx_scanner = tx.clone();
                let app_scanner = app.clone();
                let scan_task = tokio::spawn(async move {
                    let mut last_count = usize::MAX;
                    loop {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        let devices = tokio::task::spawn_blocking(scanner::list_devices)
                            .await
                            .unwrap_or_else(|_| Ok(Vec::new()))
                            .unwrap_or_default();

                        let count = devices.len();
                        if let Some(state) = app_scanner.try_state::<AppState>() {
                            state.device_count.store(count, Ordering::SeqCst);
                        }
                        let _ = app_scanner.emit("device-count-update", count);
                        if count != last_count {
                            last_count = count;
                            emit_log(&app_scanner, "info", &format!("ADB discovery: {count} active device(s) online"));
                        }

                        if tx_scanner
                            .send(BridgeToHubMessage::DeviceListUpdate { devices })
                            .is_err()
                        {
                            break;
                        }
                    }
                });

                // Read loop for incoming commands from Hub with cancellation on reconnect_notify
                let tx_ws_pong = tx_ws.clone();
                loop {
                    tokio::select! {
                        msg_res = read.next() => {
                            match msg_res {
                                Some(Ok(Message::Text(text))) => {
                                    if let Ok(cmd) = serde_json::from_str::<HubToBridgeMessage>(&text) {
                                        handle_hub_command(cmd, &app, tx.clone());
                                    }
                                }
                                Some(Ok(Message::Ping(data))) => {
                                    let _ = tx_ws_pong.send(OutgoingWs::Pong(data));
                                    let _ = tx.send(BridgeToHubMessage::Heartbeat {
                                        timestamp: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap()
                                            .as_secs(),
                                        active_runs: 0,
                                    });
                                }
                                None | Some(Ok(Message::Close(_))) | Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        _ = reconnect_notify.notified() => {
                            emit_log(&app, "info", "Reconnecting to Hub with updated settings...");
                            break;
                        }
                    }
                }

                write_task.abort();
                fwd_task.abort();
                scan_task.abort();

                state.connected.store(false, Ordering::SeqCst);
                {
                    let mut guard = state.ws_tx.lock().unwrap();
                    *guard = None;
                }

                *state.status_detail.lock().unwrap() = "Connection closed".to_string();
                emit_log(&app, "warn", "Connection to Hub closed. Reconnecting...");
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "disconnected",
                    "detail": "Connection closed"
                }));
            }
            Err(e) => {
                let err_msg = format!("Connect failed: {e}. Retry in {backoff_secs}s");
                emit_log(&app, "error", &err_msg);
                let state = app.state::<AppState>();
                *state.status_detail.lock().unwrap() = err_msg.clone();
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "disconnected",
                    "detail": err_msg
                }));
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {},
            _ = reconnect_notify.notified() => {
                backoff_secs = 1;
            }
        }
        backoff_secs = (backoff_secs + 1).min(5);
    }
}

fn handle_hub_command(
    cmd: HubToBridgeMessage,
    app: &AppHandle,
    tx: mpsc::UnboundedSender<BridgeToHubMessage>,
) {
    let state = app.state::<AppState>();
    let atm_root = state.config.lock().unwrap().atm_root.clone();

    match cmd {
        HubToBridgeMessage::TriggerRun(req) => {
            emit_log(app, "info", &format!("Run triggered: {} on {} device(s) with {} tool(s)", req.run_id, req.devices.len(), req.tools.len()));
            let tx_log = tx.clone();
            let tx_finish = tx.clone();
            let runner_state = state.runner.clone();
            let app_log = app.clone();
            let app_finish = app.clone();
            let tools = req.tools.clone();
            let root_finish = atm_root.clone();
            let started = std::time::SystemTime::now() - Duration::from_secs(5);

            let res = runner::run_batch_task(
                runner_state,
                req,
                &atm_root,
                move |run_id, line| {
                    let _ = tx_log.send(BridgeToHubMessage::LogStream { run_id: run_id.clone(), line: line.clone() });
                    emit_log(&app_log, "log", &format!("[{run_id}] {line}"));
                },
                move |finished| {
                    emit_log(&app_finish, "info", &format!("Automation run {} completed with exit code {}", finished.run_id, finished.exit_code));
                    let sets = results::collect(&root_finish, &finished.devices, &tools, started);
                    if !sets.is_empty() {
                        let _ = tx_finish.send(BridgeToHubMessage::RunResults { run_id: finished.run_id.clone(), sets });
                    }
                    let _ = tx_finish.send(BridgeToHubMessage::RunFinished(finished));
                },
            );

            if let Err(e) = res {
                emit_log(app, "error", &format!("Failed to trigger run: {e}"));
                let _ = tx.send(BridgeToHubMessage::ActionResponse {
                    action: "trigger_run".to_string(),
                    success: false,
                    message: e,
                });
            }
        }
        HubToBridgeMessage::CancelRun { run_id } => {
            emit_log(app, "warn", &format!("Cancel run requested for {run_id}"));
            let res = state.runner.cancel_run(&run_id);
            let _ = tx.send(BridgeToHubMessage::ActionResponse {
                action: "cancel_run".to_string(),
                success: res.is_ok(),
                message: format!("Cancel result: {:?}", res),
            });
        }
        HubToBridgeMessage::RequestPreflight { atm_root: root_override } => {
            emit_log(app, "info", "Preflight check requested");
            let root = root_override.unwrap_or(atm_root);
            let report = preflight::check_preflight(&root);
            let _ = tx.send(BridgeToHubMessage::PreflightReport { report });
        }
        HubToBridgeMessage::UpdateTools { atm_root: root_override } => {
            emit_log(app, "info", "ATM tools update requested");
            let root = root_override.unwrap_or(atm_root);
            let res = runner::run_atm_agent_update(&root);
            let _ = tx.send(BridgeToHubMessage::ActionResponse {
                action: "update_tools".to_string(),
                success: res.is_ok(),
                message: res.unwrap_or_else(|e| e),
            });
        }
        HubToBridgeMessage::SetLamp { serial, state } => {
            emit_log(app, "info", &format!("Toggle lamp for {serial} (state: {state})"));
            let _ = scanner::set_device_lamp(&serial, state);
        }
        HubToBridgeMessage::PressHome { serial } => {
            emit_log(app, "info", &format!("Press Home button on {serial}"));
            let _ = scanner::press_device_home(&serial);
        }
        HubToBridgeMessage::ClearResults { serial } => {
            emit_log(app, "info", &format!("Clear result files on {serial}"));
            let res = scanner::clear_device_results(&serial, std::path::Path::new(&atm_root));
            let _ = tx.send(BridgeToHubMessage::ActionResponse {
                action: "clear_results".to_string(),
                success: res.is_ok(),
                message: res.unwrap_or_else(|e| e),
            });
        }
        HubToBridgeMessage::UpdateBridge { download_url } => {
            emit_log(app, "info", "Bridge self-update initiated");
            let tx_clone = tx.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                let res = updater::perform_update(download_url);
                match &res {
                    Ok(msg) => emit_log(&app_clone, "success", &format!("Bridge update succeeded: {msg}")),
                    Err(e) => emit_log(&app_clone, "error", &format!("Bridge update failed: {e}")),
                }
                let _ = tx_clone.send(BridgeToHubMessage::ActionResponse {
                    action: "update_bridge".to_string(),
                    success: res.is_ok(),
                    message: match res {
                        Ok(msg) => msg,
                        Err(e) => format!("Update failed: {e}"),
                    },
                });
            });
        }
        HubToBridgeMessage::Ping => {
            let _ = tx.send(BridgeToHubMessage::Heartbeat {
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                active_runs: 0,
            });
        }
    }
}
