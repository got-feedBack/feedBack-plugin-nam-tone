# NAM Tone Engine Plugin Constitution

This plugin runs Neural Amp Modeler in the browser via WebAssembly,
plus cabinet IR convolution, plus per-tone preset switching during
song playback.

## Principles

### 1. In-Browser, No Native Helpers

The signal chain runs entirely in the browser via Web Audio + an
inlined `AudioWorkletProcessor` that calls into a NAM core compiled
to WASM. We do not require the Slopsmith Desktop app, a native
helper, or Docker-side audio processing. This keeps the plugin
usable in the standard self-hosted Slopsmith install.

### 2. Single-Threaded WASM, No SAB

The WASM is built single-threaded (no SharedArrayBuffer, no
COOP/COEP headers). This trades peak performance for being deployable
without changes to Slopsmith's server-side header config. Performance
is acceptable on a modern laptop CPU; users with weaker machines can
pick smaller models.

### 3. Browser-Native Convolution for IRs

Cabinet impulse responses use `ConvolverNode` directly. We do not
roll our own IR convolution in the worklet — `ConvolverNode` is
heavily optimised, FFT-based, and free.

### 4. Server-Side Asset Storage

`.nam` model files and `.wav` IR files are uploaded and stored under
Slopsmith's `config_dir` (`nam_models/`, `nam_irs/`). They are
served back to the browser by the plugin's own routes. This way
multiple browsers / devices on the same install share the asset
library. IRs are normalised to PCM float32 / 48 kHz / mono via
`ffmpeg` on upload to guarantee `ConvolverNode` compatibility.

### 5. Preset = Model + IR + Settings

A preset bundles a model, an optional IR, an input gain, an output
gain, a gate threshold, and arbitrary settings JSON. Tone mappings
are `(filename, tone_key) → preset_id`. Songs auto-switch presets by
polling `highway.getToneChanges()` every 100 ms.

### 6. Stem Ducking, Not Stem Replacement

When AMP is engaged on a sloppak song, the guitar stem volume is
muted (saved + restored on disable) so the user hears their own
playing through the model rather than a ghost of the original
recording. We do NOT remix or alter the stems on disk.

## Inherits from Slopsmith Core Constitution

- `setup(app, context)` contract; uses `config_dir`.
- Routes under `/api/plugins/nam_tone/...`.
- Plugin loader serves only files referenced by `plugin.json`
  (`screen.html`, `screen.js`, `settings.html`, `routes.py`). `wasm/`
  and `worklet/` files are explicitly served by routes (not by the
  loader).
- Highway hooks: `highway.getToneChanges()`, stem volume control.

Where this plugin's principles disagree with the core constitution,
the core wins.
