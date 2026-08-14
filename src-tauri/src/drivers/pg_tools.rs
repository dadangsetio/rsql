use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Bump when the pinned download source/version below changes, so a stale
/// cache from a previous app version doesn't get reused.
const TOOLS_VERSION: &str = "v1";
const PG_APP_VERSION: &str = "2.9.5";
const PG_MAJOR: &str = "17";
const PG_WIN_VERSION: &str = "16.4-1";

pub struct ToolPaths {
    pub pg_dump: PathBuf,
    pub pg_restore: PathBuf,
    pub psql: PathBuf,
}

impl ToolPaths {
    pub fn path_for(&self, program: &str) -> &Path {
        match program {
            "pg_dump" => &self.pg_dump,
            "pg_restore" => &self.pg_restore,
            _ => &self.psql,
        }
    }
}

fn tools_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_data_dir()
            .ok()?
            .join("pg-tools")
            .join(TOOLS_VERSION),
    )
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

// Binaries live in bin/ (not directly in `dir`) so macOS's
// `@loader_path/../lib/*.dylib` rpath - baked into the binaries themselves -
// resolves to a sibling lib/ directory instead of `dir`'s parent.
fn cached(dir: &Path) -> Option<ToolPaths> {
    let bin = dir.join("bin");
    let paths = ToolPaths {
        pg_dump: bin.join(exe_name("pg_dump")),
        pg_restore: bin.join(exe_name("pg_restore")),
        psql: bin.join(exe_name("psql")),
    };
    (paths.pg_dump.is_file() && paths.pg_restore.is_file() && paths.psql.is_file()).then_some(paths)
}

