//! Inserting transcribed text into other applications: the text is placed
//! on the clipboard and pasted with Ctrl+V (enigo XTest). Per-key typing
//! broke on non-Latin keyboard layouts (the focused app interpreted the
//! keysyms of the wrong XKB group), while a paste is layout-independent.

use std::sync::Mutex;
use std::time::Duration;

/// Serializes typing sessions: concurrent type_text calls (e.g. auto-insert of
/// a new utterance while the previous one is still being typed) must not
/// interleave pastes.
static TYPE_LOCK: Mutex<()> = Mutex::new(());

/// Paste the given text into whatever window currently has keyboard focus.
/// Async so the work runs off the main thread and does not freeze the UI.
#[tauri::command]
pub async fn type_text(text: String) -> Result<(), String> {
    use arboard::Clipboard;
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    println!("[type] requested: {} chars", text.len());
    if text.trim().is_empty() {
        return Err("nothing to type".into());
    }
    let result = (|| -> Result<(), String> {
        let _guard = TYPE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        // Preserve the user's clipboard: put it back after the paste.
        let previous = clipboard.get_text().ok();
        clipboard.set_text(&text).map_err(|e| e.to_string())?;

        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;

        // Give the focused application a moment to read the clipboard
        // before the original content is put back.
        std::thread::sleep(Duration::from_millis(250));
        if let Some(previous) = previous {
            let _ = clipboard.set_text(&previous);
        }
        Ok(())
    })();
    match &result {
        Ok(()) => println!("[type] ok (paste)"),
        Err(err) => println!("[type] failed: {err}"),
    }
    result
}
