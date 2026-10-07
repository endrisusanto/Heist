use std::path::{Path, PathBuf};
use std::process::Command;

pub fn check_preflight(root_path: &str) -> Vec<String> {
    let root = Path::new(root_path);
    let mut lines = Vec::new();

    lines.push(format!("Root Path: {}", root.display()));
    if !root.exists() {
        lines.push(format!("[-] Root directory NOT FOUND: {}", root.display()));
        return lines;
    }
    lines.push(format!("[+] Root directory OK: {}", root.display()));

    // Check Java
    let java_check = Command::new(java_bin()).arg("-version").output();
    match java_check {
        Ok(out) => {
            let ver = String::from_utf8_lossy(&out.stderr);
            let first_line = ver.lines().next().unwrap_or("Java detected");
            lines.push(format!("[+] Java: {}", first_line.trim()));
        }
        Err(e) => {
            lines.push(format!("[-] Java not found or failed: {e}"));
        }
    }

    // Check ADB
    let adb_check = Command::new(crate::scanner::adb_path()).arg("version").output();
    match adb_check {
        Ok(out) => {
            let ver = String::from_utf8_lossy(&out.stdout);
            let first_line = ver.lines().next().unwrap_or("ADB detected");
            lines.push(format!("[+] ADB: {}", first_line.trim()));
        }
        Err(e) => {
            lines.push(format!("[-] ADB not found or failed: {e}"));
        }
    }

    // Check Core ATM files
    lines.push(check_file("ATM_v5.jar", root.join("ATM_v5.jar")));
    lines.push(check_file("AtmAgent.jar", root.join("AtmAgent.jar")));
    lines.push(check_file("AtmInfo.xml", root.join("AtmInfo.xml")));
    lines.push(check_dir("tools", root.join("tools")));
    lines.push(check_dir("results", root.join("results")));

    let tool_jars = [
        "Getprop.jar",
        "BVT.jar",
        "SVT.jar",
        "SDT.jar",
        "FMDUT.jar",
        "CSCChecker.jar",
        "AtmOctopus.jar",
    ];
    for tool in tool_jars {
        lines.push(check_file(tool, root.join("tools").join(tool)));
    }

    // Check CTS-Verifier Resources
    let cts_res = root.join("tools").join("resource").join("CTSVerifier");
    if cts_res.is_dir() {
        lines.push(format!("[+] Dir OK: CTS-Verifier Resources ({})", cts_res.display()));
    } else {
        lines.push(format!("[-] Missing dir: CTS-Verifier Resources ({})", cts_res.display()));
    }

    lines
}

pub fn java_bin() -> String {
    std::env::var("JAVA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "java".to_string())
}

fn check_file(label: &str, path: PathBuf) -> String {
    if path.is_file() {
        format!("[+] File OK: {label}")
    } else {
        format!("[-] Missing file: {label} ({})", path.display())
    }
}

fn check_dir(label: &str, path: PathBuf) -> String {
    if path.is_dir() {
        format!("[+] Dir OK: {label}")
    } else {
        format!("[-] Missing dir: {label} ({})", path.display())
    }
}
