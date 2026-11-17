use serde::Serialize;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample, Stream};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::whisper::{Transcription, WhisperEngine};

mod whisper;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    /// Human-readable device name.
    pub name: String,
    /// ALSA PCM route behind this device, e.g. "plughw:CARD=4,DEV=0".
    pub driver: Option<String>,
    /// Manufacturer/vendor, when reported by the host.
    pub manufacturer: Option<String>,
    /// Device kind, e.g. "Microphone", "Headset", "Virtual", ...
    pub device_type: String,
    /// Connection type, e.g. "BuiltIn", "Usb", "Bluetooth", "Hdmi", ...
    pub interface: String,
    /// True when this is the host default input device.
    pub is_default: bool,
    /// Config the host picked as the device default, when available.
    pub default_config: Option<AudioInputConfig>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputConfig {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_format: String,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
/// Enumerate every capture (input) device visible to the default cpal host.
///
/// ALSA exposes many PCM aliases per physical card (default, sysdefault,
/// front, surround, iec958, hw, plughw, ...) that all share the card's
/// human-readable name. They are collapsed here into one entry per name,
/// preferring the `plughw` route because it performs automatic format
/// conversion and is the most forgiving one to open.
#[tauri::command]
fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    let host = cpal::default_host();
    let default_device = host.default_input_device();

    let mut devices: Vec<AudioInputDevice> = Vec::new();
    let mut index_by_name: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    for device in host
        .input_devices()
        .map_err(|e| format!("failed to enumerate input devices: {e}"))?
    {
        let description = device.description().map_err(|e| e.to_string())?;
        // Skip the ALSA "null" pseudo device: it only generates silence and
        // is useful for tests, not for picking a microphone.
        if description.driver() == Some("null") {
            continue;
        }
        let name = description.name().to_string();
        let is_default = default_device.as_ref() == Some(&device);
        let default_config = device.default_input_config().ok().map(|c| AudioInputConfig {
            channels: c.channels(),
            sample_rate: c.sample_rate(),
            sample_format: format!("{:?}", c.sample_format()),
        });
        let entry = AudioInputDevice {
            name: name.clone(),
            driver: description.driver().map(str::to_string),
            manufacturer: description.manufacturer().map(str::to_string),
            device_type: format!("{:?}", description.device_type()),
            interface: format!("{:?}", description.interface_type()),
            is_default,
            default_config,
        };

        match index_by_name.get(&name) {
            Some(&index) => {
                let prefer_new = entry.driver.as_deref().is_some_and(|d| d.starts_with("plughw"))
                    && !devices[index]
                        .driver
                        .as_deref()
                        .is_some_and(|d| d.starts_with("plughw"));
                if prefer_new {
                    // Keep the "default" flag even when swapping the route.
                    let mut entry = entry;
                    entry.is_default |= devices[index].is_default;
                    devices[index] = entry;
                } else {
                    devices[index].is_default |= is_default;
                }
            }
            None => {
                index_by_name.insert(name, devices.len());
                devices.push(entry);
            }
        }
    }

    Ok(devices)
}

/// Live audio level update pushed to the frontend while monitoring a device.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioLevelUpdate {
    /// Peak amplitude (0..=1) per callback chunk (~5-20 ms each).
    peaks: Vec<f32>,
    /// RMS amplitude (0..=1) over the same window.
    rms: f32,
}

/// Converts a raw sample to a normalized f32 in -1..=1.
trait SampleToF32: SizedSample {
    fn to_f32(self) -> f32;
}
impl SampleToF32 for f32 {
    fn to_f32(self) -> f32 {
        self.clamp(-1.0, 1.0)
    }
}
impl SampleToF32 for i8 {
    fn to_f32(self) -> f32 {
        self as f32 / 128.0
    }
}
impl SampleToF32 for i16 {
    fn to_f32(self) -> f32 {
        self as f32 / 32768.0
    }
}
impl SampleToF32 for i32 {
    fn to_f32(self) -> f32 {
        self as f32 / i32::MAX as f32
    }
}
impl SampleToF32 for u8 {
    fn to_f32(self) -> f32 {
        (self as f32 - 128.0) / 128.0
    }
}
impl SampleToF32 for u16 {
    fn to_f32(self) -> f32 {
        (self as f32 - 32768.0) / 32768.0
    }
}

