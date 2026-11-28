//! Desktop IPC for the shared AI providers.

use crate::error::AppResult;
pub use core::{AiModels, AiProviderStatus, AiRequest, AiResult, AiState};
use datatrip_core::ai as core;
use tauri::State;

#[tauri::command]
pub async fn ai_providers(state: State<'_, AiState>) -> AppResult<Vec<AiProviderStatus>> {
    core::ai_providers(&state).await
}

#[tauri::command]
pub async fn ai_generate(state: State<'_, AiState>, request: AiRequest) -> AppResult<AiResult> {
    core::ai_generate(&state, request).await
}

#[tauri::command]
pub async fn ai_models(
    state: State<'_, AiState>,
    provider: String,
    base_url: Option<String>,
    refresh: Option<bool>,
) -> AppResult<AiModels> {
    core::ai_models(&state, provider, base_url, refresh).await
}

#[tauri::command]
pub async fn ai_cancel(state: State<'_, AiState>) -> AppResult<()> {
    core::ai_cancel(&state).await
}

#[tauri::command]
pub async fn ai_set_api_key(state: State<'_, AiState>, key: Option<String>) -> AppResult<()> {
    core::ai_set_api_key(&state, key).await
}
