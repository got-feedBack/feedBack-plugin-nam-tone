/**
 * NAM AudioWorkletProcessor
 *
 * Runs Neural Amp Modeler inference via WASM inside the audio rendering thread.
 * Receives WASM binary + model data from the main thread via port.postMessage.
 * Falls back to pass-through when no model is loaded.
 */

class NAMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._module = null;    // Emscripten module instance
        this._ctx = null;       // WASM NAM context pointer (void*)
        this._inPtr = 0;        // WASM heap pointer for input buffer
        this._outPtr = 0;       // WASM heap pointer for output buffer
        this._bufSize = 128;    // render quantum size
        this._loaded = false;   // model loaded and ready
        this._wasmReady = false;

        // Noise gate
        this._gateThreshold = 0.001; // linear RMS threshold (default ~ -60 dBFS)
        this._gateOpen = false;
        this._gateHoldSamples = 0;
        this._gateHoldMax = 4800;    // ~100ms at 48kHz
        this._gateAttack = 0.005;    // smoothing
        this._gateRelease = 0.05;
        this._gateGain = 0.0;

        this._pendingMessages = []; // queue messages until WASM is ready
        this._initializing = false;
        this.port.onmessage = (e) => this._handleMessage(e.data);
    }

    _handleMessage(msg) {
        // Queue model-related messages while WASM is initializing
        if (this._initializing && msg.type !== 'load-wasm' && msg.type !== 'set-gate') {
            this._pendingMessages.push(msg);
            return;
        }

        switch (msg.type) {
            case 'load-wasm':
                this._initializing = true;
                this._initWasm(msg.wasmBinary, msg.glueCode).then(() => {
                    this._initializing = false;
                    // Process queued messages
                    for (const m of this._pendingMessages) {
                        this._handleMessage(m);
                    }
                    this._pendingMessages = [];
                });
                break;
            case 'load-model':
                this._loadModel(msg.modelJson);
                break;
            case 'unload-model':
                this._unloadModel();
                break;
            case 'set-gate':
                // Convert dBFS to linear RMS threshold
                this._gateThreshold = Math.pow(10, msg.threshold / 20);
                break;
        }
    }

    async _initWasm(wasmBinary, glueCode) {
        try {
            // The Emscripten glue code (compiled with MODULARIZE=1) exports a factory.
            // In AudioWorklet scope we use new Function to evaluate it.
            const factory = new Function(glueCode + '\nreturn NAMCore;')();
            const self = this;
            this._module = await factory({
                wasmBinary,
                // Route Emscripten stderr to main thread console
                printErr: function(text) {
                    self.port.postMessage({ type: 'stderr', text });
                },
            });

            // Allocate persistent I/O buffers (128 floats = 512 bytes)
            this._inPtr = this._module._malloc(this._bufSize * 4);
            this._outPtr = this._module._malloc(this._bufSize * 4);

            // Create NAM processing context (sample rate applied inside).
            this._ctx = this._createContext();
            if (!this._ctx) {
                throw new Error('nam_create returned a null context (allocation failed)');
            }
            this._wasmReady = true;

            this.port.postMessage({ type: 'wasm-ready' });
        } catch (err) {
            this.port.postMessage({ type: 'error', message: 'WASM init failed: ' + err.message });
        }
    }

    _loadModel(jsonStr) {
        if (!this._module || !this._ctx) {
            this.port.postMessage({ type: 'model-loaded', success: false, error: 'WASM not ready' });
            return;
        }

        try {
            // Encode JSON string to UTF-8 bytes manually
            // (TextEncoder unavailable in AudioWorklet, ccall 'string' uses stack which is too small)
            const bytes = new Uint8Array(jsonStr.length * 3);
            let len = 0;
            for (let i = 0; i < jsonStr.length; i++) {
                const c = jsonStr.charCodeAt(i);
                if (c < 0x80) {
                    bytes[len++] = c;
                } else if (c < 0x800) {
                    bytes[len++] = 0xC0 | (c >> 6);
                    bytes[len++] = 0x80 | (c & 0x3F);
                } else {
                    bytes[len++] = 0xE0 | (c >> 12);
                    bytes[len++] = 0x80 | ((c >> 6) & 0x3F);
                    bytes[len++] = 0x80 | (c & 0x3F);
                }
            }

            // Allocate on heap (not stack) — .nam files can be several MB
            const strPtr = this._module._malloc(len + 1);
            this._module.HEAPU8.set(bytes.subarray(0, len), strPtr);
            this._module.HEAPU8[strPtr + len] = 0;

            const result = this._module._nam_load_model(this._ctx, strPtr, len);
            this._module._free(strPtr);

            this._loaded = (result === 0);
            this.port.postMessage({
                type: 'model-loaded',
                success: this._loaded,
                code: result,
                error: result !== 0 ? `nam_load_model returned ${result}` : undefined,
            });
        } catch (err) {
            this._loaded = false;
            this.port.postMessage({ type: 'model-loaded', success: false, error: err.message });
        }
    }

    // Create a NAM context and tell it the host sample rate so model Reset()
    // sets up correct internal resampling. `sampleRate` is a global in
    // AudioWorkletGlobalScope. Guard for older WASM builds without this export.
    // Centralized so every newly created context gets the rate, not just the
    // first one (the unload path recreates the context too).
    _createContext() {
        const ctx = this._module._nam_create();
        if (ctx && this._module._nam_set_sample_rate) {
            this._module._nam_set_sample_rate(ctx, sampleRate);
        }
        return ctx;
    }

    _unloadModel() {
        this._loaded = false;
        if (this._module && this._ctx) {
            this._module._nam_destroy(this._ctx);
            this._ctx = this._createContext();
        }
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0] || !output || !output[0]) return true;

        const inChannel = input[0];
        const outChannel = output[0];
        const n = inChannel.length;

        // Noise gate: compute RMS
        let rms = 0;
        for (let i = 0; i < n; i++) rms += inChannel[i] * inChannel[i];
        rms = Math.sqrt(rms / n);

        if (rms >= this._gateThreshold) {
            this._gateOpen = true;
            this._gateHoldSamples = this._gateHoldMax;
        } else if (this._gateHoldSamples > 0) {
            this._gateHoldSamples -= n;
        } else {
            this._gateOpen = false;
        }

        // Smooth gate gain
        const target = this._gateOpen ? 1.0 : 0.0;
        const rate = this._gateOpen ? this._gateAttack : this._gateRelease;
        this._gateGain += (target - this._gateGain) * rate;

        // If gate is fully closed, output silence
        if (this._gateGain < 0.0001) {
            outChannel.fill(0);
            return true;
        }

        // If WASM model is loaded, run NAM inference
        if (this._loaded && this._wasmReady && this._module) {
            // HEAPF32 indices are byte offset / 4
            const inIdx = this._inPtr >> 2;
            const outIdx = this._outPtr >> 2;

            // Copy input to WASM heap with gate gain applied
            for (let i = 0; i < n; i++) {
                this._module.HEAPF32[inIdx + i] = inChannel[i] * this._gateGain;
            }

            // Run NAM inference
            this._module._nam_process(this._ctx, this._inPtr, this._outPtr, n);

            // Copy output from WASM heap
            outChannel.set(this._module.HEAPF32.subarray(outIdx, outIdx + n));
        } else {
            // Pass-through with gate applied
            for (let i = 0; i < n; i++) outChannel[i] = inChannel[i] * this._gateGain;
        }

        return true;
    }
}

registerProcessor('nam-processor', NAMProcessor);