/// Collects per-chunk peaks and emits them to the frontend in small batches
/// (~20 ms) so the event rate stays reasonable.
struct LevelAccumulator {
    peaks: Vec<f32>,
    squared_sum: f64,
    samples: usize,
    last_emit: Instant,
}

impl LevelAccumulator {
    fn new() -> Self {
        Self {
            peaks: Vec::new(),
            squared_sum: 0.0,
            samples: 0,
            last_emit: Instant::now(),
        }
    }

    fn push(&mut self, chunk: &[f32]) {
        if chunk.is_empty() {
            return;
        }
        let peak = chunk.iter().fold(0.0f32, |max, s| max.max(s.abs()));
        self.peaks.push(peak);
        self.squared_sum += chunk.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>();
        self.samples += chunk.len();
    }

    fn ready(&self) -> bool {
        self.peaks.len() >= 4
            || (!self.peaks.is_empty() && self.last_emit.elapsed() >= Duration::from_millis(50))
    }

    fn take(&mut self) -> AudioLevelUpdate {
        let rms = if self.samples > 0 {
            (self.squared_sum / self.samples as f64).sqrt() as f32
        } else {
            0.0
        };
        self.squared_sum = 0.0;
        self.samples = 0;
        self.last_emit = Instant::now();
        AudioLevelUpdate {
            peaks: std::mem::take(&mut self.peaks),
            rms,
        }
    }
}

/// How much audio to keep in the rolling capture buffer for transcription.
const MONITOR_BUFFER_SECONDS: u32 = 30;

/// Voice activity detection for automatic transcription. The threshold is
/// adaptive: it tracks a slow noise floor estimate and triggers a few times
/// above it, so quiet and loud microphones both work without manual tuning.
const VAD_NOISE_FLOOR_INITIAL: f32 = 0.004;
const VAD_NOISE_FLOOR_ALPHA: f32 = 0.05;
const VAD_THRESHOLD_FLOOR: f32 = 0.006;
const VAD_THRESHOLD_CEIL: f32 = 0.25;
const VAD_THRESHOLD_FACTOR: f32 = 4.0;
const VAD_PRE_ROLL_MS: u32 = 300;
const VAD_MIN_SPEECH_MS: u32 = 400;
const VAD_SILENCE_FINALIZE_MS: u32 = 900;
const VAD_MAX_UTTERANCE_SECONDS: u32 = 30;

/// Speech/silence state machine fed by the audio callback.
struct VadState {
    speaking: bool,
    speech_ms: f32,
    silence_ms: f32,
    noise_floor: f32,
    utterance: Vec<f32>,
}

impl VadState {
    fn new() -> Self {
        Self {
            speaking: false,
            speech_ms: 0.0,
            silence_ms: 0.0,
            noise_floor: VAD_NOISE_FLOOR_INITIAL,
            utterance: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.speaking = false;
        self.speech_ms = 0.0;
        self.silence_ms = 0.0;
        self.utterance.clear();
    }
}

/// Stream handle kept alive while the user is watching a device, plus the
/// software input gain (in percent, 100 = unity) applied to captured samples,
/// a rolling buffer of captured audio, and the VAD state machine that slices
/// the audio into utterances for automatic transcription.
struct AudioMonitor {
    stream: Mutex<Option<Stream>>,
    gain_percent: Arc<AtomicU32>,
    buffer: Arc<MonitorBuffer>,
    vad: Arc<Mutex<VadState>>,
    language: Arc<Mutex<String>>,
    /// Incremented every time a new monitor stream starts; stale transcription
    /// workers (from a replaced stream) exit when they see a newer generation.
    generation: Arc<AtomicU64>,
}

/// Rolling capture buffer fed by the monitor stream. Stores downmixed mono
/// samples at the stream's sample rate.
struct MonitorBuffer {
    sample_rate: AtomicU32,
    samples: Mutex<VecDeque<f32>>,
}

impl MonitorBuffer {
    fn new() -> Self {
        Self {
            sample_rate: AtomicU32::new(0),
            samples: Mutex::new(VecDeque::new()),
        }
    }

