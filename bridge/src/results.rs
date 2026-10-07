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

fn find_model_dir(results_root: &Path, model: &str) -> Option<PathBuf> {
    let p1 = results_root.join(model);
    if p1.is_dir() { return Some(p1); }
    let p2 = results_root.join(model.replace('_', "-"));
    if p2.is_dir() { return Some(p2); }
    let p3 = results_root.join(model.replace('-', "_"));
    if p3.is_dir() { return Some(p3); }

    let Ok(rd) = fs::read_dir(results_root) else { return None };
    let norm = model.replace(['_', '-'], "").to_lowercase();
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().replace(['_', '-'], "").to_lowercase();
        if name == norm {
            return Some(p);
        }
    }
    None
}

/// ATM writes results/<model>/<pda>[_N]/<Tool>/. Pick the freshest folder written during this run.
fn find_tool_dir(model_dir: &Path, build: &str, folder: &str, since: Option<SystemTime>) -> Option<PathBuf> {
    let mut best: Option<(bool, SystemTime, PathBuf)> = None;
    let norm_build = build.replace(['_', '-'], "").to_lowercase();
    let Ok(rd) = fs::read_dir(model_dir) else { return None };

    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() { continue; }
        let tool_dir = p.join(folder);
        if !tool_dir.is_dir() {
            // Check case-insensitive tool folder
            let Ok(sub_rd) = fs::read_dir(&p) else { continue };
            let mut found = None;
            for sub in sub_rd.flatten() {
                if sub.path().is_dir() && sub.file_name().to_string_lossy().eq_ignore_ascii_case(folder) {
                    found = Some(sub.path());
                    break;
                }
            }
            let Some(td) = found else { continue };
            let Some(m) = newest_mtime(&td) else { continue };
            if let Some(s) = since {
                if m < s { continue; }
            }
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            let norm_name = name.replace(['_', '-'], "").to_lowercase();
            let matches = !norm_build.is_empty() && (norm_name == norm_build || norm_name.starts_with(&norm_build) || norm_build.starts_with(&norm_name));
            if best.as_ref().map_or(true, |(bm, bt, _)| (matches, m) > (*bm, *bt)) {
                best = Some((matches, m, td));
            }
            continue;
        }

        let Some(m) = newest_mtime(&tool_dir) else { continue };
        if let Some(s) = since {
            if m < s { continue; }
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let norm_name = name.replace(['_', '-'], "").to_lowercase();
        let matches = !norm_build.is_empty() && (norm_name == norm_build || norm_name.starts_with(&norm_build) || norm_build.starts_with(&norm_name));
        if best.as_ref().map_or(true, |(bm, bt, _)| (matches, m) > (*bm, *bt)) {
            best = Some((matches, m, tool_dir));
        }
    }

    if best.is_none() && since.is_some() {
        return find_tool_dir(model_dir, build, folder, None);
    }
    best.map(|(_, _, p)| p)
}

pub fn collect(atm_root: &str, serials: &[String], tools: &[String], since: SystemTime) -> Vec<ResultSet> {
    let devices = scanner::list_devices().unwrap_or_default();
    let mut sets = Vec::new();
    let results_root = Path::new(atm_root).join("results");

    for serial in serials {
        let Some(dev) = devices.iter().find(|d| &d.serial == serial) else { continue };
        let Some(model_dir) = find_model_dir(&results_root, &dev.model) else { continue };
        for folder in tools.iter().filter_map(|t| tool_folder(t)) {
            let Some(dir) = find_tool_dir(&model_dir, &dev.build, folder, Some(since)) else { continue };
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
