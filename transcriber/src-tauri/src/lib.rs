// Copyright 2026 Alex Degner (alex@ergofox.me)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
    // WebKit's DMABUF renderer hangs WebGL context creation on native
    // Wayland; keep accelerated compositing but use the shared-memory path
    // instead, so pixi.js (the waveform) initializes reliably. Only applied
    // when the user has not chosen a value explicitly.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
    {
        // SAFETY: single-threaded at this point — the GTK/WebKit environment
        // is read later, when tauri initializes its event loop.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
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
            transcription::get_transcription_backend,
            transcription::list_available_models,
            transcription::save_transcript,
            transcription::load_transcript,
            transcription::pick_transcript_file,
            transcription::write_transcript_file,
            transcription::save_settings,
            transcription::load_settings,
            transcription::select_transcription_model,
            typing::type_text,
            debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
