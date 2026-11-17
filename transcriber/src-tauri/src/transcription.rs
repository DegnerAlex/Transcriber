//! Transcription pipeline: the utterance worker that feeds VAD output to
//! whisper, plus commands for language and model selection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{AudioMonitor, MonitorBuffer, VadState};
use crate::whisper::WhisperEngine;

/// Re-exported for the frontend-facing command signatures.
pub use crate::whisper::ModelOption;

/// How often the live (partial) transcription of the growing utterance is
/// refreshed while the user is still speaking.
const TRANSCRIBE_PARTIAL_INTERVAL_MS: u64 = 2000;
/// An utterance shorter than this is not worth a partial pass.
const TRANSCRIBE_PARTIAL_MIN_SECONDS: u32 = 1;

/// Background worker: transcribes utterances handed over by the audio
/// callback's VAD and pushes the results to the frontend as events.
///
/// While the user is still speaking, the worker also emits periodic
/// "transcription-partial" events with a live draft of the growing utterance,
/// so text appears on screen without waiting for the phrase to end.
pub fn spawn_transcription_worker(
    utterances: mpsc::Receiver<(Vec<f32>, u32)>,
    engine: Arc<WhisperEngine>,
    language: Arc<Mutex<String>>,
    vad: Arc<Mutex<VadState>>,
    buffer: Arc<MonitorBuffer>,
    generation: Arc<AtomicU64>,
    my_generation: u64,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let mut last_partial_len = 0usize;
        let mut last_partial_at = Instant::now();
        loop {
            // A newer monitor session replaced this one — stop immediately.
            if generation.load(Ordering::Relaxed) != my_generation {
                break;
            }
            match utterances.recv_timeout(Duration::from_millis(250)) {
                Ok((samples, rate)) => {
                    // The phrase is finished — transcribe it fully and let the
                    // frontend replace any partial draft with the final text.
                    last_partial_len = 0;
                    let resampled = crate::whisper::resample_to_16k(samples, rate);
                    let language = language.lock().unwrap().clone();
                    let started = Instant::now();
                    match engine.transcribe(&resampled, Some(&language)) {
                        Ok(result) => {
                            println!(
                                "[whisper] final in {:.1}s ({} segments): {}",
                                started.elapsed().as_secs_f32(),
                                result.segments,
                                result.text
                            );
                            let _ = app.emit("transcription", result);
                        }
                        Err(err) => {
                            println!("[whisper] auto failed: {err}");
                            let _ = app.emit("transcription-error", err);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Not finished yet — emit a partial draft if there is
                    // enough fresh audio and enough time has passed.
                    if last_partial_at.elapsed()
                        < Duration::from_millis(TRANSCRIBE_PARTIAL_INTERVAL_MS)
                    {
                        continue;
                    }
                    let utterance = {
                        let mut vad_state = vad.lock().unwrap();
                        if !vad_state.speaking {
                            if !vad_state.utterance.is_empty() {
                                vad_state.utterance.clear();
                            }
                            // Silence already won (callback finalizes on its
                            // own); nothing live to transcribe right now.
                            continue;
                        }
                        vad_state.utterance.clone()
                    };
                    let rate = buffer.sample_rate_value();
                    let min_samples =
                        TRANSCRIBE_PARTIAL_MIN_SECONDS as usize * rate as usize;
                    if utterance.len() <= last_partial_len || utterance.len() < min_samples {
                        continue;
                    }
                    let resampled = crate::whisper::resample_to_16k(utterance.clone(), rate);
                    let language = language.lock().unwrap().clone();
                    let started = Instant::now();
                    match engine.transcribe(&resampled, Some(&language)) {
                        Ok(result) => {
                            println!(
                                "[whisper] partial in {:.1}s: {}",
                                started.elapsed().as_secs_f32(),
                                result.text
                            );
                            last_partial_len = utterance.len();
                            last_partial_at = Instant::now();
                            let _ = app.emit("transcription-partial", result);
                        }
                        Err(err) => {
                            println!("[whisper] partial failed: {err}");
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

/// Set the language used for automatic transcription (e.g. "auto", "en", "ru").
#[tauri::command]
pub fn set_transcription_language(state: State<'_, AudioMonitor>, language: String) {
    *state.language.lock().unwrap() = language;
}

/// All language codes the current whisper build understands, for the UI
/// language picker ("auto" is a UI-level pseudo option, not in the table).
#[tauri::command]
pub fn list_transcription_languages() -> Vec<String> {
    crate::whisper::WhisperEngine::languages()
}

/// The transcription backend in use: "gpu" (CUDA) or "cpu".
#[tauri::command]
pub fn get_transcription_backend(engine: State<'_, Arc<WhisperEngine>>) -> String {
    engine.backend().to_string()
}

/// ggml models present in the model directories, with the loaded one marked.
#[tauri::command]
pub fn list_available_models(engine: State<'_, Arc<WhisperEngine>>) -> Vec<ModelOption> {
    engine.available_models()
}

/// Persist the transcript to a JSON file in the app data directory. The
/// directory is mounted as a docker volume, so the transcript survives
/// container recreation (webview localStorage does not).
#[tauri::command]
pub fn save_transcript(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("transcript.json");
    let json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
    std::fs::write(file, json).map_err(|e| e.to_string())
}

/// Load the persisted transcript (empty when the file does not exist yet).
#[tauri::command]
pub fn load_transcript(app: AppHandle) -> Vec<String> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    std::fs::read_to_string(dir.join("transcript.json"))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

/// Persist the UI settings (a key → value map) to `settings.json` next to
/// the transcript. Replaces webview localStorage: in the packaged app its
/// storage for the `tauri://localhost` origin does not reliably survive
/// restarts, while this file does (and it is identical in dev and release).
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), json).map_err(|e| e.to_string())
}

/// Load the persisted UI settings (an empty map when the file does not
/// exist yet).
#[tauri::command]
pub fn load_settings(
    app: AppHandle,
) -> std::collections::HashMap<String, serde_json::Value> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Default::default();
    };
    std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

/// Switch the transcription model at runtime (reloads the context).
#[tauri::command]
pub async fn select_transcription_model(
    engine: State<'_, Arc<WhisperEngine>>,
    name: String,
) -> Result<(), String> {
    // Blocking reload — keep it off the main thread like transcription itself.
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.select_model(&name))
        .await
        .map_err(|e| e.to_string())?
}
