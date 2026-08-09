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

async fn project_conn_info(app_state: &AppState, project_id: &str) -> std::result::Result<ConnInfo, AppError> {
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

#[derive(serde::Deserialize)]
pub struct PgDumpOptions {
    pub format: String,       // "custom" | "plain" | "tar"
    pub extra_args: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct PgRestoreOptions {
    pub source_format: String, // "archive" | "plain"
    pub extra_args: Vec<String>,
}

/// Runs `cmd`, forwarding each stdout/stderr line to the frontend as a
/// `pg-dump-log-{job_id}` event so the backup/restore modal can show a live log.
async fn run_streamed(app: &AppHandle, job_id: &str, mut cmd: Command) -> std::result::Result<(), AppError> {
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

    let mut cmd = Command::new("pg_dump");
    cmd.env("PGPASSWORD", &c.password)
        .env("PGSSLMODE", if c.ssl { "require" } else { "prefer" })
        .args(["-h", &c.host, "-p", &c.port, "-U", &c.user, "-d", &c.database])
        .args([
            "-F",
            match options.format.as_str() {
                "plain" => "p",
                "tar" => "t",
                _ => "c",
            },
        ])
        .args(&options.extra_args)
        .args(["-f", &dest_path]);

    run_streamed(&app, &job_id, cmd).await?;
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

    let mut cmd = if options.source_format == "plain" {
        // Plain-format dumps are SQL scripts meant for psql, not pg_restore.
        let mut cmd = Command::new("psql");
        cmd.args([
            "-v", "ON_ERROR_STOP=1",
            "-h", &c.host, "-p", &c.port, "-U", &c.user, "-d", &c.database,
        ])
        .args(&options.extra_args)
        .args(["-f", &src_path]);
        cmd
    } else {
        let mut cmd = Command::new("pg_restore");
        cmd.args(["-h", &c.host, "-p", &c.port, "-U", &c.user, "-d", &c.database])
            .args(&options.extra_args)
            .arg(&src_path);
        cmd
    };
    cmd.env("PGPASSWORD", &c.password)
        .env("PGSSLMODE", if c.ssl { "require" } else { "prefer" });

    run_streamed(&app, &job_id, cmd).await?;
    Ok(())
}
