# NAM Tone Engine Plugin

Play through Neural Amp Modeler (NAM) amp models and cabinet impulse responses from Slopsmith. In a regular browser, the plugin uses Web Audio + WASM. In Slopsmith Desktop, it can use the native Desktop audio engine so guitar input runs through the JUCE/NAM/IR signal chain instead of the browser AudioContext path.

## How It Works

### Signal Chain

Browser mode:

```text
Guitar (USB interface) → getUserMedia
  → Input Gain
  → NAM AudioWorklet (WASM amp model inference)
  → ConvolverNode (cabinet IR)
  → Output Gain
  → Speakers
```

Slopsmith Desktop native mode:

```text
Guitar (Desktop audio device)
  → Slopsmith Desktop native audio engine
  → NAM processor
  → IR loader
  → Desktop audio output
```

The browser path captures your guitar via the Web Audio API, processes it through a Neural Amp Modeler compiled to WebAssembly running inside an AudioWorkletProcessor, then applies a cabinet impulse response using the browser's native ConvolverNode. The Desktop path detects `window.slopsmithDesktop.audio` and asks the native audio engine to load the same preset as a native NAM + IR chain. The processed signal is routed to your speakers while the song's guitar stem is automatically muted.

### Slopsmith Desktop Native Mode

When running inside Slopsmith Desktop, the plugin automatically prefers the native audio engine if the required Desktop bridge APIs are available. Presets are translated by the backend route `/api/plugins/nam_tone/native-preset/{preset_id}` into the native signal-chain JSON format expected by `window.slopsmithDesktop.audio.loadPreset()`.

Native mode keeps the existing browser/WASM path as a fallback. If the Desktop bridge is unavailable, the plugin behaves like the browser version.

The NAM settings panel can configure Desktop native input, output, sample rate, and buffer size directly through the same bridge. It does not depend on the Audio Engine plugin screen being installed, though both UIs share the same saved Desktop audio device settings.

The status panel shows the active mode and the live device-reported native latency from Slopsmith Desktop. This is the driver/device latency reported by the audio backend; physical round-trip calibration requires a separate loopback test and is intentionally not part of this plugin path.

### NAM Models

NAM (Neural Amp Modeler) uses neural networks to model real guitar amplifiers. The `.nam` model files contain the trained weights for a specific amp/pedal tone. Models are loaded into a WASM module compiled from [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) using Emscripten in single-threaded mode (no SharedArrayBuffer required).

Both **Architecture 1 (A1)** — the original/legacy NAM format — and **Architecture 2 (A2)** — the newer architecture TONE3000 made the default in June 2026 — are supported. The same is true in Slopsmith Desktop's native engine. A2 is a heavier network: it sounds better but costs more CPU, which matters most on the single-threaded browser worklet path.

