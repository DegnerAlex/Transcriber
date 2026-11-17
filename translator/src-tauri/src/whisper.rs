//! Whisper (speech-to-text) engine built on whisper-rs.

use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Sample rate whisper.cpp expects.
pub const SAMPLE_RATE: u32 = 16_000;

/// Lazily loaded whisper model. The context stays alive once loaded;
/// a transcription state is created per run.
pub struct WhisperEngine {
    model: Mutex<Option<LoadedModel>>,
}

struct LoadedModel {
    path: PathBuf,
    ctx: WhisperContext,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub text: String,
    pub segments: usize,
}

impl Default for WhisperEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WhisperEngine {
    pub fn new() -> Self {
        Self {
            model: Mutex::new(None),
        }
    }

    /// Resolve the model file: explicit argument > WHISPER_MODEL_PATH env >
    /// conventional locations.
    fn resolve_model_path(explicit: Option<&str>) -> Result<PathBuf, String> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(path) = explicit {
            candidates.push(PathBuf::from(path));
        }
        if let Ok(env) = std::env::var("WHISPER_MODEL_PATH") {
            if !env.is_empty() {
                candidates.push(PathBuf::from(env));
            }
        }
        candidates.push(PathBuf::from("models/ggml-base.bin"));
        candidates.push(PathBuf::from("src-tauri/models/ggml-base.bin"));
        candidates.push(PathBuf::from("/srv/src-tauri/models/ggml-base.bin"));

        candidates
            .iter()
            .find(|path| path.is_file())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "whisper model not found; looked at: {}",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    }

    /// Load the model into `slot` if not loaded yet (or if an explicit
    /// different path is requested).
    fn load_into(
        slot: &mut Option<LoadedModel>,
        explicit: Option<&str>,
    ) -> Result<(), String> {
        let needs_reload = match slot.as_ref() {
            Some(loaded) => explicit.is_some_and(|path| Path::new(path) != loaded.path),
            None => true,
        };
        if !needs_reload {
            return Ok(());
        }
        let path = Self::resolve_model_path(explicit)?;
        println!("[whisper] loading model from {} ...", path.display());
        let started = std::time::Instant::now();
        let ctx =
            WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|e| format!("failed to load whisper model {}: {e}", path.display()))?;
        println!(
            "[whisper] model loaded in {:.1}s",
            started.elapsed().as_secs_f32()
        );
        *slot = Some(LoadedModel { path, ctx });
        Ok(())
    }

    /// Load the default model eagerly (called at app startup, off the main
    /// thread) so the first Transcribe click does not pay the load cost.
    pub fn preload(&self) -> Result<(), String> {
        let mut guard = self.model.lock().unwrap();
        Self::load_into(&mut guard, None)
    }

    /// Transcribe raw mono samples (16 kHz after [`resample_to_16k`]).
    /// The model lock is held for the whole run, serializing transcriptions.
    pub fn transcribe(
        &self,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<Transcription, String> {
        if samples.is_empty() {
            return Err("no audio captured yet — select a device and speak first".into());
        }
        let mut guard = self.model.lock().unwrap();
        Self::load_into(&mut guard, None)?;
        let loaded = guard.as_ref().unwrap();
        let mut state = loaded.ctx.create_state().map_err(|e| e.to_string())?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // whisper.cpp defaults to "en"; "auto" enables language detection.
        params.set_language(Some(language.unwrap_or("auto")));
        // Use all cores — whisper.cpp would otherwise only take 4 threads.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4);
        params.set_n_threads(threads);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state.full(params, samples).map_err(|e| e.to_string())?;

        let count = state.full_n_segments().max(0) as usize;
        let mut combined = String::new();
        for i in 0..count {
            if let Some(segment) = state.get_segment(i as i32) {
                if let Ok(text) = segment.to_str_lossy() {
                    combined.push_str(text.trim());
                    combined.push(' ');
                }
            }
        }
        Ok(Transcription {
            text: combined.trim().to_string(),
            segments: count,
        })
    }

    /// Language codes understood by whisper, as exposed by the whisper.cpp
    /// language table ("en", "ru", "de", ...). The table is static and shared
    /// by every model, so no context is required to read it.
    pub fn languages() -> Vec<String> {
        // SAFETY: whisper_lang_max_id/whisper_lang_str are pure table lookups
        // with no preconditions; the returned pointers point to static
        // NUL-terminated strings owned by whisper.cpp.
        let max = unsafe { whisper_rs_sys::whisper_lang_max_id() };
        let mut languages = Vec::with_capacity(max.max(0) as usize + 1);
        for id in 0..=max {
            let ptr = unsafe { whisper_rs_sys::whisper_lang_str(id) };
            if ptr.is_null() {
                continue;
            }
            languages.push(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned());
        }
        languages
    }
}

/// Linear-interpolation resampler to whisper's 16 kHz requirement.
pub fn resample_to_16k(samples: Vec<f32>, from_rate: u32) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || from_rate == 0 || samples.len() < 2 {
        return samples;
    }
    let ratio = SAMPLE_RATE as f64 / from_rate as f64;
    let out_len = ((samples.len() - 1) as f64 * ratio).floor() as usize + 1;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 / ratio;
        let i0 = position.floor() as usize;
        let i1 = (i0 + 1).min(samples.len() - 1);
        let frac = (position - i0 as f64) as f32;
        out.push(samples[i0] * (1.0 - frac) + samples[i1] * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_table_is_populated() {
        let languages = WhisperEngine::languages();
        println!("whisper languages: {}", languages.join(", "));
        assert!(languages.len() >= 90, "expected ~100 whisper languages");
        assert!(languages.iter().any(|l| l == "en"));
        assert!(languages.iter().any(|l| l == "ru"));
    }

    #[test]
    fn resample_48k_to_16k_sine() {
        // 1 s of 440 Hz sine at 48 kHz.
        let input: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin())
            .collect();
        let output = resample_to_16k(input, 48_000);
        assert_eq!(output.len(), 16_000);
        // Peaks of the downsampled sine must stay close to 1.0.
        let max = output.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(max > 0.9, "resampled sine lost amplitude: {max}");
    }

    #[test]
    fn resample_passthrough_for_16k() {
        let input = vec![0.1, -0.2, 0.3];
        assert_eq!(resample_to_16k(input.clone(), SAMPLE_RATE), input);
    }
}
