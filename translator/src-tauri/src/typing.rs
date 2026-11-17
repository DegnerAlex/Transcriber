//! Typing transcribed text into other applications via enigo (X11 XTest).

use std::sync::Mutex;

use tauri::State;

/// Serializes typing sessions: concurrent type_text calls (e.g. auto-insert of
/// a new utterance while the previous one is still being typed) must not
/// interleave keystrokes.
static TYPE_LOCK: Mutex<()> = Mutex::new(());

/// Type the given text into whatever window currently has keyboard focus,
/// using enigo's X11 (XTest) backend. Async so long typing sessions run off
/// the main thread and do not freeze the UI.
#[tauri::command]
pub async fn type_text(text: String) -> Result<(), String> {
    use enigo::{Enigo, Keyboard, Settings};

    println!("[type] requested: {} chars", text.len());
    if text.trim().is_empty() {
        return Err("nothing to type".into());
    }
    let result = (|| -> Result<(), String> {
        let _guard = TYPE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.text(&text).map_err(|e| e.to_string())
    })();
    match &result {
        Ok(()) => println!("[type] ok"),
        Err(err) => println!("[type] failed: {err}"),
    }
    result
}
