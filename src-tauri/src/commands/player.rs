use tauri::command;

use crate::player;
use crate::AppError;

#[command]
pub async fn native_play(file_id: String, position: Option<f64>, ext: Option<String>, duration: Option<f64>) -> Result<(), AppError> {
    player::cmd_play(file_id, position, ext, duration).await.map_err(AppError::Other)
}

#[command]
pub async fn native_pause() -> Result<(), AppError> {
    player::cmd_pause().map_err(AppError::Other)
}

#[command]
pub async fn native_resume() -> Result<(), AppError> {
    player::cmd_resume().map_err(AppError::Other)
}

#[command]
pub async fn native_seek(position: f64) -> Result<(), AppError> {
    player::cmd_seek(position).await.map_err(AppError::Other)
}

#[command]
pub async fn native_set_volume(volume: f64) -> Result<(), AppError> {
    player::cmd_set_volume(volume).map_err(AppError::Other)
}

#[command]
pub async fn native_stop() -> Result<(), AppError> {
    player::cmd_stop().map_err(AppError::Other)
}

#[command]
pub async fn native_get_playback_state() -> Result<serde_json::Value, AppError> {
    player::cmd_get_state().map_err(AppError::Other)
}