async fn run(program: &str, args: &[&str]) -> bool {
    tokio::process::Command::new(program)
        .args(args)
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn curl_download(url: &str, dest: &Path) -> bool {
    run("curl", &["-fsSL", "-o", &dest.to_string_lossy(), url]).await
}

/// macOS: Postgres.app ships a universal (arm64+x86_64), already-relocatable
/// build - pg_dump/pg_restore/psql resolve their dylibs via
/// `@loader_path/../lib/*.dylib`, so copying bin/ and lib/ as siblings (same
/// layout as inside Postgres.app) is enough to run them from anywhere.
async fn fetch_macos(dir: &Path, work: &Path, log: &impl Fn(&str)) -> bool {
    let dmg_url = format!(
        "https://github.com/PostgresApp/PostgresApp/releases/download/v{PG_APP_VERSION}/Postgres-{PG_APP_VERSION}-{PG_MAJOR}.dmg"
    );
    let dmg_path = work.join("postgres.dmg");
    let mount_point = work.join("mnt");

    log("Downloading PostgreSQL client tools (one-time, ~120MB)...");
    if !curl_download(&dmg_url, &dmg_path).await {
        return false;
    }

    if tokio::fs::create_dir_all(&mount_point).await.is_err() {
        return false;
    }
    log("Mounting disk image...");
    if !run(
        "hdiutil",
        &[
            "attach",
            &dmg_path.to_string_lossy(),
            "-nobrowse",
            "-quiet",
            "-mountpoint",
            &mount_point.to_string_lossy(),
        ],
    )
    .await
    {
        return false;
    }

    log("Copying files...");
    let version_dir = mount_point
        .join("Postgres.app/Contents/Versions")
        .join(PG_MAJOR);
    // bin/ and lib/ as siblings under `dir`, matching the layout inside
    // Postgres.app itself, since the binaries' baked-in rpath is
    // `@loader_path/../lib/*.dylib` (@loader_path = their own bin/ dir).
    let bin_dir = dir.join("bin");
    let lib_dir = dir.join("lib");
    let ok = async {
        tokio::fs::create_dir_all(&bin_dir).await.ok()?;
        tokio::fs::create_dir_all(&lib_dir).await.ok()?;

        for tool in ["pg_dump", "pg_restore", "psql"] {
            tokio::fs::copy(version_dir.join("bin").join(tool), bin_dir.join(tool))
                .await
                .ok()?;
        }
        for lib in [
            "libpq.5.dylib",
            "libssl.3.dylib",
            "libcrypto.3.dylib",
            "libzstd.1.dylib",
            "liblz4.1.dylib",
        ] {
            tokio::fs::copy(version_dir.join("lib").join(lib), lib_dir.join(lib))
                .await
                .ok()?;
        }
        Some(())
    }
    .await
    .is_some();

    run(
        "hdiutil",
        &["detach", &mount_point.to_string_lossy(), "-quiet"],
    )
    .await;

    if ok {
        for tool in ["pg_dump", "pg_restore", "psql"] {
            let _ = run("chmod", &["+x", &bin_dir.join(tool).to_string_lossy()]).await;
        }
    }
    ok
}

/// Windows: EDB's portable binaries zip. pg_dump/pg_restore/psql load their
/// DLLs from their own directory by default (standard Windows search order),
/// so extracting the exes and their DLL closure flat into the same folder is
/// enough - no rpath-equivalent needed.
async fn fetch_windows(dir: &Path, work: &Path, log: &impl Fn(&str)) -> bool {
    let zip_url = format!(
        "https://get.enterprisedb.com/postgresql/postgresql-{PG_WIN_VERSION}-windows-x64-binaries.zip"
    );
    let zip_path = work.join("pg.zip");

    log("Downloading PostgreSQL client tools (one-time, ~340MB)...");
    if !curl_download(&zip_url, &zip_path).await {
        return false;
    }

    log("Extracting files...");
    // DLLs pg_dump/pg_restore/psql import beyond the OS-provided set.
    let dlls = [
        "libpq.dll",
        "liblz4.dll",
        "libzstd.dll",
        "zlib1.dll",
        "libintl-9.dll",
        "libiconv-2.dll",
        "libwinpthread-1.dll",
        "libcrypto-3-x64.dll",
        "libssl-3-x64.dll",
    ];
    let mut members: Vec<String> = vec![
        "pgsql/bin/pg_dump.exe".into(),
        "pgsql/bin/pg_restore.exe".into(),
        "pgsql/bin/psql.exe".into(),
    ];
    members.extend(dlls.iter().map(|d| format!("pgsql/bin/{d}")));

    let mut tar_args: Vec<&str> = vec![
        "-xf",
        zip_path.to_str().unwrap_or_default(),
        "-C",
        work.to_str().unwrap_or_default(),
    ];
    tar_args.extend(members.iter().map(|m| m.as_str()));
    if !run("tar", &tar_args).await {
        return false;
    }

    let src_bin = work.join("pgsql").join("bin");
    // Same directory as the exes (not a sibling lib/ like macOS): Windows
    // searches the executable's own directory for DLLs by default.
    let bin_dir = dir.join("bin");
    if tokio::fs::create_dir_all(&bin_dir).await.is_err() {
        return false;
    }
    for tool in ["pg_dump.exe", "pg_restore.exe", "psql.exe"] {
        if tokio::fs::copy(src_bin.join(tool), bin_dir.join(tool))
            .await
            .is_err()
        {
            return false;
        }
    }
    for dll in dlls {
        if tokio::fs::copy(src_bin.join(dll), bin_dir.join(dll))
            .await
            .is_err()
        {
            return false;
        }
    }
    true
}

/// Downloads pg_dump/pg_restore/psql into the app data directory on first
/// use and reuses the cache after that. Emits progress as
/// `pg-dump-log-{job_id}` lines so the backup/restore modal's existing live
/// log shows the one-time setup. Returns `None` (never an error) when a
/// download isn't available for this platform/situation - callers fall back
/// to whatever's on the system PATH.
pub async fn ensure_pg_tools(app: &AppHandle, job_id: &str) -> Option<ToolPaths> {
    let dir = tools_dir(app)?;
    if let Some(paths) = cached(&dir) {
        return Some(paths);
    }
    // Linux has no portable, root-free source across distros (unlike
    // Postgres.app/EDB's zip) - rely on a system install there instead.
    if cfg!(target_os = "linux") {
        return None;
    }

    let event = format!("pg-dump-log-{job_id}");
    let log = |line: &str| {
        let _ = app.emit(&event, line.to_string());
    };

    let work = std::env::temp_dir().join(format!("rsql-pg-fetch-{job_id}"));
    if tokio::fs::create_dir_all(&dir).await.is_err()
        || tokio::fs::create_dir_all(&work).await.is_err()
    {
        return None;
    }

    let ok = if cfg!(target_os = "macos") {
        fetch_macos(&dir, &work, &log).await
    } else if cfg!(target_os = "windows") {
        fetch_windows(&dir, &work, &log).await
    } else {
        false
    };
    tokio::fs::remove_dir_all(&work).await.ok();

    if ok {
        log("PostgreSQL tools ready.");
        cached(&dir)
    } else {
        log("Could not download PostgreSQL tools automatically; trying a system install instead.");
        tokio::fs::remove_dir_all(&dir).await.ok();
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "downloads ~120MB from GitHub; run manually with `cargo test -- --ignored fetch_macos`"]
    #[cfg(target_os = "macos")]
    async fn fetch_macos_downloads_tools_that_actually_run() {
        let base = std::env::temp_dir().join("rsql-pg-tools-test");
        let dir = base.join("dir");
        let work = base.join("work");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::create_dir_all(&work).await.unwrap();

        let log = |line: &str| println!("{line}");
        assert!(
            fetch_macos(&dir, &work, &log).await,
            "fetch_macos should succeed"
        );

        let paths = cached(&dir).expect("cached() should find the tools fetch_macos just wrote");
        for path in [&paths.pg_dump, &paths.pg_restore, &paths.psql] {
            let output = std::process::Command::new(path)
                .arg("--version")
                .env_clear()
                .output()
                .unwrap_or_else(|e| panic!("{path:?} --version failed to spawn: {e}"));
            assert!(
                output.status.success(),
                "{path:?} --version exited non-zero"
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("PostgreSQL"));
        }

        tokio::fs::remove_dir_all(&base).await.ok();
    }
}
