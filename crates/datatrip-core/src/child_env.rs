//! Environment for programs DataTrip starts (Codex / Claude Code CLIs, the browser opener).
//!
//! Inside a Linux AppImage the runtime points `LD_LIBRARY_PATH`, `PATH`, GTK/GIO module paths
//! etc. at the AppImage's bundled files. Child processes inherit that, so e.g. `node` (used by
//! the Codex CLI) loads the AppImage's older `libffi.so.8` and fails with
//! "version `LIBFFI_CALL_PLAN_8.4' not found". These helpers remove the AppImage's entries so a
//! child runs with the system's own libraries. Outside an AppImage they change nothing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Variables AppImage runtimes (AppRun, linuxdeploy GTK plugin) point at the mounted image.
const APPIMAGE_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "XDG_DATA_DIRS",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_SCANNER",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// The AppImage mount directory when running from an AppImage.
pub fn appimage_dir() -> Option<String> {
    std::env::var_os("APPIMAGE")?;
    std::env::var("APPDIR").ok().filter(|d| d.len() > 1)
}

/// Splits a `:`-separated list and drops entries inside `dir`.
fn without_dir(value: &str, dir: &str) -> Vec<String> {
    value
        .split(':')
        .filter(|p| !p.is_empty() && !p.starts_with(dir))
        .map(str::to_string)
        .collect()
}

/// Changes to make to a child's environment: `(name, Some(value))` to set, `(name, None)` to
/// remove. Empty outside an AppImage.
pub fn cleaned_env() -> Vec<(&'static str, Option<OsString>)> {
    let Some(dir) = appimage_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in APPIMAGE_VARS {
        let Some(val) = std::env::var_os(name) else {
            continue;
        };
        let val = val.to_string_lossy().into_owned();
        if !val.contains(&dir) {
            continue;
        }
        let kept = without_dir(&val, &dir);
        if kept.is_empty() || *name == "LD_PRELOAD" {
            out.push((*name, None));
        } else {
            out.push((*name, Some(OsString::from(kept.join(":")))));
        }
    }
    out
}

/// Removes directories inside the AppImage from a list of search directories.
pub fn strip_appimage_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    match appimage_dir() {
        Some(dir) => dirs
            .into_iter()
            .filter(|d| !d.starts_with(Path::new(&dir)))
            .collect(),
        None => dirs,
    }
}

/// Applies `cleaned_env` to a std command.
pub fn clean_std(cmd: &mut std::process::Command) {
    for (name, value) in cleaned_env() {
        match value {
            Some(v) => {
                cmd.env(name, v);
            }
            None => {
                cmd.env_remove(name);
            }
        }
    }
}

/// Applies `cleaned_env` to a tokio command.
pub fn clean_tokio(cmd: &mut tokio::process::Command) {
    for (name, value) in cleaned_env() {
        match value {
            Some(v) => {
                cmd.env(name, v);
            }
            None => {
                cmd.env_remove(name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_entries_inside_the_image() {
        let kept = without_dir(
            "/tmp/.mount_X/usr/lib:/usr/local/lib::/tmp/.mount_X/usr/lib64",
            "/tmp/.mount_X",
        );
        assert_eq!(kept, vec!["/usr/local/lib".to_string()]);
    }
}
