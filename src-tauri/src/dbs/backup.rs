use crate::AppState;
use crate::common::enums::AppError;
use tauri::{Result, State};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_backup(dest_path: String, app_state: State<'_, AppState>) -> Result<()> {
    let conn = app_state
        .local_db
        .connect()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    // VACUUM INTO writes a consistent snapshot without blocking the live connection.
    conn.execute("VACUUM INTO ?1", libsql::params![dest_path])
        .await
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_restore(src_path: String, app_state: State<'_, AppState>) -> Result<()> {
    // Reject anything that isn't actually an RSQL database before overwriting the live one.
    let check_db = libsql::Builder::new_local(&src_path)
        .build()
        .await
        .map_err(|e| AppError::DatabaseError(format!("Invalid backup file: {e}")))?;
    check_db
        .connect()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .query("SELECT 1 FROM projects LIMIT 1", ())
        .await
        .map_err(|e| AppError::DatabaseError(format!("Not an RSQL backup file: {e}")))?;

    // ponytail: copies over the live file while the app's connection is still open; safe on
    // Unix, may fail on Windows if the file is locked. Restore requires an app relaunch right
    // after, so this isn't hit mid-query. Upgrade to a close/reopen of local_db if that changes.
    std::fs::copy(&src_path, &app_state.db_path)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    Ok(())
}