    /// Drop accumulated audio and set the rate the new stream captures at.
    fn reset(&self, sample_rate: u32) {
        self.sample_rate.store(sample_rate, Ordering::Relaxed);
        *self.samples.lock().unwrap() = VecDeque::new();
    }

    fn push(&self, chunk: &[f32]) {
        let rate = self.sample_rate.load(Ordering::Relaxed);
        if rate == 0 {
            return;
        }
        let max = MONITOR_BUFFER_SECONDS as usize * rate as usize;
        let mut samples = self.samples.lock().unwrap();
        samples.extend(chunk.iter().copied());
        let excess = samples.len().saturating_sub(max);
        if excess > 0 {
            samples.drain(..excess);
        }
    }

    /// Drain the buffer and return it with the rate it was captured at.
    fn take(&self) -> (Vec<f32>, u32) {
        let drained: Vec<f32> = self.samples.lock().unwrap().drain(..).collect();
        (drained, self.sample_rate.load(Ordering::Relaxed))
    }

    /// Copy the last `n` samples (used as pre-roll for a starting utterance).
    fn tail(&self, n: usize) -> Vec<f32> {
        let samples = self.samples.lock().unwrap();
        let start = samples.len().saturating_sub(n);
        samples.iter().skip(start).copied().collect()
    }

