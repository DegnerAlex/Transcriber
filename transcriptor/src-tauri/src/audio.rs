//! Audio input devices and the live capture monitor (levels, gain, VAD).

use serde::Serialize;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{DeviceDirection, HostId, SampleFormat, SizedSample, Stream};
use tauri::{AppHandle, Emitter, State};

use crate::transcription::spawn_transcription_worker;
use crate::whisper::WhisperEngine;

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

/// An audio OUTPUT device (sink). Opening a capture stream on it records the
/// audio playing through it (PipeWire monitor capture).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub name: String,
    pub device_type: String,
    pub interface: String,
    pub is_default: bool,
}

/// The cpal host used for output-device (monitor) capture.
fn pipewire_host() -> Option<cpal::Host> {
    match cpal::host_from_id(HostId::PipeWire) {
        Ok(host) => Some(host),
        Err(err) => {
            println!("[outputs] pipewire init failed: {err}");
            None
        }
    }
}

/// The ALSA host, pinned explicitly: with the pipewire feature compiled in,
/// `cpal::default_host()` prefers PipeWire, which would change the input
/// device enumeration (and break the plughw driver-based selection).
fn alsa_host() -> Result<cpal::Host, String> {
    cpal::host_from_id(HostId::Alsa).map_err(|e| e.to_string())
}

/// Enumerate every capture (input) device visible to the default cpal host.
///
/// ALSA exposes many PCM aliases per physical card (default, sysdefault,
/// front, surround, iec958, hw, plughw, ...) that all share the card's
/// human-readable name. They are collapsed here into one entry per name,
/// preferring the `plughw` route because it performs automatic format
/// conversion and is the most forgiving one to open.
#[tauri::command]
pub fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    let host = alsa_host()?;
    let default_device = host.default_input_device();

    let mut devices: Vec<AudioInputDevice> = Vec::new();
    let mut index_by_name: HashMap<String, usize> = HashMap::new();

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

