use super::pg_tools;
use crate::AppState;
use crate::common::enums::AppError;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Result, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

struct ConnInfo {
    user: String,
    password: String,
    database: String,
    host: String,
    port: String,
    ssl: bool,
}

async fn project_conn_info(
    app_state: &AppState,
    project_id: &str,
) -> std::result::Result<ConnInfo, AppError> {
    let conn = app_state
        .local_db
        .connect()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let mut rows = conn
        .query(
            "SELECT username, password, database, host, port, ssl FROM projects WHERE id = ?1",
            libsql::params![project_id],
        )
        .await
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let row = rows
        .next()
        .await
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;

    let (host, port): (String, String) = (
        row.get::<String>(3).unwrap_or_default(),
        row.get::<String>(4).unwrap_or_default(),
    );

    // Route through the active SSH tunnel (if any) instead of the raw host/port,
    // matching how the app's own Postgres pool connects.
    let (host, port) = match app_state.ssh_tunnels.lock().await.get(project_id) {
        Some(tunnel) => ("127.0.0.1".to_string(), tunnel.local_port.to_string()),
        None => (host, port),
    };

    Ok(ConnInfo {
        user: row.get::<String>(0).unwrap_or_default(),
        password: row.get::<String>(1).unwrap_or_default(),
        database: row.get::<String>(2).unwrap_or_default(),
        host,
        port,
        ssl: row.get::<String>(5).map(|s| s == "true").unwrap_or(false),
    })
}

fn extract_marked(text: &str, marker: &str) -> Option<String> {
    let start = text.find(marker)? + marker.len();
    let end = text[start..].find(marker)?;
    Some(text[start..start + end].to_string())
}

// GUI apps on macOS/Linux don't inherit PATH from .zshrc/.profile, so Homebrew or
// Postgres.app installs of pg_dump/pg_restore/psql go unseen. Ask the user's login
// shell what its PATH is and merge it in before spawning.
#[cfg(unix)]
fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let marker = "___RSQL_PATH___";
    let out = std::process::Command::new(&shell)
        .args(["-ilc", &format!("echo {marker}$PATH{marker}")])
        .output()
        .ok()?;
    extract_marked(&String::from_utf8_lossy(&out.stdout), marker)
}

#[cfg(not(unix))]
fn shell_path() -> Option<String> {
    None
}

fn apply_shell_path(cmd: &mut Command) {
    if let Some(shell_path) = shell_path() {
        let current = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{shell_path}:{current}"));
    }
}

#[cfg(test)]
mod tests {
    use super::extract_marked;

    #[test]
    fn extract_marked_pulls_value_between_markers() {
        let out = "some banner\n#M#/usr/bin:/bin#M#\nmore noise\n";
        assert_eq!(
            extract_marked(out, "#M#"),
            Some("/usr/bin:/bin".to_string())
        );
        assert_eq!(extract_marked("no markers here", "#M#"), None);
    }
}

#[derive(serde::Deserialize)]
pub struct PgDumpOptions {
    pub format: String, // "custom" | "plain" | "tar"
    pub extra_args: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct PgRestoreOptions {
    pub source_format: String, // "archive" | "plain"
    pub extra_args: Vec<String>,
}

/// A pg_dump/pg_restore/psql invocation, deferred so the caller (below) can
/// pick between a downloaded copy and a system-PATH binary before spawning.
struct PgInvocation {
    program: &'static str,
    args: Vec<String>,
    envs: Vec<(String, String)>,
}

/// Runs `cmd`, forwarding each stdout/stderr line to the frontend as a
/// `pg-dump-log-{job_id}` event so the backup/restore modal can show a live log.
async fn run_streamed(
    app: &AppHandle,
    job_id: &str,
    mut cmd: Command,
) -> std::result::Result<(), AppError> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::DatabaseError(format!(
                "{e}. Install the PostgreSQL client tools (pg_dump/pg_restore/psql) to use backup/restore."
            ))
        } else {
            AppError::DatabaseError(e.to_string())
        }
    })?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let event = format!("pg-dump-log-{job_id}");

    let out_app = app.clone();
    let out_event = event.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = out_app.emit(&out_event, line);
        }
    });

    let err_app = app.clone();
    let err_event = event.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = err_app.emit(&err_event, line.clone());
            collected.push(line);
        }
        collected
    });

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let _ = stdout_task.await;
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let tail = stderr_lines
            .iter()
            .rev()
            .take(5)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        return Err(AppError::DatabaseError(format!(
            "Process exited with {status}: {tail}"
        )));
    }
    Ok(())
}