    /// Current capture rate, 0 before the first stream starts.
    fn sample_rate_value(&self) -> u32 {
        self.sample_rate.load(Ordering::Relaxed)
    }
}

impl Default for AudioMonitor {
    fn default() -> Self {
        Self {
            stream: Mutex::new(None),
            gain_percent: Arc::new(AtomicU32::new(100)),
            buffer: Arc::new(MonitorBuffer::new()),
            vad: Arc::new(Mutex::new(VadState::new())),
            language: Arc::new(Mutex::new("auto".to_string())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// Shared handles handed to the audio callback.
struct MonitorLinks {
    gain_percent: Arc<AtomicU32>,
    buffer: Arc<MonitorBuffer>,
    vad: Arc<Mutex<VadState>>,
    utterances: mpsc::Sender<(Vec<f32>, u32)>,
    app: AppHandle,
}

fn build_monitor_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    links: &MonitorLinks,
) -> Result<Stream, String>
where
    T: SampleToF32,
{
    let channels = config.channels.max(1);
    let rate = config.sample_rate;
    let gain_percent = links.gain_percent.clone();
    let buffer = links.buffer.clone();
    let vad = links.vad.clone();
    let utterances = links.utterances.clone();
    let app = links.app.clone();
    let mut accumulator = LevelAccumulator::new();
    let error_app = app.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let gain = gain_percent.load(Ordering::Relaxed) as f32 / 100.0;
                // Downmix to mono (gain applied) — this is what the level
                // meter shows and what the transcription buffer collects.
                let mono: Vec<f32> = if channels <= 1 {
                    data.iter()
                        .map(|s| SampleToF32::to_f32(*s) * gain)
                        .collect()
                } else {
                    data.chunks_exact(channels as usize)
                        .map(|frame| {
                            let sum: f32 = frame.iter().map(|s| SampleToF32::to_f32(*s)).sum();
                            sum / channels as f32 * gain
                        })
                        .collect()
                };
                accumulator.push(&mono);
                buffer.push(&mono);

                // Voice activity detection: slice the stream into utterances.
                let chunk_ms = mono.len() as f32 * 1000.0 / rate as f32;
                let rms = if mono.is_empty() {
                    0.0
                } else {
                    (mono
                        .iter()
                        .map(|s| {
                            let s = *s as f64;
                            s * s
                        })
                        .sum::<f64>()
                        / mono.len() as f64)
                        .sqrt() as f32
                };
                let mut vad_state = vad.lock().unwrap();
                let threshold = (vad_state.noise_floor * VAD_THRESHOLD_FACTOR)
                    .clamp(VAD_THRESHOLD_FLOOR, VAD_THRESHOLD_CEIL);
                if !vad_state.speaking {
                    if rms >= threshold {
                        // Speech started: roll in a little pre-roll so word
                        // onsets are not clipped.
                        vad_state.speaking = true;
                        vad_state.speech_ms = chunk_ms;
                        vad_state.silence_ms = 0.0;
                        let pre_roll = buffer.tail(rate as usize * VAD_PRE_ROLL_MS as usize / 1000);
                        vad_state.utterance = pre_roll;
                        vad_state.utterance.extend_from_slice(&mono);
                    } else {
                        vad_state.noise_floor = vad_state.noise_floor
                            * (1.0 - VAD_NOISE_FLOOR_ALPHA)
                            + rms * VAD_NOISE_FLOOR_ALPHA;
                        vad_state.utterance.clear();
                    }
                } else {
                    vad_state.utterance.extend_from_slice(&mono);
                    if rms >= threshold {
                        vad_state.speech_ms += chunk_ms;
                        vad_state.silence_ms = 0.0;
                    } else {
                        vad_state.silence_ms += chunk_ms;
                    }
                    let max_samples = VAD_MAX_UTTERANCE_SECONDS as usize * rate as usize;
                    let finalize = vad_state.silence_ms >= VAD_SILENCE_FINALIZE_MS as f32
                        || vad_state.utterance.len() >= max_samples;
                    if finalize {
                        vad_state.speaking = false;
                        let long_enough = vad_state.speech_ms >= VAD_MIN_SPEECH_MS as f32;
                        let utterance = std::mem::take(&mut vad_state.utterance);
                        if long_enough {
                            println!(
                                "[vad] utterance finalized: {} samples ({:.2}s), speech {:.0}ms",
                                utterance.len(),
                                utterance.len() as f32 / rate as f32,
                                vad_state.speech_ms
                            );
                            let _ = utterances.send((utterance, rate));
                        }
                    }
                }
                drop(vad_state);

                if accumulator.ready() {
                    let _ = app.emit("audio-level", accumulator.take());
                }
            },
            move |err| {
                let _ = error_app.emit("audio-level-error", err.to_string());
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Build a monitor stream for any supported sample format.
fn build_monitor_for_format(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: SampleFormat,
    links: &MonitorLinks,
) -> Result<Stream, String> {
    match format {
        SampleFormat::F32 => build_monitor_stream::<f32>(device, config, links),
        SampleFormat::I16 => build_monitor_stream::<i16>(device, config, links),
        SampleFormat::I32 => build_monitor_stream::<i32>(device, config, links),
        SampleFormat::I8 => build_monitor_stream::<i8>(device, config, links),
        SampleFormat::U8 => build_monitor_stream::<u8>(device, config, links),
        SampleFormat::U16 => build_monitor_stream::<u16>(device, config, links),
        other => Err(format!("unsupported sample format: {other:?}")),
    }
}

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
fn spawn_transcription_worker(
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
                    let resampled = whisper::resample_to_16k(samples, rate);
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
                    if utterance.len() <= last_partial_len
                        || utterance.len() < min_samples
                    {
                        continue;
                    }
                    let resampled = whisper::resample_to_16k(utterance.clone(), rate);
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

/// Open a capture stream on the selected device and stream live levels to the
/// frontend. Only one device can be monitored at a time. Utterances detected
/// by the VAD are transcribed automatically in a background worker.
#[tauri::command]
fn start_audio_monitor(
    app: AppHandle,
    state: State<'_, AudioMonitor>,
    engine: State<'_, Arc<WhisperEngine>>,
    driver: Option<String>,
    name: String,
) -> Result<(), String> {
    // Stop the previous stream first. Dropping it also drops the utterance
    // channel sender, which terminates the previous transcription worker.
    *state.stream.lock().unwrap() = None;

    let host = cpal::default_host();
    // Find the requested device by its ALSA route, falling back to the name.
    let device = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .find(|device| match (&device.description(), &driver) {
            (Ok(description), Some(driver)) => description.driver() == Some(driver.as_str()),
            (Ok(description), None) => description.name() == name,
            (Err(_), _) => false,
        })
        .ok_or_else(|| {
            format!(
                "input device not found: {}",
                driver.as_deref().unwrap_or(&name)
            )
        })?;

    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_format = config.sample_format();
    let fallback_config: cpal::StreamConfig = config.into();
    // Prefer a 16 kHz mono stream so captured audio goes straight to whisper;
    // ALSA plug devices handle the rate/channel conversion for us.
    let preferred_config = cpal::StreamConfig {
        channels: 1,
        sample_rate: whisper::SAMPLE_RATE,
        buffer_size: cpal::BufferSize::Default,
    };
    // A fresh device starts at unity gain.
    state.gain_percent.store(100, Ordering::Relaxed);
    state.vad.lock().unwrap().reset();
    let buffer = state.buffer.clone();

    // Worker that transcribes utterances finalized by the VAD and also
    // emits partial drafts while the user is still speaking.
    let (utterances_tx, utterances_rx) = mpsc::channel();
    let my_generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
    spawn_transcription_worker(
        utterances_rx,
        engine.inner().clone(),
        state.language.clone(),
        state.vad.clone(),
        buffer.clone(),
        state.generation.clone(),
        my_generation,
        app.clone(),
    );
    let links = MonitorLinks {
        gain_percent: state.gain_percent.clone(),
        buffer: buffer.clone(),
        vad: state.vad.clone(),
        utterances: utterances_tx,
        app: app.clone(),
    };

    let stream = match build_monitor_for_format(&device, preferred_config.clone(), sample_format, &links) {
        Ok(stream) => {
            buffer.reset(preferred_config.sample_rate);
            println!(
                "[monitor] capturing at {} Hz mono for transcription",
                preferred_config.sample_rate
            );
            stream
        }
        Err(err) => {
            println!(
                "[monitor] 16 kHz mono capture failed ({err}); falling back to device default config"
            );
            let stream = build_monitor_for_format(&device, fallback_config.clone(), sample_format, &links)?;
            buffer.reset(fallback_config.sample_rate);
            stream
        }
    };

    stream.play().map_err(|e| e.to_string())?;
    *state.stream.lock().unwrap() = Some(stream);
    Ok(())
}

/// Close the currently monitored device stream.
#[tauri::command]
fn stop_audio_monitor(state: State<'_, AudioMonitor>) {
    *state.stream.lock().unwrap() = None;
}

/// Adjust the software input gain (percent, 0..=400, 100 = unity) of the
/// running capture stream. Picked up by the next audio callback.
#[tauri::command]
fn set_audio_monitor_gain(state: State<'_, AudioMonitor>, gain_percent: u32) {
    state
        .gain_percent
        .store(gain_percent.clamp(0, 400), Ordering::Relaxed);
}

/// Set the language used for automatic transcription (e.g. "auto", "en", "ru").
#[tauri::command]
fn set_transcription_language(state: State<'_, AudioMonitor>, language: String) {
    *state.language.lock().unwrap() = language;
}

/// All language codes the current whisper build understands, for the UI
/// language picker ("auto" is a UI-level pseudo option, not in the table).
#[tauri::command]
fn list_transcription_languages() -> Vec<String> {
    whisper::WhisperEngine::languages()
}

/// Forward a debug message from the webview to the container stdout.
#[tauri::command]
fn debug_log(message: String) {
    println!("[ui] {message}");
}

/// Serializes typing sessions: concurrent type_text calls (e.g. auto-type of
/// a new utterance while the previous one is still being typed) must not
/// interleave keystrokes.
static TYPE_LOCK: Mutex<()> = Mutex::new(());

/// Type the given text into whatever window currently has keyboard focus,
/// using enigo's X11 (XTest) backend. Async for the same reason as
/// `transcribe_monitored_audio`: long texts take a while to type.
#[tauri::command]
async fn type_text(text: String) -> Result<(), String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioMonitor::default())
        .manage(Arc::new(WhisperEngine::new()))
        .setup(|app| {
            // Warm up the whisper model in the background so the first
            // automatic transcription does not include the model load time.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let engine = handle.state::<Arc<WhisperEngine>>();
                if let Err(err) = engine.preload() {
                    println!("[whisper] preload failed: {err}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_input_devices,
            start_audio_monitor,
            stop_audio_monitor,
            set_audio_monitor_gain,
            set_transcription_language,
            list_transcription_languages,
            debug_log,
            type_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_input_devices_without_error() {
        let devices = list_audio_input_devices().expect("failed to enumerate input devices");
        for device in &devices {
            println!(
                "input device: {} [{}] (default: {}, {:?})",
                device.name,
                device.driver.as_deref().unwrap_or("-"),
                device.is_default,
                device.default_config
            );
        }
        assert!(devices.iter().all(|d| !d.name.is_empty()));
        assert!(
            devices.iter().all(|d| d.driver.as_deref() != Some("null")),
            "the null pseudo device must be filtered out"
        );
    }

    /// Opens a real capture stream (like `start_audio_monitor` does) and
    /// asserts that audio callbacks actually deliver data.
    #[test]
    fn monitor_receives_audio_callbacks() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        fn spawn_test_stream<T: SampleToF32>(
            device: &cpal::Device,
            config: cpal::StreamConfig,
            callbacks: Arc<AtomicUsize>,
        ) -> Result<Stream, cpal::Error> {
            let mut accumulator = LevelAccumulator::new();
            device.build_input_stream::<T, _, _>(
                config,
                move |data: &[T], _| {
                    let chunk: Vec<f32> = data.iter().map(|s| SampleToF32::to_f32(*s)).collect();
                    accumulator.push(&chunk);
                    callbacks.fetch_add(1, Ordering::Relaxed);
                },
                |_| {},
                None,
            )
        }

        let host = cpal::default_host();
        let device = host
            .input_devices()
            .expect("failed to enumerate input devices")
            .find(|device| device.default_input_config().is_ok())
            .expect("no capturable input device found");
        let config = device.default_input_config().expect("default input config");
        let stream_config: cpal::StreamConfig = config.clone().into();

        let callbacks = Arc::new(AtomicUsize::new(0));
        let stream = match config.sample_format() {
            SampleFormat::F32 => {
                spawn_test_stream::<f32>(&device, stream_config, callbacks.clone()).unwrap()
            }
            SampleFormat::I16 => {
                spawn_test_stream::<i16>(&device, stream_config, callbacks.clone()).unwrap()
            }
            SampleFormat::I32 => {
                spawn_test_stream::<i32>(&device, stream_config, callbacks.clone()).unwrap()
            }
            SampleFormat::I8 => {
                spawn_test_stream::<i8>(&device, stream_config, callbacks.clone()).unwrap()
            }
            SampleFormat::U8 => {
                spawn_test_stream::<u8>(&device, stream_config, callbacks.clone()).unwrap()
            }
            SampleFormat::U16 => {
                spawn_test_stream::<u16>(&device, stream_config, callbacks.clone()).unwrap()
            }
            other => panic!("unsupported sample format: {other:?}"),
        };
        stream.play().expect("failed to start capture stream");

        std::thread::sleep(Duration::from_millis(400));
        let fired = callbacks.load(Ordering::Relaxed);
        println!("audio callbacks in 400ms: {fired}");
        assert!(fired > 0, "no audio callbacks fired within 400ms");
    }
}