You can find free `.nam` models at [TONE3000](https://www.tone3000.com/) and other NAM community sites.

### Cabinet IRs

Cabinet impulse responses (`.wav` files) simulate the speaker cabinet. Without an IR, the raw NAM output sounds thin and fizzy. IRs are processed using the browser's native `ConvolverNode` which is highly optimized. On upload, IRs are automatically converted to browser-compatible format (PCM float32, 48kHz mono) via ffmpeg.

### Tone Auto-Switching

Songs can have multiple tones (e.g., Clean, Distortion, Lead). You can map each tone to a different preset. During playback, the plugin polls `highway.getToneChanges()` every 100ms and automatically switches the NAM model and IR when the active tone changes.

### Guitar Stem Ducking

When playing sloppak songs with separated stems, enabling AMP automatically mutes the guitar stem so you only hear your own playing through the amp model. The stem volume is restored when AMP is disabled. This can be toggled in settings.

## Setup

1. **Upload models**: Go to the NAM config screen → upload `.nam` files
2. **Upload IRs**: Upload `.wav` cabinet impulse response files
3. **Create presets**: Combine a model + IR with gain and gate settings
4. **Test presets**: Use the Test button on any preset to audition it; the active button changes to Stop while the test is running.
5. **Select input device**: In browser mode, choose your USB audio interface in plugin settings. In Desktop native mode, use the Desktop Native Device controls in the NAM settings panel.
6. **Play**: Open a song, click the **AMP** button in player controls

## Settings

- **Input Device** — Select your USB audio interface for browser/Web Audio mode
- **Desktop Native Device** — Select Slopsmith Desktop native device type, input, output, sample rate, and buffer size when the Desktop bridge is available
- **Input Channel** — Mono (mix), Left only, or Right only
- **Input Gain** — Adjust input sensitivity (1.0 = unity)
- **Output Gain** — Master volume for processed signal
- **Noise Gate** — Threshold in dBFS to cut noise when not playing
- **Latency Offset** — Compensate for audio processing delay
- **Auto-mute guitar stem** — Mute the song's guitar stem when AMP is active

In Desktop native mode, device settings, input channel, and noise gate settings are forwarded to the native audio engine. Saved native device settings are applied before the plugin starts the native NAM chain.

Preset tests are stopped automatically when you leave the NAM screen so an auditioned tone cannot keep owning the input while you browse elsewhere.

## Backup and Restore

The plugin manifest opts into Slopsmith's Settings export/import flow for:

- `nam_tone.db` — presets and tone mappings
- `nam_models/` — uploaded NAM model files
- `nam_irs/` — uploaded cabinet IR files

These files live under Slopsmith's plugin config directory and are restored by Slopsmith's settings import flow.

## Tone Mapping

1. Go to the NAM config screen
2. Search for a song
3. Each tone in the song gets a dropdown to assign a preset
4. Mappings auto-save and are applied during playback

## Architecture

```
plugins/nam_tone/
  plugin.json              # Plugin manifest
  routes.py                # Backend: SQLite DB, file upload, native preset JSON, WASM serving
  screen.html              # Config screen UI
  screen.js                # Browser/native signal chain selection, tone switching, stem ducking, UI
  settings.html            # Inline settings panel
  worklet/
    nam-processor.js       # AudioWorkletProcessor (runs WASM inference)
  wasm/
    nam-core.wasm          # NeuralAmpModelerCore compiled to WASM
    nam-core.js            # Emscripten glue code
```

### WASM Build

The WASM artifacts were built from [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) **v0.5.3** using Emscripten:

- Single-threaded (no SharedArrayBuffer, no COOP/COEP headers needed)
- `ALLOW_MEMORY_GROWTH=1` for large model files
- `FILESYSTEM=0` — no virtual filesystem overhead
- **A2 support**: built at v0.5.3 (the first release with NAM Architecture 2),
  with `-DNAM_ENABLE_A2_FAST` to enable the hand-optimized A2 fast-path WaveNet.
  v0.5.x reorganized sources into a `NAM/wavenet/` subdirectory, so the A2 sources
  must be compiled explicitly (a flat `NAM/*.cpp` glob misses them). A1 models keep
  working unchanged. Requires `-std=c++20`.
- C bridge (`nam_bridge.cpp`, committed at the repo root) exposes: `nam_create`,
  `nam_destroy`, `nam_set_sample_rate`, `nam_load_model`, `nam_process`, `nam_is_loaded`.
  `nam_set_sample_rate` lets the worklet pass the AudioContext rate so model
  `Reset()` resamples correctly.

To rebuild, install the [Emscripten SDK](https://emscripten.org/) (or use the
`emscripten/emsdk` Docker image) and run from the NeuralAmpModelerCore checkout
with `nam_bridge.cpp` from this repo:

```bash
git clone https://github.com/sdatkinson/NeuralAmpModelerCore.git
cd NeuralAmpModelerCore
git checkout v0.5.3
git submodule update --init --recursive

em++ -O3 -DNAM_SAMPLE_FLOAT -DNAM_ENABLE_A2_FAST \
  -I Dependencies/eigen -I Dependencies/nlohmann -I Dependencies/AudioDSPTools -I NAM \
  -std=c++20 \
  /path/to/slopsmith-plugin-nam-tone/nam_bridge.cpp \
  NAM/*.cpp NAM/wavenet/*.cpp \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME="NAMCore" \
  -s EXPORTED_FUNCTIONS="['_nam_create','_nam_destroy','_nam_set_sample_rate','_nam_load_model','_nam_process','_nam_is_loaded','_malloc','_free']" \
  -s "EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','HEAPF32']" \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web \
  -s SINGLE_FILE=0 -s FILESYSTEM=0 -s DISABLE_EXCEPTION_CATCHING=0 \
  -o nam-core.js
```

Copy `nam-core.js` and `nam-core.wasm` to `wasm/`.
