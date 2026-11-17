//! translator — Tauri backend.
//!
//! Functionality is split into focused modules:
//! - [`audio`] — input device enumeration and the live capture monitor
//!   (levels, gain, VAD slicing);
//! - [`transcription`] — the whisper pipeline (utterance worker, language and
//!   model selection);
//! - [`typing`] — inserting transcribed text into other applications;
//! - [`whisper`] — the whisper.cpp engine itself.

mod audio;
mod transcription;
mod typing;
mod whisper;

use tauri::Manager;

/// Forward a debug message from the webview to the container stdout.
#[tauri::command]
fn debug_log(message: String) {
    println!("[ui] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(audio::AudioMonitor::default())
        .manage(std::sync::Arc::new(whisper::WhisperEngine::new()))
        .setup(|app| {
            // Warm up the whisper model in the background so the first
            // automatic transcription does not include the model load time.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let engine = handle.state::<std::sync::Arc<whisper::WhisperEngine>>();
                if let Err(err) = engine.preload() {
                    println!("[whisper] preload failed: {err}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::list_audio_input_devices,
            audio::list_audio_output_devices,
            audio::start_audio_monitor,
            audio::stop_audio_monitor,
            audio::set_audio_monitor_gain,
            audio::get_active_monitor,
            transcription::set_transcription_language,
            transcription::list_transcription_languages,
            transcription::list_available_models,
            transcription::save_transcript,
            transcription::load_transcript,
            transcription::select_transcription_model,
            typing::type_text,
            debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