/// List audio OUTPUT devices (sinks) via the PipeWire host. Opening a capture
/// stream on one of them records whatever is playing through that output.
#[tauri::command]
pub fn list_audio_output_devices() -> Result<Vec<AudioOutputDevice>, String> {
    let host = pipewire_host();
    let Some(host) = host else {
        println!("[outputs] pipewire host unavailable");
        return Ok(Vec::new());
    };
    let default_device = host.default_output_device();

    let mut devices: Vec<AudioOutputDevice> = Vec::new();
    let mut index_by_name: HashMap<String, usize> = HashMap::new();

    for device in host
        .devices()
        .map_err(|e| format!("failed to enumerate output devices: {e}"))?
    {
        let Ok(description) = device.description() else {
            continue;
        };
        // Sinks are exposed as Duplex by the pipewire host and are the ones
        // that can be monitored (captured). Pure sources are microphones and
        // are already listed in the input section.
        if description.direction() != DeviceDirection::Duplex {
            continue;
        }
        let name = description.name().to_string();
        let entry = AudioOutputDevice {
            name: name.clone(),
            device_type: format!("{:?}", description.device_type()),
            interface: format!("{:?}", description.interface_type()),
            is_default: default_device.as_ref() == Some(&device),
        };

        match index_by_name.get(&name) {
            Some(&index) => {
                devices[index].is_default |= entry.is_default;
            }
            None => {
                index_by_name.insert(name, devices.len());
                devices.push(entry);
            }
        }
    }

    println!("[outputs] {} output device(s)", devices.len());
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
pub struct VadState {
    pub speaking: bool,
    speech_ms: f32,
    silence_ms: f32,
    noise_floor: f32,
    pub utterance: Vec<f32>,
}

impl VadState {
    pub fn new() -> Self {
        Self {
            speaking: false,
            speech_ms: 0.0,
            silence_ms: 0.0,
            noise_floor: VAD_NOISE_FLOOR_INITIAL,
            utterance: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.speaking = false;
        self.speech_ms = 0.0;
        self.silence_ms = 0.0;
        self.utterance.clear();
    }
}

/// Info about the device the capture monitor is currently running on.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMonitor {
    /// "alsa" (input device) or "pipewire" (output device monitor capture).
    pub host: String,
    pub driver: Option<String>,
    pub name: String,
}

/// Stream handle kept alive while the user is watching a device, plus the
/// software input gain (in percent, 100 = unity) applied to captured samples,
/// a rolling buffer of captured audio, and the VAD state machine that slices
/// the audio into utterances for automatic transcription.
pub struct AudioMonitor {
    stream: Mutex<Option<Stream>>,
    gain_percent: Arc<AtomicU32>,
    pub buffer: Arc<MonitorBuffer>,
    pub vad: Arc<Mutex<VadState>>,
    /// Transcription language selected in the UI ("auto", "en", "ru", ...).
    pub language: Arc<Mutex<String>>,
    /// Incremented every time a new monitor stream starts; stale transcription
    /// workers (from a replaced stream) exit when they see a newer generation.
    pub generation: Arc<AtomicU64>,
    /// The device the monitor is currently capturing from (survives webview
    /// reloads — the Rust process keeps the stream alive).
    pub active_device: Mutex<Option<ActiveMonitor>>,
}

/// Rolling capture buffer fed by the monitor stream. Stores downmixed mono
/// samples at the stream's sample rate.
pub struct MonitorBuffer {
    sample_rate: AtomicU32,
    samples: Mutex<VecDeque<f32>>,
}

impl MonitorBuffer {
    pub fn new() -> Self {
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

    /// Copy the last `n` samples (used as pre-roll for a starting utterance).
    fn tail(&self, n: usize) -> Vec<f32> {
        let samples = self.samples.lock().unwrap();
        let start = samples.len().saturating_sub(n);
        samples.iter().skip(start).copied().collect()
    }

    /// Current capture rate, 0 before the first stream starts.
    pub fn sample_rate_value(&self) -> u32 {
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
            active_device: Mutex::new(None),
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
    /// Backend label for diagnostics ("alsa"/"pipewire").
    host_label: String,
    /// Throttle for the periodic rms diagnostic log.
    last_rms_log: Mutex<Instant>,
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
    let host_label = links.host_label.clone();
    let last_rms_log = Mutex::new(Instant::now() - Duration::from_secs(10));
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
                {
                    let mut last_log = last_rms_log.lock().unwrap();
                    if last_log.elapsed() >= Duration::from_millis(2000) {
                        *last_log = Instant::now();
                        println!(
                            "[monitor] ({host_label}) rms={rms:.5} threshold={threshold:.5}"
                        );
                    }
                }
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
                let msg = err.to_string();
                // ALSA underrun/overrun warnings are benign timing hiccups
                // (stream (re)start, CPU/GPU load spikes during transcription).
                // Log them instead of surfacing to the UI; only unexpected
                // stream errors are forwarded.
                if msg.contains("underrun") || msg.contains("overrun") {
                    println!("[monitor] stream warning: {msg}");
                } else {
                    let _ = error_app.emit("audio-level-error", msg);
                }
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

/// Open a capture stream on the selected device and stream live levels to the
/// frontend. Only one device can be monitored at a time. Utterances detected
/// by the VAD are transcribed automatically in a background worker.
///
/// `host` selects the audio backend: "pipewire" captures output devices
/// (sinks — what is playing), the default is ALSA (input devices).
#[tauri::command]
pub fn start_audio_monitor(
    app: AppHandle,
    state: State<'_, AudioMonitor>,
    engine: State<'_, Arc<WhisperEngine>>,
    host: Option<String>,
    driver: Option<String>,
    name: String,
) -> Result<(), String> {
    // Stop the previous stream first. Dropping it also drops the utterance
    // channel sender, which terminates the previous transcription worker.
    *state.stream.lock().unwrap() = None;

    let audio_host = match host.as_deref() {
        Some("pipewire") => {
            pipewire_host().ok_or_else(|| "pipewire host unavailable".to_string())?
        }
        _ => alsa_host()?,
    };

    // Find the requested device by its ALSA route (ALSA host) or by its
    // human-readable description (PipeWire host), falling back to the name.
    let device = audio_host
        .input_devices()
        .map_err(|e| e.to_string())?
        .find(|device| match (&device.description(), &driver) {
            (Ok(description), Some(driver)) if audio_host.id() == HostId::PipeWire => {
                description.name() == name
            }
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
        sample_rate: crate::whisper::SAMPLE_RATE,
        buffer_size: cpal::BufferSize::Default,
    };
    // NOTE: the gain is intentionally NOT reset here — it is persisted in
    // the frontend (localStorage) and pushed to the backend on startup.
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
        host_label: host.as_deref().unwrap_or("alsa").to_string(),
        last_rms_log: Mutex::new(Instant::now() - Duration::from_secs(10)),
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
    *state.active_device.lock().unwrap() = Some(ActiveMonitor {
        host: host.as_deref().unwrap_or("alsa").to_string(),
        driver: driver.clone(),
        name: name.clone(),
    });
    Ok(())
}

/// Close the currently monitored device stream.
#[tauri::command]
pub fn stop_audio_monitor(state: State<'_, AudioMonitor>) {
    *state.stream.lock().unwrap() = None;
    *state.active_device.lock().unwrap() = None;
}

/// The device the capture monitor is currently running on (None when
/// stopped). Lets the frontend restore its selection after a webview reload —
/// the Rust process keeps the stream alive across reloads.
#[tauri::command]
pub fn get_active_monitor(state: State<'_, AudioMonitor>) -> Option<ActiveMonitor> {
    state.active_device.lock().unwrap().clone()
}

/// Adjust the software input gain (percent, 0..=400, 100 = unity) of the
/// running capture stream. Picked up by the next audio callback.
#[tauri::command]
pub fn set_audio_monitor_gain(state: State<'_, AudioMonitor>, gain_percent: u32) {
    state
        .gain_percent
        .store(gain_percent.clamp(0, 400), Ordering::Relaxed);
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
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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
                    callbacks.fetch_add(1, AtomicOrdering::Relaxed);
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
        let fired = callbacks.load(AtomicOrdering::Relaxed);
        println!("audio callbacks in 400ms: {fired}");
        assert!(fired > 0, "no audio callbacks fired within 400ms");
    }
}
