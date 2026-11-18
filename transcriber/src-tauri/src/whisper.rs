//! Whisper (speech-to-text) engine built on whisper-rs.

use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Sample rate whisper.cpp expects.
pub const SAMPLE_RATE: u32 = 16_000;

/// Known directories that may contain whisper ggml model files.
const MODEL_DIRS: [&str; 3] = ["models", "src-tauri/models", "/srv/src-tauri/models"];
/// Preference order when several models are present (best first).
const PREFERRED: [&str; 5] = [
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-medium-q5_0.bin",
    "ggml-small-q5_1.bin",
    "ggml-base.bin",
];

/// Lazily loaded whisper model. The context stays alive once loaded;
/// a transcription state is created per run.
pub struct WhisperEngine {
    model: Mutex<Option<LoadedModel>>,
    /// Model file explicitly chosen in the UI. Once set it wins over the
    /// env/default resolution on every transcription.
    selected: Mutex<Option<String>>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// File name of the model, e.g. "ggml-small-q5_1.bin".
    pub name: String,
    /// True when this model is the one currently loaded.
    pub active: bool,
}

impl Default for WhisperEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WhisperEngine {
    /// Directories scanned for ggml models. The exe-relative dir covers the
    /// AppImage layout (the binary is at AppDir/usr/bin, the models are
    /// bundled at AppDir/usr/bin/models).
    fn model_dirs() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = MODEL_DIRS.iter().map(PathBuf::from).collect();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                dirs.insert(0, exe_dir.join("models"));
            }
        }
        dirs
    }

    pub fn new() -> Self {
        Self {
            model: Mutex::new(None),
            selected: Mutex::new(None),
        }
    }

    /// Resolve the model file: explicit argument > WHISPER_MODEL_PATH env >
    /// conventional locations, preferring the most accurate model available.
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
        // Next to the executable (covers the AppImage layout: the binary is
        // at AppDir/usr/bin, the models are bundled at AppDir/usr/bin/models).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                for name in PREFERRED {
                    candidates.push(exe_dir.join("models").join(name));
                }
            }
        }
        for name in PREFERRED {
            for dir in Self::model_dirs() {
                candidates.push(dir.join(name));
            }
        }

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

    /// True when NVIDIA CUDA device nodes are exposed to this process (they
    /// are injected by nvidia-container-toolkit). Without them the CUDA
    /// backend cannot initialize, so we ask whisper to run on the CPU
    /// instead. If the GPU disappears later or CUDA init fails at runtime,
    /// ggml also falls back to CPU on its own.
    fn gpu_available() -> bool {
        Self::backend_kind() != "cpu"
    }

    /// Which GPU stack is present: "cuda" (NVIDIA device nodes), "vulkan"
    /// (AMD/Intel — ROCm kernel node + a Vulkan ICD installed), or "cpu".
    fn backend_kind() -> &'static str {
        if Path::new("/dev/nvidia-uvm").exists() && Path::new("/dev/nvidiactl").exists() {
            return "cuda";
        }
        // AMD and Intel expose their GPUs through /dev/kfd (ROCm/DRM); a
        // Vulkan ICD (RADV from Mesa, or the vendor driver) must be
        // installed for ggml-vulkan to find a device.
        if Path::new("/dev/kfd").exists() {
            return "vulkan";
        }
        "cpu"
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
        let use_gpu = Self::gpu_available();
        println!(
            "[whisper] loading model from {} ({}) ...",
            path.display(),
            match Self::backend_kind() {
                "cuda" => "GPU (CUDA)",
                "vulkan" => "GPU (Vulkan)",
                _ => "CPU fallback",
            }
        );
        let started = std::time::Instant::now();
        let ctx = WhisperContext::new_with_params(
            &path,
            WhisperContextParameters {
                use_gpu,
                ..Default::default()
            },
        )
        .map_err(|e| format!("failed to load whisper model {}: {e}", path.display()))?;
        println!(
            "[whisper] model loaded in {:.1}s",
            started.elapsed().as_secs_f32()
        );
        *slot = Some(LoadedModel { path, ctx });
        Ok(())
    }

    /// Transcription backend reported to the UI: "cuda", "vulkan" or
    /// "cpu". Fixed at startup — the backend cannot change while the
    /// process is running.
    pub fn backend(&self) -> &'static str {
        Self::backend_kind()
    }

    /// Load the default model eagerly (called at app startup, off the main
    /// thread) so the first transcription does not pay the load cost.
    pub fn preload(&self) -> Result<(), String> {
        let mut guard = self.model.lock().unwrap();
        Self::load_into(&mut guard, self.selected.lock().unwrap().as_deref())
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
        let selected = self.selected.lock().unwrap().clone();
        Self::load_into(&mut guard, selected.as_deref())?;
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

    /// ggml model files found in the known model directories, sorted best
    /// first. `active` marks the model currently loaded.
    pub fn available_models(&self) -> Vec<ModelOption> {
        let loaded_name = self
            .model
            .lock()
            .unwrap()
            .as_ref()
            .map(|loaded| {
                loaded
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        let mut found: Vec<String> = Vec::new();
        for dir in Self::model_dirs() {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("ggml-")
                    && name.ends_with(".bin")
                    && !found.contains(&name)
                {
                    found.push(name);
                }
            }
        }
        // Best models first, the rest alphabetically after them.
        found.sort_by(|a, b| {
            let rank = |name: &str| {
                PREFERRED
                    .iter()
                    .position(|p| *p == name)
                    .unwrap_or(usize::MAX)
            };
            rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
        });

        found
            .into_iter()
            .map(|name| ModelOption {
                active: name == loaded_name,
                name,
            })
            .collect()
    }

    /// Switch the transcription model at runtime. Reloads the context if the
    /// requested model differs from the loaded one, and remembers the choice
    /// so subsequent transcriptions keep using it.
    pub fn select_model(&self, name: &str) -> Result<(), String> {
        if !name.starts_with("ggml-") || !name.ends_with(".bin") {
            return Err(format!("invalid model name: {name}"));
        }
        for dir in Self::model_dirs() {
            let path = dir.join(name);
            if path.is_file() {
                let mut guard = self.model.lock().unwrap();
                let path_str = path.to_string_lossy().into_owned();
                Self::load_into(&mut guard, Some(path_str.as_str()))?;
                *self.selected.lock().unwrap() = Some(path_str);
                println!("[whisper] model switched to {name}");
                return Ok(());
            }
        }
        Err(format!("model file not found: {name}"))
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
