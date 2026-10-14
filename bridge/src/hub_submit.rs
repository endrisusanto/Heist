use crate::types::{BridgeToHubMessage, SubmitHubPayload};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

fn resolve_engine_script(app: &AppHandle) -> (PathBuf, Option<PathBuf>) {
    let candidates = [
        app.path().resolve("resources/engine/runner.mjs", tauri::path::BaseDirectory::Resource).ok(),
        app.path().resolve("engine/runner.mjs", tauri::path::BaseDirectory::Resource).ok(),
        app.path().resource_dir().map(|p| p.join("resources/engine/runner.mjs")).ok(),
        app.path().resource_dir().map(|p| p.join("engine/runner.mjs")).ok(),
        std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("resources/engine/runner.mjs"))),
        std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("engine/runner.mjs"))),
        Some(PathBuf::from("bridge/resources/engine/runner.mjs")),
        Some(PathBuf::from("resources/engine/runner.mjs")),
        Some(PathBuf::from("engine/runner.mjs")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            let working_dir = candidate.parent().map(|p| p.to_path_buf());
            return (candidate, working_dir);
        }
    }

    (PathBuf::from("resources/engine/runner.mjs"), None)
}

pub fn execute_hub_submission(
    app: AppHandle,
    payload: SubmitHubPayload,
    tx: mpsc::UnboundedSender<BridgeToHubMessage>,
) {
    tokio::spawn(async move {
        let (script_path, working_dir) = resolve_engine_script(&app);
        if !script_path.exists() {
            let err_msg = format!("Playwright submission engine not found at {:?}", script_path);
            let _ = tx.send(BridgeToHubMessage::ActionResponse {
                action: "submit_hub".to_string(),
                success: false,
                message: err_msg,
            });
            return;
        }

        let serialized = match serde_json::to_string(&payload) {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(BridgeToHubMessage::ActionResponse {
                    action: "submit_hub".to_string(),
                    success: false,
                    message: format!("Payload serialization failed: {e}"),
                });
                return;
            }
        };

        let mut cmd = Command::new("node");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Some(ref wd) = working_dir {
            cmd.current_dir(wd);
            cmd.arg("runner.mjs");
        } else {
            cmd.arg(&script_path);
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err_msg = format!("Failed to launch Node.js Playwright engine: {e}. Ensure Node.js is installed.");
                let _ = tx.send(BridgeToHubMessage::ActionResponse {
                    action: "submit_hub".to_string(),
                    success: false,
                    message: err_msg,
                });
                return;
            }
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(serialized.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }

        let stdout = match child.stdout.take() {
            Some(out) => out,
            None => return,
        };

        let mut reader = BufReader::new(stdout).lines();
        let mut finished_reported = false;

        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match event_type {
                    "log" => {
                        let msg = val.get("message").and_then(|v| v.as_str()).unwrap_or("");
                        let _ = tx.send(BridgeToHubMessage::LogStream {
                            run_id: "hub_submit".to_string(),
                            line: format!("[SubmitHub] {}", msg),
                        });
                    }
                    "finished" => {
                        finished_reported = true;
                        let success = val.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                        let msg = val.get("message").and_then(|v| v.as_str()).unwrap_or("");
                        let _ = tx.send(BridgeToHubMessage::ActionResponse {
                            action: "submit_hub".to_string(),
                            success,
                            message: msg.to_string(),
                        });
                    }
                    _ => {}
                }
            }
        }

        let _ = child.wait().await;

        if !finished_reported {
            let _ = tx.send(BridgeToHubMessage::ActionResponse {
                action: "submit_hub".to_string(),
                success: false,
                message: "Playwright process closed without final report".to_string(),
            });
        }
    });
}
