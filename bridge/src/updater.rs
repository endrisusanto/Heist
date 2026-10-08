#[allow(unused_imports)]
use crate::types::CommandHiddenExt;
use std::env;
use std::path::PathBuf;
use std::process::Command;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GITHUB_REPO: &str = "endrisusanto/Heist";

pub fn get_temp_update_path() -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from("/tmp/heist-bridge-update.deb")
    }
    #[cfg(windows)]
    {
        env::temp_dir().join("heist-bridge-update.msi")
    }
}

pub fn download_file(url: &str, dest: &PathBuf) -> Result<(), String> {
    println!("[Updater] Downloading update from {url} to {}", dest.display());

    #[cfg(unix)]
    {
        let status = Command::new("curl")
            .args(["-fsSL", "-o", &dest.to_string_lossy(), url])
            .status()
            .map_err(|e| format!("curl execution failed: {e}"))?;

        if !status.success() {
            return Err(format!("curl download failed with exit code: {:?}", status.code()));
        }
    }

    #[cfg(windows)]
    {
        // Try curl.exe first (available on Win 10/11), fallback to PowerShell
        let mut curl_cmd = Command::new("curl.exe");
        curl_cmd.hide_window();
        let curl_res = curl_cmd
            .args(["-fsSL", "-o", &dest.to_string_lossy(), url])
            .status();

        match curl_res {
            Ok(s) if s.success() => {}
            _ => {
                let ps_cmd = format!(
                    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('{}', '{}')",
                    url,
                    dest.to_string_lossy()
                );
                let mut ps = Command::new("powershell");
                ps.hide_window();
                let status = ps
                    .args(["-NoProfile", "-Command", &ps_cmd])
                    .status()
                    .map_err(|e| format!("PowerShell download failed: {e}"))?;

                if !status.success() {
                    return Err(format!("Download failed with exit code: {:?}", status.code()));
                }
            }
        }
    }

    if !dest.exists() || std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) < 1024 {
        return Err("Downloaded update file is empty or missing".to_string());
    }

    Ok(())
}

pub fn fetch_latest_release_url() -> Result<(String, String), String> {
    let api_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let temp_json = env::temp_dir().join("heist_latest_release.json");

    let status = Command::new("curl")
        .args([
            "-fsSL",
            "-H",
            "User-Agent: HeistBridgeUpdater",
            "-o",
            &temp_json.to_string_lossy(),
            &api_url,
        ])
        .status()
        .map_err(|e| format!("Failed to query GitHub API: {e}"))?;

    if !status.success() {
        return Err(format!("GitHub release query failed with status {:?}", status.code()));
    }

    let content = std::fs::read_to_string(&temp_json)
        .map_err(|e| format!("Failed to read release JSON: {e}"))?;
    let _ = std::fs::remove_file(&temp_json);

    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid release JSON: {e}"))?;

    let tag_name = parsed["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();

    let assets = parsed["assets"]
        .as_array()
        .ok_or_else(|| "No assets in latest release".to_string())?;

    let target_ext = if cfg!(target_os = "windows") { ".msi" } else { ".deb" };

    for asset in assets {
        if let Some(name) = asset["name"].as_str() {
            if name.ends_with(target_ext) {
                if let Some(download_url) = asset["browser_download_url"].as_str() {
                    return Ok((tag_name, download_url.to_string()));
                }
            }
        }
    }

    Err(format!("No matching {target_ext} asset found in latest release"))
}

pub fn apply_silent_update_and_restart(file_path: &PathBuf) -> Result<(), String> {
    println!("[Updater] Initiating silent install and reopen from {}", file_path.display());

    #[cfg(unix)]
    {
        // Script: wait 1s for old process to exit, install .deb via pkexec or sudo, then reopen heist-bridge
        let script = format!(
            "sleep 1; if [ \"$(id -u)\" -eq 0 ]; then dpkg -i '{pkg}' || apt-get install -f -y; elif command -v pkexec >/dev/null 2>&1; then pkexec dpkg -i '{pkg}' || pkexec apt-get install -f -y; else sudo -n dpkg -i '{pkg}' || sudo dpkg -i '{pkg}'; fi; nohup /usr/bin/heist-bridge >/dev/null 2>&1 &",
            pkg = file_path.to_string_lossy()
        );

        Command::new("sh")
            .arg("-c")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to spawn updater script: {e}"))?;

        // Exit immediately to release any locks
        std::process::exit(0);
    }

    #[cfg(windows)]
    {
        // Windows msiexec silent install and relaunch
        let current_exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("heist-bridge.exe"));
        let cmd = format!(
            "timeout /t 2 /nobreak >nul & msiexec.exe /i \"{}\" /quiet /norestart & start \"\" \"{}\"",
            file_path.to_string_lossy(),
            current_exe.to_string_lossy()
        );

        let mut installer_cmd = Command::new("cmd");
        installer_cmd.hide_window();
        installer_cmd
            .args(["/C", &cmd])
            .spawn()
            .map_err(|e| format!("Failed to spawn Windows installer: {e}"))?;

        std::process::exit(0);
    }
}

pub fn perform_update(download_url: Option<String>) -> Result<String, String> {
    let url = match download_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            let (latest_ver, url) = fetch_latest_release_url()?;
            if latest_ver == CURRENT_VERSION {
                return Ok(format!("Already up to date (v{CURRENT_VERSION})"));
            }
            url
        }
    };

    let target_file = get_temp_update_path();
    download_file(&url, &target_file)?;
    apply_silent_update_and_restart(&target_file)?;

    Ok("Update downloaded and installer launched.".to_string())
}