/// Prefers a pg_dump/pg_restore/psql downloaded on first use (see
/// `pg_tools::ensure_pg_tools`, cached under the app data directory) so
/// backup/restore works without a system PostgreSQL install. Falls back to
/// a system-PATH binary when a download isn't available for this platform
/// or failed (no network, disk full, ...).
async fn run_pg_tool(
    app: &AppHandle,
    job_id: &str,
    inv: PgInvocation,
) -> std::result::Result<(), AppError> {
    let mut cmd = match pg_tools::ensure_pg_tools(app, job_id).await {
        Some(paths) => Command::new(paths.path_for(inv.program)),
        None => {
            let mut cmd = Command::new(inv.program);
            apply_shell_path(&mut cmd);
            cmd
        }
    };
    cmd.args(&inv.args).envs(inv.envs);
    run_streamed(app, job_id, cmd).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pgsql_backup(
    project_id: String,
    dest_path: String,
    options: PgDumpOptions,
    job_id: String,
    app: AppHandle,
    app_state: State<'_, AppState>,
) -> Result<()> {
    let c = project_conn_info(&app_state, &project_id).await?;

    let mut args = vec![
        "-h".to_string(),
        c.host,
        "-p".to_string(),
        c.port,
        "-U".to_string(),
        c.user,
        "-d".to_string(),
        c.database,
        "-F".to_string(),
        match options.format.as_str() {
            "plain" => "p",
            "tar" => "t",
            _ => "c",
        }
        .to_string(),
    ];
    args.extend(options.extra_args);
    args.extend(["-f".to_string(), dest_path]);

    let envs = vec![
        ("PGPASSWORD".to_string(), c.password),
        (
            "PGSSLMODE".to_string(),
            if c.ssl { "require" } else { "prefer" }.to_string(),
        ),
    ];

    run_pg_tool(
        &app,
        &job_id,
        PgInvocation {
            program: "pg_dump",
            args,
            envs,
        },
    )
    .await?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pgsql_restore(
    project_id: String,
    src_path: String,
    options: PgRestoreOptions,
    job_id: String,
    app: AppHandle,
    app_state: State<'_, AppState>,
) -> Result<()> {
    let c = project_conn_info(&app_state, &project_id).await?;

    // Drop the cached pool first: restore needs to lock/drop objects, and stale
    // idle connections from our own pool can stand in its way.
    app_state.clients.lock().await.remove(&project_id);
    app_state.meta_clients.lock().await.remove(&project_id);

    let program = if options.source_format == "plain" {
        "psql"
    } else {
        "pg_restore"
    };
    let mut args = if options.source_format == "plain" {
        // Plain-format dumps are SQL scripts meant for psql, not pg_restore.
        vec!["-v".to_string(), "ON_ERROR_STOP=1".to_string()]
    } else {
        Vec::new()
    };
    args.extend([
        "-h".to_string(),
        c.host,
        "-p".to_string(),
        c.port,
        "-U".to_string(),
        c.user,
        "-d".to_string(),
        c.database,
    ]);
    args.extend(options.extra_args);
    args.extend(if options.source_format == "plain" {
        vec!["-f".to_string(), src_path]
    } else {
        vec![src_path]
    });

    let envs = vec![
        ("PGPASSWORD".to_string(), c.password),
        (
            "PGSSLMODE".to_string(),
            if c.ssl { "require" } else { "prefer" }.to_string(),
        ),
    ];

    run_pg_tool(
        &app,
        &job_id,
        PgInvocation {
            program,
            args,
            envs,
        },
    )
    .await?;
    Ok(())
}
