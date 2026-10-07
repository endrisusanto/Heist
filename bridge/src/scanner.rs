use crate::types::DeviceInfo;
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

pub fn adb_path() -> String {
    env::var("ADB")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "adb".to_string())
}

pub fn run_output_with_timeout(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn ADB: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                if status.success() {
                    return Ok(out);
                } else {
                    let mut err = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        let _ = stderr.read_to_string(&mut err);
                    }
                    return Err(format!("Command failed with {status}: {err}"));
                }
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("Command timed out after {}s", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Error waiting for process: {e}")),
        }
    }
}

use std::sync::Mutex;
use once_cell::sync::Lazy;

static DEVICE_CACHE: Lazy<Mutex<HashMap<String, DeviceInfo>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let adb = adb_path();
    let output = match run_output_with_timeout(
        {
            let mut c = Command::new(&adb);
            c.args(["devices", "-l"]);
            c
        },
        Duration::from_secs(4),
    ) {
        Ok(out) => out,
        Err(err) => {
            return Err(format!("ADB devices error: {err}"));
        }
    };

    let mut raw_devices = Vec::new();
    let mut current_serials = std::collections::HashSet::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices") || trimmed.starts_with('*') {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();
        current_serials.insert(serial.clone());
        raw_devices.push((serial, state, trimmed.to_string()));
    }

    // Clean removed devices from cache
    if let Ok(mut cache) = DEVICE_CACHE.lock() {
        cache.retain(|k, _| current_serials.contains(k));
    }

    let mut devices = Vec::new();
    let mut to_fetch = Vec::new();

    {
        let cache = DEVICE_CACHE.lock().unwrap();
        for (serial, state, trimmed) in raw_devices {
            if let Some(cached) = cache.get(&serial) {
                if cached.state == state && cached.model != "UNKNOWN" && cached.model != "-" && cached.build != "-" && !cached.build.is_empty() {
                    devices.push(cached.clone());
                    continue;
                }
            }
            to_fetch.push((serial, state, trimmed));
        }
    }

    if !to_fetch.is_empty() {
        let handles: Vec<_> = to_fetch
            .into_iter()
            .map(|(serial, state, trimmed)| {
                let adb_clone = adb.clone();
                thread::spawn(move || {
                    let props = if state == "device" {
                        adb_props(&adb_clone, &serial).unwrap_or_default()
                    } else {
                        HashMap::new()
                    };

                    let model = first_non_empty(&[
                        token_value(&trimmed, "model"),
                        props.get("ro.product.model").cloned().unwrap_or_default(),
                        props.get("ro.product.vendor.model").cloned().unwrap_or_default(),
                    ]);

                    let mut build = first_non_empty(&[
                        props.get("ro.build.PDA").cloned().unwrap_or_default(),
                        props.get("ro.boot.bootloader").cloned().unwrap_or_default(),
                        props.get("ro.bootloader").cloned().unwrap_or_default(),
                        props.get("ro.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.bootimage.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.system.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.vendor.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.odm.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.product.build.version.incremental").cloned().unwrap_or_default(),
                        props.get("ro.build.display.id").cloned().unwrap_or_default(),
                        props.get("ro.build.id").cloned().unwrap_or_default(),
                    ]);

                    // Single getprop fallback if full getprop map missed PDA
                    if (build == "-" || build.is_empty()) && state == "device" {
                        let mut fallback_cmd = Command::new(&adb_clone);
                        fallback_cmd.args(["-s", &serial, "shell", "getprop ro.build.PDA || getprop ro.boot.bootloader || getprop ro.build.version.incremental"]);
                        if let Ok(val) = run_output_with_timeout(fallback_cmd, Duration::from_secs(3)) {
                            let clean_val = val.trim().to_string();
                            if !clean_val.is_empty() {
                                build = clean_val;
                            }
                        }
                    }

                    DeviceInfo {
                        serial: serial.clone(),
                        state,
                        model,
                        build_type: first_non_empty(&[
                            props.get("ro.build.type").cloned().unwrap_or_default(),
                            props.get("ro.system.build.type").cloned().unwrap_or_default(),
                            props.get("ro.vendor.build.type").cloned().unwrap_or_default(),
                        ]),
                        android: first_non_empty(&[
                            props.get("ro.build.version.release").cloned().unwrap_or_default(),
                            props.get("ro.system.build.version.release").cloned().unwrap_or_default(),
                            props.get("ro.vendor.build.version.release").cloned().unwrap_or_default(),
                        ]),
                        build,
                        csc: first_non_empty(&[
                            props.get("ril.official_cscver").cloned().unwrap_or_default(),
                            props.get("ro.csc.sales_code").cloned().unwrap_or_default(),
                            props.get("ro.boot.sales_code").cloned().unwrap_or_default(),
                            props.get("ro.csc.countryiso_code").cloned().unwrap_or_default(),
                        ]),
                        security_patch: props
                            .get("ro.build.version.security_patch")
                            .cloned()
                            .unwrap_or_else(|| "-".to_string()),
                        carrier: first_non_empty(&[
                            props.get("ro.csc.sales_code").cloned().unwrap_or_default(),
                            props.get("ro.boot.sales_code").cloned().unwrap_or_default(),
                            props.get("ro.csc.country_code").cloned().unwrap_or_default(),
                        ]),
                        region: props
                            .get("ro.product.locale.region")
                            .cloned()
                            .unwrap_or_else(|| "INDONESIA".to_string()),
                        modem: normalize_modem(first_non_empty(&[
                            props.get("gsm.version.baseband").cloned().unwrap_or_default(),
                            props.get("ril.modem.board").cloned().unwrap_or_default(),
                        ])),
                    }
                })
            })
            .collect();

        if let Ok(mut cache) = DEVICE_CACHE.lock() {
            for handle in handles {
                if let Ok(device) = handle.join() {
                    cache.insert(device.serial.clone(), device.clone());
                    devices.push(device);
                }
            }
        }
    }

    Ok(devices)
}

