use crate::preflight::java_bin;
use crate::types::{CommandHiddenExt, RunFinished, RunRequest};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct ActiveBatch {
    pub id: String,
    pub devices: Vec<String>,
    pub pid: Option<u32>,
    pub cancel_file: PathBuf,
}

#[derive(Default, Clone)]
pub struct RunnerState {
    pub active_tasks: Arc<Mutex<HashMap<String, ActiveBatch>>>,
}

impl RunnerState {
    pub fn cancel_run(&self, run_id: &str) -> Result<bool, String> {
        let guard = self.active_tasks.lock().map_err(|e| e.to_string())?;
        if let Some(task) = guard.get(run_id) {
            let _ = std::fs::write(&task.cancel_file, "cancel\n");
            if let Some(pid) = task.pid {
                kill_process_tree(pid);
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

const BUNDLED_BATCH_LAUNCHER: &str = include_str!("../resources/atm-batch-launcher/AtmBatchLauncher.java");

pub fn run_batch_task<F, G>(
    runner_state: RunnerState,
    request: RunRequest,
    atm_root_path: &str,
    mut log_callback: F,
    finish_callback: G,
) -> Result<(), String>
where
    F: FnMut(String, String) + Send + 'static,
    G: FnOnce(RunFinished) + Send + 'static,
{
    let root = Path::new(atm_root_path);
    if !root.exists() {
        return Err(format!("ATM Root not found: {}", root.display()));
    }
    if request.devices.is_empty() {
        return Err("No devices specified for run".to_string());
    }
    if request.tools.is_empty() {
        return Err("No tools specified for run".to_string());
    }

    // Check device conflict
    {
        let guard = runner_state.active_tasks.lock().map_err(|e| e.to_string())?;
        for task in guard.values() {
            for dev in &request.devices {
                if task.devices.contains(dev) {
                    return Err(format!("Device {dev} is busy in run {}", task.id));
                }
            }
        }
    }

    let run_id = request.run_id.clone();
    let batch_launcher_dir = root.join("atm-batch-launcher");
    let _ = std::fs::create_dir_all(&batch_launcher_dir);
    let _ = std::fs::create_dir_all(batch_launcher_dir.join("runs"));

    // Ensure AtmBatchLauncher.java exists and is up to date
    let java_file = batch_launcher_dir.join("AtmBatchLauncher.java");
    let _ = std::fs::write(&java_file, BUNDLED_BATCH_LAUNCHER);

    let cancel_file = batch_launcher_dir
        .join("runs")
        .join(format!(".cancel-{run_id}"));
    let _ = std::fs::remove_file(&cancel_file);

    let active_batch = ActiveBatch {
        id: run_id.clone(),
        devices: request.devices.clone(),
        pid: None,
        cancel_file: cancel_file.clone(),
    };

    {
        let mut guard = runner_state.active_tasks.lock().map_err(|e| e.to_string())?;
        guard.insert(run_id.clone(), active_batch);
    }

    let root_buf = root.to_path_buf();
    let runner_state_clone = runner_state.clone();

    thread::spawn(move || {
        let devices_str = request.devices.join(",");
        let tools_str = request
            .tools
            .iter()
            .map(|t| t.to_lowercase())
            .collect::<Vec<_>>()
            .join(",");
        let concurrency_str = request.concurrency.unwrap_or(1).max(1).to_string();

        let mut args = vec![
            "atm-batch-launcher/AtmBatchLauncher.java".to_string(),
            "--run".to_string(),
            "--tools".to_string(),
            tools_str,
            "--devices".to_string(),
            devices_str,
            "--concurrency".to_string(),
            concurrency_str,
            "--cancel-file".to_string(),
            cancel_file.to_string_lossy().to_string(),
        ];
        if request.update.unwrap_or(false) {
            args.push("--update".to_string());
        }
        if let Some(ref subtests) = request.ctsv_subtests {
            if !subtests.is_empty() {
                args.push("--ctsv-subtests".to_string());
                args.push(subtests.join(","));
            }
        }

        let java = java_bin();
        log_callback(
            run_id.clone(),
            format!("[launcher] Starting: {java} {}", args.join(" ")),
        );

        let mut command = Command::new(&java);
        command.hide_window();
        command
            .current_dir(&root_buf)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        {
            if std::env::var("DISPLAY").map_or(true, |v| v.trim().is_empty()) {
                command.env("DISPLAY", ":0");
            }
        }

        let mut exit_code = 1;
        match command.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                if let Ok(mut guard) = runner_state_clone.active_tasks.lock() {
                    if let Some(task) = guard.get_mut(&run_id) {
                        task.pid = Some(pid);
                    }
                }

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let (tx, rx) = std::sync::mpsc::channel();

                if let Some(out) = stdout {
                    let tx_out = tx.clone();
                    thread::spawn(move || {
                        let reader = BufReader::new(out);
                        for line in reader.lines().map_while(Result::ok) {
                            let _ = tx_out.send(line);
                        }
                    });
                }

                if let Some(err) = stderr {
                    let tx_err = tx.clone();
                    thread::spawn(move || {
                        let reader = BufReader::new(err);
                        for line in reader.lines().map_while(Result::ok) {
                            let _ = tx_err.send(line);
                        }
                    });
                }
                drop(tx);

                while let Ok(line) = rx.recv() {
                    log_callback(run_id.clone(), line);
                }

                match child.wait() {
                    Ok(status) => {
                        exit_code = status.code().unwrap_or(0);
                    }
                    Err(e) => {
                        log_callback(run_id.clone(), format!("[launcher] Wait error: {e}"));
                    }
                }
            }
            Err(e) => {
                log_callback(run_id.clone(), format!("[launcher] Spawn failed: {e}"));
            }
        }

        // Cleanup task from active list
        if let Ok(mut guard) = runner_state_clone.active_tasks.lock() {
            guard.remove(&run_id);
        }
        let _ = std::fs::remove_file(&cancel_file);

        finish_callback(RunFinished {
            run_id,
            exit_code,
            devices: request.devices,
        });
    });

    Ok(())
}

pub fn run_atm_agent_update(atm_root_path: &str) -> Result<String, String> {
    let root = Path::new(atm_root_path);
    let agent_jar = root.join("AtmAgent.jar");
    if !agent_jar.exists() {
        return Err(format!("AtmAgent.jar not found in {}", root.display()));
    }
    let java = java_bin();
    let mut cmd = Command::new(java);
    cmd.hide_window();
    cmd.current_dir(root)
        .args(["-jar", &agent_jar.to_string_lossy(), "update"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match cmd.output() {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            Ok(s.trim().to_string())
        }
        Err(e) => Err(format!("Failed to run AtmAgent.jar update: {e}")),
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.hide_window();
        let _ = cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
}
