use crate::scanner;
use crate::types::{ResultFile, ResultSet};
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn tool_folder(tool: &str) -> Option<&'static str> {
    let t = tool.to_lowercase();
    if t.contains("getprop") { Some("Getprop") }
    else if t.contains("bvt") || t.contains("basic") { Some("BVT") }
    else if t.contains("svt") || t.contains("preload") { Some("SVT") }
    else if t.contains("sdt") { Some("SDT") }
    else { None }
}

fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        let m = if p.is_dir() { newest_mtime(&p) } else { entry.metadata().ok().and_then(|m| m.modified().ok()) };
        if m > newest { newest = m; }
    }
    newest
}

fn read_files(base: &Path, dir: &Path, out: &mut Vec<ResultFile>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            read_files(base, &p, out);
        } else if let Ok(bytes) = fs::read(&p) {
            let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            out.push(ResultFile { path: rel, b64: base64::engine::general_purpose::STANDARD.encode(bytes) });
        }
    }
}

/// ATM writes results/<model>/<pda>[_N]/<Tool>/. Pick the freshest folder written during this run.
fn find_tool_dir(model_dir: &Path, build: &str, folder: &str, since: SystemTime) -> Option<PathBuf> {
    let mut best: Option<(bool, SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(model_dir).ok()?.flatten() {
        let tool_dir = entry.path().join(folder);
        if !tool_dir.is_dir() { continue; }
        let Some(m) = newest_mtime(&tool_dir) else { continue };
        if m < since { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let matches = name == build || name.starts_with(&format!("{build}_"));
        if best.as_ref().map_or(true, |(bm, bt, _)| (matches, m) > (*bm, *bt)) {
            best = Some((matches, m, tool_dir));
        }
    }
    best.map(|(_, _, p)| p)
}

pub fn collect(atm_root: &str, serials: &[String], tools: &[String], since: SystemTime) -> Vec<ResultSet> {
    let devices = scanner::list_devices().unwrap_or_default();
    let mut sets = Vec::new();
    for serial in serials {
        let Some(dev) = devices.iter().find(|d| &d.serial == serial) else { continue };
        let model_dir = Path::new(atm_root).join("results").join(&dev.model);
        for folder in tools.iter().filter_map(|t| tool_folder(t)) {
            let Some(dir) = find_tool_dir(&model_dir, &dev.build, folder, since) else { continue };
            let mut files = Vec::new();
            read_files(&dir, &dir, &mut files);
            if !files.is_empty() {
                sets.push(ResultSet {
                    serial: serial.clone(),
                    model: dev.model.clone(),
                    pda: dev.build.clone(),
                    tool: folder.to_string(),
                    files,
                });
            }
        }
    }
    sets
}