fn adb_props(adb: &str, serial: &str) -> Result<HashMap<String, String>, String> {
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "shell", "getprop"]);
    let output = run_output_with_timeout(cmd, Duration::from_secs(4))?;
    let mut map = HashMap::new();
    for line in output.lines() {
        if let Some((k, v)) = parse_getprop_line(line) {
            map.insert(k, v);
        }
    }
    Ok(map)
}

fn parse_getprop_line(line: &str) -> Option<(String, String)> {
    let open1 = line.find('[')?;
    let close1 = line[open1 + 1..].find(']')? + open1 + 1;
    let key = &line[open1 + 1..close1];

    let rest = &line[close1 + 1..];
    let open2 = rest.find('[')? + close1 + 1;
    let close2 = line[open2 + 1..].rfind(']')? + open2 + 1;
    let val = &line[open2 + 1..close2];

    Some((key.to_string(), val.to_string()))
}

fn token_value(line: &str, key: &str) -> String {
    for part in line.split_whitespace() {
        if let Some((k, v)) = part.split_once(':') {
            if k.eq_ignore_ascii_case(key) {
                return v.to_string();
            }
        }
    }
    String::new()
}

fn first_non_empty(values: &[String]) -> String {
    for v in values {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    "-".to_string()
}

fn normalize_modem(value: String) -> String {
    let mut seen = std::collections::HashSet::new();
    let parts: Vec<&str> = value
        .split(|c| c == ',' || c == '/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && seen.insert(*part))
        .collect();
    if parts.is_empty() {
        "-".to_string()
    } else {
        parts.join("/")
    }
}

pub fn set_device_lamp(serial: &str, state: bool) -> Result<(), String> {
    let adb = adb_path();
    let val = if state { "1" } else { "0" };
    let mut cmd = Command::new(&adb);
    cmd.args(["-s", serial, "shell", "cmd", "flashlight", val]);
    let _ = run_output_with_timeout(cmd, Duration::from_secs(3));
    Ok(())
}

pub fn press_device_home(serial: &str) -> Result<(), String> {
    let adb = adb_path();
    let mut cmd = Command::new(&adb);
    cmd.args(["-s", serial, "shell", "input", "keyevent", "3"]);
    let _ = run_output_with_timeout(cmd, Duration::from_secs(3));
    Ok(())
}

pub fn clear_device_results(serial: &str, atm_root: &Path) -> Result<String, String> {
    let adb = adb_path();
    let mut cmd = Command::new(&adb);
    cmd.args(["-s", serial, "shell", "getprop", "ro.product.model"]);
    let model = run_output_with_timeout(cmd, Duration::from_secs(3))
        .unwrap_or_else(|_| "UNKNOWN".to_string())
        .trim()
        .to_string();

    let model_res_dir = atm_root.join("results").join(&model);
    if model_res_dir.exists() {
        let backup = atm_root
            .join("results")
            .join(format!("{model}_archived_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));
        let _ = std::fs::rename(&model_res_dir, &backup);
        Ok(format!("Archived {} to {}", model_res_dir.display(), backup.display()))
    } else {
        Ok(format!("No results folder found for {model}"))
    }
}
