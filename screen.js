// NAM Tone Engine plugin
// Routes guitar input through a Neural Amp Modeler WASM model + cabinet IR in the browser.

(function() {
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let _namCtx = null;           // AudioContext (reused across songs)
let _namStream = null;        // MediaStream from getUserMedia
let _namSource = null;        // MediaStreamSourceNode
let _namWorkletNode = null;   // AudioWorkletNode running NAM
let _namConvolver = null;     // ConvolverNode for cabinet IR
let _namInputGain = null;     // GainNode — input sensitivity
let _namOutputGain = null;    // GainNode — master volume
let _namBypassGain = null;    // GainNode — IR bypass routing

let _namEnabled = false;      // AMP button active
let _namWasmReady = false;
let _namModelLoaded = false;
let _namWorkletReady = false;  // addModule completed
let _namBuilding = false;      // graph build in progress
let _namCurrentPreset = null;  // {id, name, model_file, ir_file, ...}
let _namCurrentFilename = null;
let _namMappings = {};         // tone_key -> preset object
let _namCurrentTone = null;
let _namToneApplyPending = false;
let _namModelCache = {};       // model_file -> JSON string
let _namIrCache = {};          // ir_file -> AudioBuffer
let _namNativeMode = false;    // Slopsmith Desktop native audio engine path
let _namNativeReady = false;
let _namNativeLatencyText = null;
let _namNativeStartedAudio = false;
let _namNativeRecoverPending = false;
let _namLastNativeRecoverAt = 0;
let _namNativeDeviceTypes = [];
let _namNativeDeviceOptionsCache = new Map();
let _namNativeAppliedSettings = null;
let _namSettingsPresetTestId = '';

// Settings (persisted in localStorage)
let _namDeviceId = '';
let _namChannel = 'mono';      // 'mono' | 'left' | 'right'
let _namInputGainVal = 1.0;
let _namOutputGainVal = 0.5;
// Mirrors the above, but only updated by explicit user actions (not presets).
// _namSaveSettings() persists these so preset-applied transient gains never
// overwrite what the user last intentionally saved.
let _namSavedInputGainVal = 1.0;
let _namSavedOutputGainVal = 0.5;
let _namGateThreshold = -60;   // dBFS
let _namDuckGuitar = true;
let _namDefaultPresetId = null;
let _namEngineMode = 'native'; // 'native' | 'wasm'
let _namTestMode = false;
let _namTestPresetId = null;
let _namTestBackup = null;
let _namSettingsPresetTestStatusHidden = false;

const _namStorageKey = 'slopsmith_nam_tone';
const _namNativeDeviceStorageKey = 'slopsmith-audio-device';

function _namDesktopAudio() {
    const api = window.slopsmithDesktop && window.slopsmithDesktop.audio;
    if (!api || typeof api.loadPreset !== 'function' || typeof api.startAudio !== 'function') return null;
    if (typeof api.clearChain !== 'function') return null;
    return api;
}

async function _namDesktopAudioAvailable(api) {
    if (!api) return false;
    if (typeof api.isAvailable !== 'function') return true;
    try { return !!(await api.isAvailable()); } catch (_) { return false; }
}

function _namSupportsNativeDeviceSettings(api) {
    return !!api
        && typeof api.getDeviceTypes === 'function'
        && typeof api.getCurrentDevice === 'function'
        && typeof api.getSampleRates === 'function'
        && typeof api.getBufferSizes === 'function'
        && typeof api.setDeviceType === 'function'
        && typeof api.setDevice === 'function';
}

async function _namShouldUseNativeAudio(api = _namDesktopAudio()) {
    return _namEngineMode !== 'wasm' && !!api && await _namDesktopAudioAvailable(api);
}

function _namUpdateEngineModeControls(nativeAvailable) {
    const section = document.getElementById('nam-engine-mode-section');
    const select = document.getElementById('nam-engine-mode-select');
    if (section) section.classList.toggle('hidden', !nativeAvailable);
    if (select) select.value = nativeAvailable ? _namEngineMode : 'wasm';
}

function _namUpdateEngineModeVisibility(nativeAvailable) {
    const browserSection = document.getElementById('nam-browser-device-section');
    const nativeSection = document.getElementById('nam-native-device-section');
    const useNative = nativeAvailable && _namEngineMode === 'native';
    if (browserSection) browserSection.classList.toggle('hidden', useNative);
    if (nativeSection) nativeSection.classList.toggle('hidden', !useNative);
}

function _namLoadNativeDeviceSettings() {
    try {
        const raw = localStorage.getItem(_namNativeDeviceStorageKey);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function _namSaveNativeDeviceSettings(settings) {
    const existing = _namLoadNativeDeviceSettings() || {};
    try {
        localStorage.setItem(_namNativeDeviceStorageKey, JSON.stringify({
            ...existing,
            ...settings,
            inputChannel: String(_namNativeInputChannel()),
        }));
    } catch (_) {}
}

function _namSetNativeDeviceStatus(text, kind = 'muted') {
    const el = document.getElementById('nam-native-device-status');
    if (!el) return;
    const color = kind === 'ok' ? 'text-green-400' : kind === 'error' ? 'text-red-400' : 'text-gray-500';
    el.className = `sm:col-span-2 text-[10px] ${color}`;
    el.textContent = text;
}

function _namSetSettingsPresetTestStatus(text, kind = 'muted') {
    const el = document.getElementById('nam-settings-preset-test-status');
    if (!el) return;
    _namSettingsPresetTestStatusHidden = false;
    const color = kind === 'ok' ? 'text-green-400' : kind === 'error' ? 'text-red-400' : 'text-gray-500';
    el.className = `text-[10px] ${color} sm:text-right`;
    el.textContent = text;
}

function _namHideSettingsPresetTestStatus() {
    _namSettingsPresetTestStatusHidden = true;
    const el = document.getElementById('nam-settings-preset-test-status');
    if (!el) return;
    el.className = 'hidden text-[10px] text-gray-500';
    el.textContent = '';
}

function _namSetNativeDeviceBusy(busy) {
    const section = document.getElementById('nam-native-device-section');
    if (!section) return;
    section.querySelectorAll('select, button').forEach(el => {
        el.disabled = !!busy;
        el.classList.toggle('opacity-60', !!busy);
        el.classList.toggle('cursor-not-allowed', !!busy);
    });
}

function _namSetSelectOptions(select, values, selectedValue, defaultLabel = null, allowMissingSelected = true) {
    if (!select) return;
    let selected = selectedValue == null ? '' : String(selectedValue);
    select.innerHTML = defaultLabel == null ? '' : `<option value="">${defaultLabel}</option>`;
    const seen = new Set(defaultLabel == null ? [] : ['']);
    for (const value of values || []) {
        const normalized = String(value);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const opt = document.createElement('option');
        opt.value = normalized;
        opt.textContent = normalized;
            select.appendChild(opt);
    }
    if (selected && !seen.has(selected) && allowMissingSelected) {
        const opt = document.createElement('option');
        opt.value = selected;
        opt.textContent = selected;
        select.appendChild(opt);
    } else if (selected && !seen.has(selected)) {
        selected = '';
    }
    select.value = selected;
}

function _namNumericOptions(values, selectedValue = null, includeSelected = true) {
    const byKey = new Map();
    const allValues = includeSelected ? [...(values || []), selectedValue] : (values || []);
    for (const value of allValues) {
        if (value == null || value === '') continue;
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        const key = String(n);
        if (!byKey.has(key)) byKey.set(key, n);
    }
    return [...byKey.values()].sort((a, b) => a - b).map(n => String(n));
}

function _namSupportedNativeDeviceTypes(types) {
    const list = Array.isArray(types) ? types : [];
    const supported = list.filter(t => t && !_namIsUnsupportedNativeDeviceType(t.name));
    return supported.length ? supported : list;
}

function _namIsUnsupportedNativeDeviceType(typeName) {
    return String(typeName || '') === 'DirectSound';
}

function _namFallbackNativeDeviceType() {
    const preferred = _namNativeDeviceTypes.find(t => t && t.name === 'Windows Audio')
        || _namNativeDeviceTypes.find(t => t && String(t.name || '').startsWith('Windows Audio'))
        || _namNativeDeviceTypes[0];
    return preferred ? preferred.name : 'Windows Audio';
}

function _namNativeDeviceNameForType(typeInfo, deviceName, isInput) {
    if (!deviceName || !typeInfo) return '';
    const names = isInput ? typeInfo.inputs : typeInfo.outputs;
    return (names || []).includes(deviceName) ? deviceName : '';
}

function _namRenderNativeDeviceDropdowns(typeName, selectedInput = '', selectedOutput = '') {
    const typeInfo = _namNativeDeviceTypes.find(t => t.name === typeName) || _namNativeDeviceTypes[0];
    const input = _namNativeDeviceNameForType(typeInfo, selectedInput, true);
    const output = _namNativeDeviceNameForType(typeInfo, selectedOutput, false);
    _namSetSelectOptions(document.getElementById('nam-native-input-device'), typeInfo ? typeInfo.inputs : [], input, 'Default', false);
    _namSetSelectOptions(document.getElementById('nam-native-output-device'), typeInfo ? typeInfo.outputs : [], output, 'Default', false);
    return { input, output };
}

function _namNativeDeviceFormValues() {
    return {
        type: document.getElementById('nam-native-device-type')?.value || '',
        input: document.getElementById('nam-native-input-device')?.value || '',
        output: document.getElementById('nam-native-output-device')?.value || '',
        sampleRate: document.getElementById('nam-native-sample-rate')?.value || '48000',
        bufferSize: document.getElementById('nam-native-buffer-size')?.value || '256',
        channel: document.getElementById('nam-channel-select')?.value || _namChannel,
    };
}

function _namNormalizeNativeSettings(settings) {
    const source = settings || {};
    return {
        type: String(source.type || ''),
        input: String(source.input || ''),
        output: String(source.output || ''),
        sampleRate: String(Number(source.sampleRate || 0) || ''),
        bufferSize: String(Number(source.bufferSize || 0) || ''),
        channel: String(source.channel || _namChannel || 'mono'),
    };
}

function _namNativeSettingsFromDevice(device, fallback = null) {
    return _namNormalizeNativeSettings({
        ...(fallback || {}),
        type: device && device.type ? device.type : (fallback && fallback.type),
        input: device && device.input ? device.input : (fallback && fallback.input),
        output: device && device.output ? device.output : (fallback && fallback.output),
        sampleRate: device && device.sampleRate ? device.sampleRate : (fallback && fallback.sampleRate),
        bufferSize: device && device.blockSize ? device.blockSize : (fallback && fallback.bufferSize),
        channel: fallback && fallback.channel ? fallback.channel : _namChannel,
    });
}

function _namNativeSettingsEqual(a, b) {
    const left = _namNormalizeNativeSettings(a);
    const right = _namNormalizeNativeSettings(b);
    return left.type === right.type
        && left.input === right.input
        && left.output === right.output
        && left.sampleRate === right.sampleRate
        && left.bufferSize === right.bufferSize
        && left.channel === right.channel;
}

function _namSetNativeApplyButtonState(dirty) {
    const button = document.getElementById('nam-native-apply-button');
    if (!button) return;
    button.disabled = !dirty;
    button.textContent = dirty ? 'Apply changes' : 'Applied';
    button.title = dirty ? 'Apply the selected native audio settings' : 'Current native audio settings are already applied';
    button.className = dirty
        ? 'flex-1 bg-green-700/50 hover:bg-green-700/70 rounded-lg px-3 py-2 text-xs text-green-100 transition'
        : 'flex-1 bg-dark-700 rounded-lg px-3 py-2 text-xs text-gray-500 transition opacity-60 cursor-not-allowed';
}

function _namUpdateNativeApplyButtonState() {
    if (!_namNativeAppliedSettings) {
        _namSetNativeApplyButtonState(true);
        return;
    }
    _namSetNativeApplyButtonState(!_namNativeSettingsEqual(_namNativeDeviceFormValues(), _namNativeAppliedSettings));
}

function _namNativeDeviceOptionsKey(settings) {
    if (!settings) return '';
    return [
        settings.type || '',
        settings.input || '',
        settings.output || '',
        String(settings.sampleRate || ''),
    ].join('\u001f');
}

function _namActualNativeDeviceSettings(requested, actual) {
    const settings = { ...(requested || {}) };
    if (actual && actual.sampleRate) settings.sampleRate = String(actual.sampleRate);
    if (actual && actual.blockSize) settings.bufferSize = String(actual.blockSize);
    if (requested && requested.channel) settings.channel = requested.channel;
    return settings;
}

function _namRememberAcceptedNativeBuffer(requested, actual) {
    if (!requested || !actual) return;
    const requestedBuffer = Number(requested.bufferSize);
    const actualBuffer = Number(actual.blockSize);
    if (!Number.isFinite(requestedBuffer) || !Number.isFinite(actualBuffer) || requestedBuffer === actualBuffer) return;

    const cacheKey = _namNativeDeviceOptionsKey(requested);
    if (!cacheKey) return;

    const existing = _namNativeDeviceOptionsCache.get(cacheKey) || {};
    const buffers = (existing.bufferSizes || [])
        .map(Number)
        .filter(n => Number.isFinite(n) && n !== requestedBuffer);
    if (!buffers.includes(actualBuffer)) buffers.push(actualBuffer);

    _namNativeDeviceOptionsCache.set(cacheKey, {
        ...existing,
        type: requested.type || existing.type || '',
        input: requested.input || existing.input || '',
        output: requested.output || existing.output || '',
        sampleRates: existing.sampleRates && existing.sampleRates.length
            ? existing.sampleRates
            : [actual.sampleRate || requested.sampleRate].filter(Boolean),
        bufferSizes: buffers.length ? buffers.sort((a, b) => a - b) : [actualBuffer],
    });
}

async function _namApplyNativeDeviceSettings(api, settings, restartWhenActive) {
    if (!_namSupportsNativeDeviceSettings(api) || !settings) return false;
    const current = await api.getCurrentDevice().catch(() => null);
    let type = settings.type || (current && current.type) || '';
    const hadUnsupportedType = _namIsUnsupportedNativeDeviceType(type);
    if (hadUnsupportedType) {
        type = _namFallbackNativeDeviceType();
        console.warn('[NAM] DirectSound is not supported for native NAM monitoring; using', type);
    }
    const input = hadUnsupportedType ? '' : (settings.input !== undefined ? settings.input : ((current && current.input) || ''));
    const output = hadUnsupportedType ? '' : (settings.output !== undefined ? settings.output : ((current && current.output) || ''));
    const sampleRate = parseFloat(settings.sampleRate || (current && current.sampleRate) || 48000);
    const bufferSize = parseInt(settings.bufferSize || (current && current.blockSize) || 256, 10);
    const same = current
        && (!type || type === current.type)
        && (!input || input === (current.input || ''))
        && (!output || output === (current.output || ''))
        && Number(sampleRate) === Number(current.sampleRate)
        && Number(bufferSize) === Number(current.blockSize);
    if (same) return true;

    const wasRunning = typeof api.isAudioRunning === 'function'
        ? await api.isAudioRunning().catch(() => false)
        : false;
    if (wasRunning && typeof api.stopAudio === 'function') await api.stopAudio();
    if (type && (!current || type !== current.type)) await api.setDeviceType(type);
    const ok = await api.setDevice(input, output, sampleRate, bufferSize);
    if (!ok) return false;
    if ((wasRunning || restartWhenActive) && typeof api.startAudio === 'function') {
        await api.startAudio();
        if (!wasRunning && restartWhenActive) _namNativeStartedAudio = true;
    }
    return true;
}

async function _namProbeNativeDeviceOptions(api, settings, forceRefresh = false) {
    if (!api || typeof api.probeDeviceOptions !== 'function' || !settings) return null;
    const cacheKey = _namNativeDeviceOptionsKey(settings);
    if (!forceRefresh && cacheKey && _namNativeDeviceOptionsCache.has(cacheKey)) {
        return _namNativeDeviceOptionsCache.get(cacheKey);
    }

    try {
        const options = await api.probeDeviceOptions(
            settings.type || '',
            settings.input || '',
            settings.output || '',
            Number(settings.sampleRate || 0)
        );
        if (options && !options.error) {
            if (cacheKey) _namNativeDeviceOptionsCache.set(cacheKey, options);
            return options;
        }
        if (options && options.error) console.warn('[NAM] Native option probe:', options.error);
    } catch (e) {
        console.warn('[NAM] Native option probe failed:', e);
    }
    return null;
}

async function _namRefreshNativeDeviceTimingControls(api, actualDevice = null, requestedSettings = null, shouldProbe = true, forceRefresh = false, preferActual = false) {
    if (!api) return actualDevice;

    const [probed, rates, buffers, current] = await Promise.all([
        shouldProbe ? _namProbeNativeDeviceOptions(api, requestedSettings, forceRefresh) : Promise.resolve(null),
        typeof api.getSampleRates === 'function' ? api.getSampleRates().catch(() => []) : Promise.resolve([]),
        typeof api.getBufferSizes === 'function' ? api.getBufferSizes().catch(() => []) : Promise.resolve([]),
        actualDevice ? Promise.resolve(actualDevice) : api.getCurrentDevice().catch(() => null),
    ]);
    const optionRates = probed && probed.sampleRates && probed.sampleRates.length ? probed.sampleRates : rates;
    const optionBuffers = probed && probed.bufferSizes && probed.bufferSizes.length ? probed.bufferSizes : buffers;
    const currentMatchesRequest = current && requestedSettings
        && (!requestedSettings.type || requestedSettings.type === current.type);
    const useCurrentSelection = preferActual && currentMatchesRequest;
    const requestedSampleRate = useCurrentSelection && current.sampleRate
        ? current.sampleRate
        : (requestedSettings && requestedSettings.sampleRate);
    const requestedBufferSize = useCurrentSelection && current.blockSize
        ? current.blockSize
        : (requestedSettings && requestedSettings.bufferSize);
    const sampleRate = requestedSampleRate || (current && current.sampleRate) || 48000;
    const sampleRateValues = _namNumericOptions(
        optionRates && optionRates.length ? optionRates : [sampleRate],
        null,
        false
    );
    const selectedSampleRate = sampleRateValues.includes(String(Number(sampleRate)))
        ? sampleRate
        : (sampleRateValues[0] || 48000);
    const bufferValues = _namNumericOptions(
        optionBuffers && optionBuffers.length ? optionBuffers : [current && current.blockSize ? current.blockSize : 256],
        null,
        false
    );
    const bufferSize = requestedBufferSize && bufferValues.includes(String(Number(requestedBufferSize)))
        ? requestedBufferSize
        : (bufferValues[0] || (current && current.blockSize) || 256);
    _namSetSelectOptions(
        document.getElementById('nam-native-sample-rate'),
        sampleRateValues,
        selectedSampleRate,
        null,
        false
    );
    _namSetSelectOptions(
        document.getElementById('nam-native-buffer-size'),
        bufferValues,
        bufferSize,
        null,
        false
    );
    return current;
}

async function _namApplySavedNativeDevice(api) {
    const saved = _namLoadNativeDeviceSettings();
    if (!saved) return false;
    const applied = await _namApplyNativeDeviceSettings(api, saved, _namEnabled && _namNativeMode);
    if (applied && _namIsUnsupportedNativeDeviceType(saved.type)) {
        const actual = typeof api.getCurrentDevice === 'function'
            ? await api.getCurrentDevice().catch(() => null)
            : null;
        _namSaveNativeDeviceSettings(_namActualNativeDeviceSettings({
            ...saved,
            type: _namFallbackNativeDeviceType(),
        }, actual));
    }
    return applied;
}

function _namSetNativeGain(kind, value) {
    const api = _namDesktopAudio();
    if (!_namNativeMode || !api || typeof api.setGain !== 'function') return;
    api.setGain(kind, value).catch(e => console.warn(`[NAM] Native ${kind} gain update failed:`, e));
}

function _namNativeInputChannel() {
    if (_namChannel === 'left') return 0;
    if (_namChannel === 'right') return 1;
    return -1;
}

function _namFormatMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    return `${n.toFixed(n < 10 ? 2 : 1)}ms`;
}

function _namFormatSampleRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 'sample rate N/A';
    if (n >= 1000) {
        const khz = n / 1000;
        return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)}K`;
    }
    return `${n}Hz`;
}

function _namSelectedBrowserDeviceLabel() {
    const select = document.getElementById('nam-device-select');
    const option = select && select.selectedOptions && select.selectedOptions[0];
    const label = option && option.textContent ? option.textContent.trim() : '';
    return label || 'Default input';
}

function _namNativeTestContext(device = null, requested = null) {
    const type = (device && device.type) || (requested && requested.type) || 'Default driver';
    const sampleRate = (device && device.sampleRate) || (requested && requested.sampleRate);
    const bufferSize = (device && device.blockSize) || (requested && requested.bufferSize);
    const timing = bufferSize
        ? `${_namFormatSampleRate(sampleRate)}/${bufferSize}`
        : _namFormatSampleRate(sampleRate);
    return `Desktop Native - ${type} @ ${timing}`;
}

function _namWasmLatencyText() {
    const deviceLabel = _namSelectedBrowserDeviceLabel();
    const sampleRate = _namCtx ? _namFormatSampleRate(_namCtx.sampleRate) : 'sample rate N/A';
    const prefix = `Browser WASM - ${deviceLabel} @ ${sampleRate}`;
    if (!_namCtx) return `${prefix} | Reported latency: N/A`;
    const latency = Number(_namCtx.baseLatency || 0) + Number(_namCtx.outputLatency || 0);
    return `${prefix} | Reported latency: ${latency > 0 ? _namFormatMs(latency * 1000) : 'N/A'}`;
}

function _namUpdateSettingsPresetTestStatus() {
    if (_namSettingsPresetTestStatusHidden && !_namTestMode) {
        _namHideSettingsPresetTestStatus();
        return;
    }
    if (!_namTestMode) {
        _namSetSettingsPresetTestStatus('Idle');
        return;
    }
    if (_namBuilding) {
        _namSetSettingsPresetTestStatus('Starting...');
        return;
    }
    const status = _namNativeMode
        ? (_namNativeLatencyText || `${_namNativeTestContext()} | Reported latency: N/A`)
        : _namWasmLatencyText();
    _namSetSettingsPresetTestStatus(status, 'ok');
}

async function _namRefreshNativeLatency(api, requested = null) {
    if (!api || typeof api.getCurrentDevice !== 'function') {
        _namNativeLatencyText = `${_namNativeTestContext(null, requested)} | Reported latency: N/A`;
        return;
    }
    let device = null;
    try { device = await api.getCurrentDevice(); } catch (_) { device = null; }
    const reportedMs = device && Number(device.latencyMs);
    _namNativeLatencyText = `${_namNativeTestContext(device, requested)} | Reported latency: ${_namFormatMs(reportedMs)}`;
    _namSetNativeDeviceStatus(_namNativeLatencyText, Number.isFinite(reportedMs) ? 'ok' : 'muted');
    _namUpdateSettingsPresetTestStatus();
    console.log('[NAM] Native desktop latency:',
        `reported=${_namFormatMs(reportedMs)}`,
        `device=${device ? `${device.input || 'unknown'} -> ${device.output || 'unknown'}` : 'unknown'}`,
        `sampleRate=${device && device.sampleRate ? device.sampleRate : 'unknown'}`,
        `bufferSize=${device && device.blockSize ? device.blockSize : 'unknown'}`,
        requested ? `requestedBufferSize=${requested.bufferSize || 'unknown'}` : '');
}

async function _namResetNativeAfterFailure(api) {
    if (!api) return;
    try {
        if (typeof api.clearChain === 'function') await api.clearChain();
        if (typeof api.setMonitorMute === 'function') await api.setMonitorMute(true);
        if (_namNativeStartedAudio && typeof api.stopAudio === 'function') await api.stopAudio();
    } catch (e) {
        console.warn('[NAM] Native cleanup after failure failed:', e);
    }
    _namNativeMode = false;
    _namNativeReady = false;
    _namNativeLatencyText = null;
    _namNativeStartedAudio = false;
}

async function _namApplyNativePreset(preset, api) {
    _namCurrentPreset = preset;
    _namNativeMode = true;
    _namNativeReady = false;
    _namWasmReady = false;

    if (preset.input_gain !== undefined) _namApplyInputGain(preset.input_gain);
    if (preset.output_gain !== undefined) _namApplyOutputGain(preset.output_gain);

    const presetId = preset.preset_id !== undefined ? preset.preset_id : preset.id;
    if (!presetId) throw new Error('Native desktop mode requires a saved preset id');

    const resp = await fetch(`/api/plugins/nam_tone/native-preset/${encodeURIComponent(presetId)}`);
    if (!resp.ok) throw new Error(`native preset ${presetId} failed: HTTP ${resp.status}`);
    const payload = await resp.json();
    if (!payload.native_preset || !Array.isArray(payload.native_preset.chain)) {
        throw new Error('native preset response missing chain');
    }

    await api.clearChain();
    const result = await api.loadPreset(JSON.stringify(payload.native_preset));
    if (!result || result.success === false) {
        throw new Error(result && result.error ? result.error : 'native preset load failed');
    }

    if (typeof api.setInputChannel === 'function') await api.setInputChannel(_namNativeInputChannel());
    if (typeof api.setGain === 'function') {
        await api.setGain('input', 1.0);
        await api.setGain('output', 1.0);
    }
    if (typeof api.setNoiseGate === 'function') {
        await api.setNoiseGate({
            enabled: true,
            thresholdDb: preset.gate_threshold !== undefined ? preset.gate_threshold : _namGateThreshold,
            releaseMs: 100,
            depthDb: -80,
        });
    }
    if (typeof api.setMonitorMute === 'function') await api.setMonitorMute(false);
    const wasRunning = typeof api.isAudioRunning === 'function'
        ? await api.isAudioRunning().catch(() => true)
        : true;
    await api.startAudio();
    _namNativeStartedAudio = !wasRunning;
    await _namRefreshNativeLatency(api);

    _namNativeReady = true;
    console.log('[NAM] Applied native desktop preset:', payload.name || preset.name || preset.preset_name,
        'slots:', result.slotsLoaded, 'latency:', _namNativeLatencyText || 'Reported latency: N/A');
    _namUpdateStatus();
}

async function _namBuildNativeGraph(api) {
    _namBuilding = true;
    _namNativeMode = true;
    let loadedPreset = false;
    try {
        await _namApplySavedNativeDevice(api);
        if (_namCurrentPreset) {
            await _namApplyNativePreset(_namCurrentPreset, api);
            loadedPreset = true;
        } else if (_namDefaultPresetId) {
            const resp = await fetch('/api/plugins/nam_tone/presets');
            const presets = await resp.json();
            const def = presets.find(p => p.id === _namDefaultPresetId);
            if (def) {
                await _namApplyNativePreset(def, api);
                loadedPreset = true;
            }
        } else {
            await api.clearChain();
            if (typeof api.setMonitorMute === 'function') await api.setMonitorMute(true);
        }
        if (!loadedPreset) {
            await _namRefreshNativeLatency(api);
            _namNativeReady = true;
            _namUpdateStatus();
        }
        console.log('[NAM] Native desktop audio graph built');
    } finally {
        _namBuilding = false;
    }
}

// ── localStorage Persistence ───────────────────────────────────────────────

function _namSaveSettings() {
    try {
        localStorage.setItem(_namStorageKey, JSON.stringify({
            deviceId: _namDeviceId,
            channel: _namChannel,
            inputGain: _namSavedInputGainVal,
            outputGain: _namSavedOutputGainVal,
            gateThreshold: _namGateThreshold,
            duckGuitar: _namDuckGuitar,
            defaultPresetId: _namDefaultPresetId,
            engineMode: _namEngineMode,
        }));
    } catch (e) { /* localStorage unavailable */ }
}

function _namLoadSettings() {
    try {
        const raw = localStorage.getItem(_namStorageKey);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.deviceId !== undefined) _namDeviceId = s.deviceId;
        if (s.channel) _namChannel = s.channel;
        if (s.inputGain !== undefined) _namInputGainVal = _namSavedInputGainVal = s.inputGain;
        if (s.outputGain !== undefined) _namOutputGainVal = _namSavedOutputGainVal = s.outputGain;
        if (s.gateThreshold !== undefined) _namGateThreshold = s.gateThreshold;
        if (s.duckGuitar !== undefined) _namDuckGuitar = s.duckGuitar;
        if (s.defaultPresetId !== undefined) _namDefaultPresetId = s.defaultPresetId;
        if (s.engineMode === 'native' || s.engineMode === 'wasm') _namEngineMode = s.engineMode;
    } catch (e) { /* ignore */ }
}

_namLoadSettings();

// ── Mixer fader registration (slopsmith#87) ────────────────────────────────

function _namRegisterFader() {
    const api = window.slopsmith && window.slopsmith.audio;
    if (!api) return;
    if (typeof api.registerFader !== 'function') {
        window.addEventListener('slopsmith:audio:ready', _namRegisterFader, { once: true });
        return;
    }
    api.registerFader({
        id: 'nam',
        label: 'Amp (NAM)',
        min: 0, max: 2, step: 0.05,
        defaultValue: _namOutputGainVal,
        getValue: () => _namOutputGainVal,
        setValue: (v) => window.namSetOutputGain(v),
    });
}

if (window.slopsmith && window.slopsmith.audio) {
    _namRegisterFader();
} else {
    window.addEventListener('slopsmith:audio:ready', _namRegisterFader, { once: true });
}

// ── Audio Graph ────────────────────────────────────────────────────────────

async function _namBuildGraph() {
    const nativeApi = _namDesktopAudio();
    if (await _namShouldUseNativeAudio(nativeApi)) {
        try {
            await _namBuildNativeGraph(nativeApi);
            return;
        } catch (e) {
            console.warn('[NAM] Native desktop graph failed; falling back to browser WASM:', e);
            await _namResetNativeAfterFailure(nativeApi);
        }
    }

    await _namBuildWasmGraph();
}

async function _namBuildWasmGraph() {
    _namNativeMode = false;
    _namNativeReady = false;
    _namNativeLatencyText = null;
    _namBuilding = true;
    // Create or reuse AudioContext
    if (!_namCtx) {
        _namCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_namCtx.state === 'suspended') await _namCtx.resume();

    // getUserMedia — raw signal, no processing
    const constraints = {
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
        }
    };
    if (_namDeviceId) {
        constraints.audio.deviceId = { exact: _namDeviceId };
    }

    _namStream = await navigator.mediaDevices.getUserMedia(constraints);
    _namSource = _namCtx.createMediaStreamSource(_namStream);
    const streamChannels = _namSource.channelCount;

    // Input gain
    _namInputGain = _namCtx.createGain();
    _namInputGain.gain.value = _namInputGainVal;

    // Channel routing (note_detect pattern)
    if (streamChannels >= 2 && _namChannel !== 'mono') {
        const splitter = _namCtx.createChannelSplitter(2);
        _namSource.connect(splitter);
        const merger = _namCtx.createChannelMerger(1);
        const chIdx = _namChannel === 'left' ? 0 : 1;
        splitter.connect(merger, chIdx, 0);
        merger.connect(_namInputGain);
    } else {
        _namSource.connect(_namInputGain);
    }

    // Load AudioWorklet module (first time only)
    if (!_namWorkletReady) {
        await _namCtx.audioWorklet.addModule('/api/plugins/nam_tone/worklet/nam-processor.js');
        _namWorkletReady = true;
    }

    // Create worklet node once, reuse across songs
    if (!_namWorkletNode) {
        _namWorkletNode = new AudioWorkletNode(_namCtx, 'nam-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: 'explicit',
        });

        _namWorkletNode.port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'wasm-ready') {
                _namWasmReady = true;
                console.log('[NAM] WASM ready');
            }
            if (msg.type === 'model-loaded') {
                _namModelLoaded = msg.success;
                if (msg.success) {
                    console.log('[NAM] Model loaded successfully');
                } else {
                    console.error('[NAM] Model load failed:', msg.error || 'unknown error', 'code:', msg.code);
                }
            }
            if (msg.type === 'error') {
                console.error('[NAM]', msg.message);
            }
            if (msg.type === 'stderr') {
                console.warn('[NAM WASM]', msg.text);
            }
        };

        // Load WASM into worklet (once)
        await _namSendWasm();
    } else {
        // Reusing existing node — disconnect old inputs
        try { _namWorkletNode.disconnect(); } catch (_) {}
    }

    // Send gate threshold to worklet
    _namWorkletNode.port.postMessage({
        type: 'set-gate',
        threshold: _namGateThreshold,
    });

    // ConvolverNode for cabinet IR (native Web Audio, fast)
    _namConvolver = _namCtx.createConvolver();
    _namConvolver.normalize = true;

    // Output gain
    _namOutputGain = _namCtx.createGain();
    _namOutputGain.gain.value = _namOutputGainVal;

    // Bypass gain for when no IR is loaded — routes around convolver
    _namBypassGain = _namCtx.createGain();
    _namBypassGain.gain.value = 1.0;

    // Wire chain: inputGain → worklet → (convolver | bypass) → outputGain → destination
    _namInputGain.connect(_namWorkletNode);

    // Default: bypass convolver (direct path)
    _namWorkletNode.connect(_namBypassGain);
    _namBypassGain.connect(_namOutputGain);
    _namOutputGain.connect(_namCtx.destination);

    // If we have a preset, apply it
    if (_namCurrentPreset) {
        await _namApplyWasmPreset(_namCurrentPreset);
    } else if (_namDefaultPresetId) {
        // Try loading default preset
        try {
            const resp = await fetch('/api/plugins/nam_tone/presets');
            const presets = await resp.json();
            const def = presets.find(p => p.id === _namDefaultPresetId);
            if (def) await _namApplyWasmPreset(def);
        } catch (e) { /* ignore */ }
    }

    _namBuilding = false;

    // Re-apply preset now that graph is ready (tone interval may have fired during build)
    if (_namCurrentPreset) {
        await _namApplyWasmPreset(_namCurrentPreset);
    }

    console.log('[NAM] Audio graph built, latency:',
        Math.round((_namCtx.baseLatency + _namCtx.outputLatency) * 1000), 'ms');
    _namUpdateStatus();
}

// ── WASM Loading ───────────────────────────────────────────────────────────

async function _namSendWasm() {
    if (_namWasmReady) return; // already loaded
    try {
        const [wasmResp, jsResp] = await Promise.all([
            fetch('/api/plugins/nam_tone/worklet/nam-core.wasm'),
            fetch('/api/plugins/nam_tone/worklet/nam-core.js'),
        ]);

        if (!wasmResp.ok || !jsResp.ok) {
            console.warn('[NAM] WASM files not found — running in pass-through mode');
            return;
        }

        const wasmBinary = await wasmResp.arrayBuffer();
        const glueCode = await jsResp.text();

        _namWorkletNode.port.postMessage(
            { type: 'load-wasm', wasmBinary, glueCode },
            [wasmBinary]
        );
    } catch (e) {
        console.warn('[NAM] WASM load failed — pass-through mode:', e.message);
    }
}

// ── Model Loading ──────────────────────────────────────────────────────────

async function _namLoadModel(modelFile) {
    if (!_namWorkletNode || !_namWasmReady) return;

    // Check cache
    let modelJson = _namModelCache[modelFile];
    if (!modelJson) {
        const resp = await fetch(`/api/plugins/nam_tone/file/model/${encodeURIComponent(modelFile)}`);
        if (!resp.ok) { console.error('[NAM] Failed to fetch model:', modelFile); return; }
        modelJson = await resp.text();
        _namModelCache[modelFile] = modelJson;
    }

    _namWorkletNode.port.postMessage({ type: 'load-model', modelJson });
}

// ── IR Loading ─────────────────────────────────────────────────────────────

async function _namLoadIR(irFile) {
    if (!_namCtx || !_namConvolver) return;

    // Check cache
    let audioBuf = _namIrCache[irFile];
    if (!audioBuf) {
        const resp = await fetch(`/api/plugins/nam_tone/file/ir/${encodeURIComponent(irFile)}`);
        if (!resp.ok) { console.error('[NAM] Failed to fetch IR:', irFile); return; }
        const arrayBuf = await resp.arrayBuffer();
        try {
            audioBuf = await _namCtx.decodeAudioData(arrayBuf);
        } catch (e) {
            console.error('[NAM] Failed to decode IR file:', irFile, e.message,
                '— ensure it is a valid WAV file (PCM 16/24/32-bit or float, 44.1/48kHz)');
            return;
        }
        _namIrCache[irFile] = audioBuf;
    }

    _namConvolver.buffer = audioBuf;

    // Switch from bypass to convolver path
    try { _namWorkletNode.disconnect(_namBypassGain); } catch (_) {}
    _namWorkletNode.connect(_namConvolver);
    _namConvolver.connect(_namOutputGain);
}

function _namBypassIR() {
    if (!_namWorkletNode || !_namBypassGain || !_namOutputGain) return;
    try { _namWorkletNode.disconnect(_namConvolver); } catch (_) {}
    try { _namConvolver.disconnect(_namOutputGain); } catch (_) {}
    _namWorkletNode.connect(_namBypassGain);
    _namBypassGain.connect(_namOutputGain);
}

// ── Preset Application ────────────────────────────────────────────────────

async function _namApplyPreset(preset) {
    const nativeApi = _namDesktopAudio();
    if (await _namShouldUseNativeAudio(nativeApi)) {
        try {
            await _namApplyNativePreset(preset, nativeApi);
            return;
        } catch (e) {
            console.warn('[NAM] Native preset apply failed; falling back to browser WASM:', e);
            await _namResetNativeAfterFailure(nativeApi);
            if (!_namGraphActive()) {
                await _namBuildWasmGraph();
                return;
            }
        }
    }

    await _namApplyWasmPreset(preset);
}

async function _namApplyWasmPreset(preset) {
    _namCurrentPreset = preset;

    // Apply gains without persisting to localStorage — preset gains are
    // transient and should not overwrite the user's saved global gains.
    if (preset.input_gain !== undefined) _namApplyInputGain(preset.input_gain);
    if (preset.output_gain !== undefined) _namApplyOutputGain(preset.output_gain);

    // Apply gate threshold
    if (_namWorkletNode && preset.gate_threshold !== undefined) {
        _namWorkletNode.port.postMessage({
            type: 'set-gate',
            threshold: preset.gate_threshold,
        });
    }

    // Load model
    if (preset.model_file) {
        await _namLoadModel(preset.model_file);
    }

    // Load IR (or bypass)
    if (preset.ir_file) {
        await _namLoadIR(preset.ir_file);
    } else {
        _namBypassIR();
    }

    console.log('[NAM] Applied preset:', preset.name || preset.preset_name);
}

// ── Tone Auto-Switching ────────────────────────────────────────────────────

async function _namLoadMappings(filename) {
    _namCurrentFilename = filename;
    _namMappings = {};
    _namCurrentTone = null;
    try {
        const resp = await fetch(`/api/plugins/nam_tone/mappings/${encodeURIComponent(decodeURIComponent(filename))}`);
        const data = await resp.json();
        for (const m of data) {
            _namMappings[m.tone_key] = m;
        }

        // Pre-cache models for fast switching
        if (_namEnabled) {
            for (const m of data) {
                if (m.model_file && !_namModelCache[m.model_file]) {
                    fetch(`/api/plugins/nam_tone/file/model/${encodeURIComponent(m.model_file)}`)
                        .then(r => r.text())
                        .then(json => { _namModelCache[m.model_file] = json; })
                        .catch(() => {});
                }
            }
            _namApplyCurrentSongTone(true).catch(e => console.warn('[NAM] Failed to apply active mapped tone:', e.message));
        }
    } catch (e) {
        console.warn('[NAM] Failed to load mappings:', e.message);
    }
}

function _namReadyForToneApply() {
    return _namNativeMode ? _namNativeReady : _namWasmReady;
}

function _namActiveToneName() {
    if (!window.highway) return null;
    try {
        const t = highway.getTime();
        const changes = highway.getToneChanges();
        const base = highway.getToneBase();
        let activeTone = base;

        if (changes && changes.length) {
            for (const tc of changes) {
                if (tc.t <= t) {
                    activeTone = tc.name;
                } else {
                    break;
                }
            }
        }

        return activeTone || null;
    } catch (e) {
        console.warn('[NAM] Failed to read active song tone:', e.message);
        return null;
    }
}

function _namSamePreset(a, b) {
    if (!a || !b) return false;
    const aId = a.preset_id !== undefined ? a.preset_id : a.id;
    const bId = b.preset_id !== undefined ? b.preset_id : b.id;
    return aId !== undefined && bId !== undefined && String(aId) === String(bId);
}

function _namFindMappingForTone(toneName) {
    if (!toneName) return null;
    if (_namMappings[toneName]) return { tone: toneName, mapping: _namMappings[toneName] };

    const wanted = String(toneName).trim().toLowerCase();
    for (const [tone, mapping] of Object.entries(_namMappings)) {
        if (String(tone).trim().toLowerCase() === wanted) {
            return { tone, mapping };
        }
    }
    return null;
}

function _namFallbackMappingForCurrentSong() {
    const entries = Object.entries(_namMappings);
    if (!entries.length) return null;

    const songInfo = window.slopsmith && window.slopsmith.currentSong ? window.slopsmith.currentSong : {};
    const arrangement = String(songInfo.arrangement || '').toLowerCase();
    const preferred = [];

    if (arrangement.includes('bass')) {
        preferred.push('bass');
    } else if (arrangement.includes('rhythm')) {
        preferred.push('rhythm', 'dist', 'lead');
    } else {
        preferred.push('lead', 'dist', 'guitar');
    }

    for (const needle of preferred) {
        const found = entries.find(([tone]) => String(tone).toLowerCase().includes(needle));
        if (found) return { tone: found[0], mapping: found[1], fallback: true };
    }

    return { tone: entries[0][0], mapping: entries[0][1], fallback: true };
}

async function _namApplyCurrentSongTone(force = false) {
    if (!_namEnabled || !_namCurrentFilename || _namBuilding || _namToneApplyPending) return false;
    if (!_namReadyForToneApply() || Object.keys(_namMappings).length === 0) return false;

    const activeTone = _namActiveToneName();
    const selected = _namFindMappingForTone(activeTone) || _namFallbackMappingForCurrentSong();
    if (!selected) return false;

    const { tone, mapping, fallback } = selected;

    if (!force && tone === _namCurrentTone && _namSamePreset(_namCurrentPreset, mapping)) {
        return true;
    }

    _namToneApplyPending = true;
    try {
        await _namApplyPreset(mapping);
        _namCurrentTone = tone;
        console.log(`[NAM] Tone switch${fallback ? ' fallback' : ''}: ${tone} -> preset "${mapping.preset_name}"`);
        return true;
    } catch (e) {
        console.warn('[NAM] Failed to apply mapped tone:', e.message || e);
        return false;
    } finally {
        _namToneApplyPending = false;
    }
}

async function _namEnsureNativeAlive() {
    if (!_namEnabled || !_namNativeMode || !_namNativeReady || !_namCurrentPreset || _namNativeRecoverPending) return;

    const now = Date.now();
    if (now - _namLastNativeRecoverAt < 1500) return;
    _namLastNativeRecoverAt = now;

    const api = _namDesktopAudio();
    if (!api) return;

    _namNativeRecoverPending = true;
    try {
        let recovered = false;
        if (typeof api.isAudioRunning === 'function') {
            const running = await api.isAudioRunning().catch(() => true);
            if (!running) {
                await api.startAudio();
                _namNativeStartedAudio = true;
                recovered = true;
            }
        }
        if (typeof api.isMonitorMuted === 'function') {
            const muted = await api.isMonitorMuted().catch(() => false);
            if (muted && typeof api.setMonitorMute === 'function') {
                await api.setMonitorMute(false);
                recovered = true;
            }
        }
        if (typeof api.getChainState === 'function') {
            const chain = await api.getChainState().catch(() => null);
            if (Array.isArray(chain) && chain.length === 0) {
                await _namApplyPreset(_namCurrentPreset);
                recovered = true;
            }
        }
        if (recovered) {
            console.log('[NAM] Recovered native desktop audio path');
        }
    } catch (e) {
        console.warn('[NAM] Native keep-alive failed:', e.message || e);
    } finally {
        _namNativeRecoverPending = false;
    }
}

function _namCheckToneChange() {
    if (!_namEnabled || !_namCurrentFilename || _namBuilding) return;
    if ((_namNativeMode ? !_namNativeReady : !_namWasmReady) || Object.keys(_namMappings).length === 0) return;

    _namEnsureNativeAlive();
    _namApplyCurrentSongTone(false);
}

setInterval(_namCheckToneChange, 100);

// ── Guitar Stem Ducking ────────────────────────────────────────────────────

let _namDuckedStems = [];

function _namDuckGuitarStem() {
    if (!_namDuckGuitar || !_namEnabled) return;
    const stems = window._stemsState;
    if (!stems) return;
    _namDuckedStems = [];
    for (const s of stems) {
        if (/guitar/i.test(s.id) && s.gain) {
            _namDuckedStems.push({ stem: s, prevGain: s.gain.gain.value });
            s.gain.gain.value = 0;
        }
    }
}

window.addEventListener('stems:state', () => {
    if (_namEnabled && _namDuckGuitar) _namDuckGuitarStem();
});

function _namCaptureTestBackup() {
    if (_namTestBackup) return;
    _namTestBackup = {
        enabled: _namEnabled,
        currentFilename: _namCurrentFilename,
        mappings: { ..._namMappings },
        currentTone: _namCurrentTone,
        currentPreset: _namCurrentPreset,
    };
}

async function _namRestoreTestBackup() {
    const backup = _namTestBackup;
    _namTestBackup = null;
    if (!backup) return;

    _namRestoreTestContext(backup);
    _namEnabled = !!backup.enabled;

    if (_namEnabled) {
        let restored = await _namApplyCurrentSongTone(true);
        if (!restored && _namCurrentPreset) {
            if (_namGraphActive()) {
                await _namApplyPreset(_namCurrentPreset);
            } else {
                await _namBuildGraph();
                _namDuckGuitarStem();
            }
            restored = true;
        }
        if (!restored && _namGraphActive()) {
            await _namTeardown();
            _namEnabled = false;
            _namCurrentPreset = null;
            _namCurrentTone = null;
        }
    }
}

function _namRestoreTestContext(backup) {
    _namCurrentFilename = backup.currentFilename;
    _namMappings = backup.mappings || {};
    _namCurrentTone = backup.currentTone;
    _namCurrentPreset = backup.currentPreset;
}

function _namRestoreGuitarStem() {
    for (const d of _namDuckedStems) {
        if (d.stem.gain) {
            d.stem.gain.gain.value = d.stem.on ? d.stem.vol : 0;
        }
    }
    _namDuckedStems = [];
}

// ── Teardown ───────────────────────────────────────────────────────────────

async function _namTeardown() {
    if (_namNativeMode) {
        const api = _namDesktopAudio();
        if (api) {
            await Promise.resolve(api.clearChain()).catch(e => console.warn('[NAM] Native clear failed:', e));
            if (_namNativeStartedAudio && typeof api.stopAudio === 'function') {
                await Promise.resolve(api.stopAudio()).catch(e => console.warn('[NAM] Native stop failed:', e));
            }
            if (typeof api.setMonitorMute === 'function') {
                await Promise.resolve(api.setMonitorMute(true)).catch(() => {});
            }
        }
        _namNativeReady = false;
        _namNativeMode = false;
        _namNativeLatencyText = null;
        _namNativeStartedAudio = false;
        _namUpdateStatus();
    }

    if (_namStream) {
        _namStream.getTracks().forEach(t => t.stop());
        _namStream = null;
    }
    if (_namSource) { try { _namSource.disconnect(); } catch (_) {} _namSource = null; }
    if (_namInputGain) { try { _namInputGain.disconnect(); } catch (_) {} _namInputGain = null; }
    if (_namWorkletNode) { try { _namWorkletNode.disconnect(); } catch (_) {} }
    if (_namConvolver) { try { _namConvolver.disconnect(); } catch (_) {} _namConvolver = null; }
    if (_namBypassGain) { try { _namBypassGain.disconnect(); } catch (_) {} _namBypassGain = null; }
    if (_namOutputGain) { try { _namOutputGain.disconnect(); } catch (_) {} _namOutputGain = null; }
    // Keep _namCtx and _namWorkletNode alive for reuse
    _namRestoreGuitarStem();
}

// ── Player Controls ────────────────────────────────────────────────────────

function _namInjectButton() {
    const controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-nam')) return;

    const closeBtn = controls.querySelector('button:last-child');
    const btn = document.createElement('button');
    btn.id = 'btn-nam';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    btn.textContent = 'AMP';
    btn.title = 'Toggle NAM amp modeling';
    btn.onclick = _namToggle;
    controls.insertBefore(btn, closeBtn);
    _namUpdateAmpButton();
}

async function _namToggle() {
    _namEnabled = !_namEnabled;
    if (!_namEnabled) {
        if (_namTestBackup) {
            _namRestoreTestContext(_namTestBackup);
            _namTestBackup = null;
        }
        _namTestMode = false;
        _namTestPresetId = null;
    }
    _namUpdateAmpButton();
    if (_namEnabled) {
        _namBuildGraph().then(async () => {
            await _namApplyCurrentSongTone(true);
            _namDuckGuitarStem();
        }).catch(e => {
            _namBuilding = false;
            _namEnabled = false;
            _namRestoreGuitarStem();
            _namTeardown().catch(err => console.warn('[NAM] Teardown after build failure failed:', err));
            _namUpdateAmpButton();
            _namUpdatePresetTestButtons();
            _namUpdateStatus();
            console.error('[NAM] Build failed:', e);
        });
    } else {
        _namCurrentPreset = null;
        _namCurrentTone = null;
        await _namTeardown();
        _namUpdatePresetTestButtons();
    }
}

// ── playSong Hook ──────────────────────────────────────────────────────────

(function() {
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        await origPlaySong(filename, arrangement);
        _namInjectButton();
        _namLoadMappings(filename);
        if (_namEnabled) {
            _namDuckGuitarStem();
        }
    };
})();

// ── showScreen Hook ────────────────────────────────────────────────────────

(function() {
    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        if (id !== 'plugin-nam_tone' && _namTestMode) {
            window.namStopPresetTest();
        }
        origShowScreen(id);
        if (id === 'plugin-nam_tone') _namInitScreen();
        if (id === 'settings') setTimeout(_namInitSettingsControls, 0);
    };
})();

// ── Config Screen Handlers ─────────────────────────────────────────────────

async function _namInitScreen() {
    await Promise.all([
        _namRefreshModels(),
        _namRefreshIRs(),
        _namRefreshPresets(),
    ]);
    _namUpdateStatus();
}

function _namGraphActive() {
    return (_namNativeMode && _namNativeReady)
        || !!(_namStream && _namInputGain && _namWorkletNode && _namOutputGain);
}

function _namUpdateAmpButton() {
    const btn = document.getElementById('btn-nam');
    if (!btn) return;
    btn.className = _namEnabled
        ? 'px-3 py-1.5 bg-green-700/40 hover:bg-green-700/60 rounded-lg text-xs text-green-300 transition'
        : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
}

function _namUpdatePresetTestButtons() {
    document.querySelectorAll('[data-nam-test-preset-id]').forEach(btn => {
        const isActive = _namTestMode && String(btn.dataset.namTestPresetId) === String(_namTestPresetId);
        btn.textContent = isActive ? 'Stop' : 'Test';
        btn.className = isActive
            ? 'px-2 py-1 bg-red-700/50 hover:bg-red-700/70 rounded text-xs text-red-100 transition'
            : 'px-2 py-1 bg-green-700/40 hover:bg-green-700/60 rounded text-xs text-green-300 transition';
        btn.setAttribute('onclick', isActive ? 'namStopPresetTest()' : `namTestPreset(${btn.dataset.namTestPresetId})`);
    });
    _namUpdateSettingsPresetTestControls();
}

async function _namGetPresetById(presetId) {
    const resp = await fetch('/api/plugins/nam_tone/presets');
    const presets = await resp.json();
    return presets.find(p => String(p.id) === String(presetId)) || null;
}

function _namUpdateSettingsPresetTestControls() {
    const section = document.getElementById('nam-settings-preset-test-section');
    const select = document.getElementById('nam-settings-preset-select');
    const button = document.getElementById('nam-settings-preset-test-button');
    if (!section || !select || !button) return;

    const presetId = select.value;
    const isActive = _namTestMode && presetId && String(presetId) === String(_namTestPresetId);
    button.disabled = !presetId;
    button.textContent = isActive ? 'Stop' : 'Test';
    button.removeAttribute('data-nam-test-preset-id');
    button.setAttribute('onclick', 'namTestSettingsPreset()');
    button.className = isActive
        ? 'px-3 py-2 bg-red-700/50 hover:bg-red-700/70 rounded-lg text-xs text-red-100 transition'
        : 'px-3 py-2 bg-green-700/40 hover:bg-green-700/60 rounded-lg text-xs text-green-300 transition';
    button.classList.toggle('opacity-60', !presetId);
    button.classList.toggle('cursor-not-allowed', !presetId);
    _namUpdateSettingsPresetTestStatus();
}

async function _namPopulateSettingsPresetSelector(presets = null) {
    const section = document.getElementById('nam-settings-preset-test-section');
    const select = document.getElementById('nam-settings-preset-select');
    if (!section || !select) return;

    try {
        if (!presets) {
            const resp = await fetch('/api/plugins/nam_tone/presets');
            presets = await resp.json();
        }
        presets = Array.isArray(presets) ? presets : [];
        section.classList.toggle('hidden', presets.length === 0);
        if (presets.length === 0) {
            select.innerHTML = '<option value="">No presets</option>';
            _namSettingsPresetTestId = '';
            _namUpdateSettingsPresetTestControls();
            return;
        }

        const current = _namSettingsPresetTestId || select.value || (_namDefaultPresetId || '');
        const selected = presets.some(p => String(p.id) === String(current))
            ? String(current)
            : String(presets[0].id);
        select.innerHTML = presets
            .map(p => `<option value="${p.id}" ${String(p.id) === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
            .join('');
        select.value = selected;
        _namSettingsPresetTestId = selected;
        _namUpdateSettingsPresetTestControls();
    } catch (e) {
        console.warn('[NAM] Settings preset selector populate failed:', e);
        section.classList.add('hidden');
    }
}

function _namUpdateStatus() {
    const el = document.getElementById('nam-status');
    if (!el) return;

    const supported = typeof AudioWorkletNode !== 'undefined';
    const wasmStatus = _namWasmReady ? 'Loaded' : 'Not loaded';
    const desktopApi = _namDesktopAudio();
    const isNativeActive = !!desktopApi && (_namNativeMode || (!_namEnabled && _namEngineMode === 'native'));
    const modeText = isNativeActive ? 'Desktop Native' : 'Browser WASM';
    const modeClass = isNativeActive ? 'text-green-400' : 'text-yellow-400';
    const latencyText = isNativeActive
        ? (_namNativeLatencyText || 'Reported latency: N/A')
        : (_namCtx ? Math.round((_namCtx.baseLatency + _namCtx.outputLatency) * 1000) + 'ms' : 'N/A');

    el.innerHTML = `
        <div class="bg-dark-700/50 border border-gray-800/50 rounded-xl p-3 flex flex-wrap items-center gap-4 text-xs">
            <span class="${modeClass}">
                Mode: ${modeText}
            </span>
            <span class="${supported ? 'text-green-400' : 'text-red-400'}">
                AudioWorklet: ${supported ? 'Supported' : 'Not supported'}
            </span>
            <span class="${_namWasmReady ? 'text-green-400' : 'text-yellow-400'}">
                WASM: ${wasmStatus}
            </span>
            <span class="text-gray-500">
                Latency: ${latencyText}
            </span>
        </div>`;
}

async function _namRefreshModels() {
    const el = document.getElementById('nam-model-list');
    if (!el) return;
    const resp = await fetch('/api/plugins/nam_tone/models');
    const models = await resp.json();
    if (models.length === 0) {
        el.innerHTML = '<p class="text-gray-600 text-xs py-2">No .nam models uploaded yet.</p>';
        return;
    }
    el.innerHTML = models.map(m => `
        <div class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-dark-700/30">
            <span class="text-sm text-gray-300">${esc(m.name)}</span>
            <div class="flex items-center gap-2">
                <span class="text-xs text-gray-600">${(m.size / 1024).toFixed(0)} KB</span>
                <button onclick="namDeleteModel('${esc(m.name).replace(/'/g, "\\'")}')"
                    class="text-xs text-red-400/60 hover:text-red-400 transition">Delete</button>
            </div>
        </div>
    `).join('');
}

async function _namRefreshIRs() {
    const el = document.getElementById('nam-ir-list');
    if (!el) return;
    const resp = await fetch('/api/plugins/nam_tone/irs');
    const irs = await resp.json();
    if (irs.length === 0) {
        el.innerHTML = '<p class="text-gray-600 text-xs py-2">No .wav IR files uploaded yet.</p>';
        return;
    }
    el.innerHTML = irs.map(m => `
        <div class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-dark-700/30">
            <span class="text-sm text-gray-300">${esc(m.name)}</span>
            <div class="flex items-center gap-2">
                <span class="text-xs text-gray-600">${(m.size / 1024).toFixed(0)} KB</span>
                <button onclick="namDeleteIR('${esc(m.name).replace(/'/g, "\\'")}')"
                    class="text-xs text-red-400/60 hover:text-red-400 transition">Delete</button>
            </div>
        </div>
    `).join('');
}

async function _namRefreshPresets() {
    const el = document.getElementById('nam-preset-list');
    if (!el) return;
    const resp = await fetch('/api/plugins/nam_tone/presets');
    const presets = await resp.json();
    if (presets.length === 0) {
        el.innerHTML = '<p class="text-gray-600 text-xs py-2">No presets created yet.</p>';
        return;
    }
    el.innerHTML = presets.map(p => `
        <div class="flex items-center justify-between py-2 px-3 rounded-xl bg-dark-700/30 border border-gray-800/30">
            <div class="flex-1 min-w-0">
                <span class="text-sm font-semibold text-white">${esc(p.name)}</span>
                <div class="text-xs text-gray-500 mt-0.5">
                    Model: ${esc(p.model_file || 'None')} · IR: ${esc(p.ir_file || 'None')}
                </div>
            </div>
            <div class="flex items-center gap-2">
                <button data-nam-test-preset-id="${p.id}" onclick="${_namTestMode && String(_namTestPresetId) === String(p.id) ? 'namStopPresetTest()' : `namTestPreset(${p.id})`}"
                    class="${_namTestMode && String(_namTestPresetId) === String(p.id)
                        ? 'px-2 py-1 bg-red-700/50 hover:bg-red-700/70 rounded text-xs text-red-100 transition'
                        : 'px-2 py-1 bg-green-700/40 hover:bg-green-700/60 rounded text-xs text-green-300 transition'}">
                    ${_namTestMode && String(_namTestPresetId) === String(p.id) ? 'Stop' : 'Test'}
                </button>
                <button onclick="namEditPreset(${p.id})"
                    class="px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-400 transition">Edit</button>
                <button onclick="namDeletePreset(${p.id})"
                    class="px-2 py-1 text-xs text-red-400/60 hover:text-red-400 transition">Delete</button>
            </div>
        </div>
    `).join('');
    _namUpdatePresetTestButtons();
    _namPopulateSettingsPresetSelector(presets).catch(e => {
        console.warn('[NAM] Settings preset selector refresh failed:', e);
    });

    // Also update preset dropdowns in tone mapping editor
    _namUpdatePresetDropdowns(presets);
}

function _namUpdatePresetDropdowns(presets) {
    document.querySelectorAll('.nam-preset-select').forEach(sel => {
        const current = sel.value;
        sel.innerHTML = '<option value="">-- None --</option>' +
            presets.map(p => `<option value="${p.id}" ${p.id == current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    });
}

// ── Global functions (called from screen.html onclick handlers) ────────────

window.namUploadModel = async function() {
    const input = document.getElementById('nam-model-file');
    if (!input || !input.files.length) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);
    await fetch('/api/plugins/nam_tone/models', { method: 'POST', body: formData });
    input.value = '';
    _namRefreshModels();
    _namRefreshPresets(); // update dropdowns
};

window.namDeleteModel = async function(name) {
    await fetch(`/api/plugins/nam_tone/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
    _namRefreshModels();
};

window.namUploadIR = async function() {
    const input = document.getElementById('nam-ir-file');
    if (!input || !input.files.length) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);
    await fetch('/api/plugins/nam_tone/irs', { method: 'POST', body: formData });
    input.value = '';
    _namRefreshIRs();
    _namRefreshPresets();
};

window.namDeleteIR = async function(name) {
    await fetch(`/api/plugins/nam_tone/irs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    _namRefreshIRs();
};

window.namSavePreset = async function() {
    const name = document.getElementById('nam-preset-name').value.trim();
    if (!name) return;
    const data = {
        name,
        model_file: document.getElementById('nam-preset-model').value,
        ir_file: document.getElementById('nam-preset-ir').value,
        input_gain: parseFloat(document.getElementById('nam-preset-input-gain').value) || 1.0,
        output_gain: parseFloat(document.getElementById('nam-preset-output-gain').value) || 0.5,
        gate_threshold: parseFloat(document.getElementById('nam-preset-gate').value) || -60,
        settings: {},
    };
    await fetch('/api/plugins/nam_tone/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    _namRefreshPresets();
    // Clear form
    document.getElementById('nam-preset-name').value = '';
};

window.namEditPreset = async function(presetId) {
    const resp = await fetch('/api/plugins/nam_tone/presets');
    const presets = await resp.json();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;
    document.getElementById('nam-preset-name').value = preset.name;
    document.getElementById('nam-preset-model').value = preset.model_file || '';
    document.getElementById('nam-preset-ir').value = preset.ir_file || '';
    document.getElementById('nam-preset-input-gain').value = preset.input_gain;
    document.getElementById('nam-preset-output-gain').value = preset.output_gain;
    document.getElementById('nam-preset-gate').value = preset.gate_threshold;
};

window.namDeletePreset = async function(presetId) {
    await fetch(`/api/plugins/nam_tone/presets/${presetId}`, { method: 'DELETE' });
    _namRefreshPresets();
};

window.namStartPresetTest = async function(presetId) {
    if (!presetId) return;
    const preset = await _namGetPresetById(presetId);
    if (!preset) {
        console.warn('[NAM] Preset not found for test:', presetId);
        return;
    }

    _namCaptureTestBackup();
    _namTestMode = true;
    _namTestPresetId = presetId;
    _namEnabled = true;
    _namCurrentFilename = null;
    _namMappings = {};
    _namCurrentTone = null;
    _namCurrentPreset = preset;
    _namUpdateAmpButton();
    _namUpdatePresetTestButtons();
    _namSetSettingsPresetTestStatus('Starting...');

    try {
        if (_namGraphActive()) {
            await _namApplyPreset(preset);
        } else {
            await _namBuildGraph();
        }
        _namDuckGuitarStem();
        _namUpdateStatus();
        _namUpdateSettingsPresetTestStatus();
    } catch (e) {
        console.error('[NAM] Preset tone test failed:', e);
        _namTestMode = false;
        _namTestPresetId = null;
        _namBuilding = false;
        try {
            await _namTeardown();
            await _namRestoreTestBackup();
        } catch (restoreError) {
            console.error('[NAM] Failed to restore preset test context:', restoreError);
        } finally {
            _namUpdateAmpButton();
            _namUpdatePresetTestButtons();
            _namUpdateStatus();
        }
        _namSetSettingsPresetTestStatus('Test failed', 'error');
    }
};

window.namTestPreset = async function(presetId) {
    if (_namTestMode && String(_namTestPresetId) === String(presetId)) {
        window.namStopPresetTest();
        return;
    }
    await window.namStartPresetTest(presetId);
};

window.namStopPresetTest = async function() {
    _namTestMode = false;
    _namTestPresetId = null;
    const wasEnabled = _namTestBackup && _namTestBackup.enabled;
    let restoreFailed = false;
    try {
        if (!wasEnabled) await _namTeardown();
        await _namRestoreTestBackup();
        if (!wasEnabled) _namEnabled = false;
    } catch (e) {
        restoreFailed = true;
        console.error('[NAM] Failed to restore preset test context:', e);
    } finally {
        _namUpdateAmpButton();
        _namUpdatePresetTestButtons();
        _namUpdateStatus();
        if (restoreFailed) {
            _namSetSettingsPresetTestStatus('Restore failed', 'error');
        } else {
            _namUpdateSettingsPresetTestStatus();
        }
    }
};

window.namSearchSongs = async function() {
    const q = document.getElementById('nam-search').value.trim();
    if (!q) return;
    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=artist`);
    const data = await resp.json();
    const container = document.getElementById('nam-search-results');

    if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No results</p>';
        return;
    }

    container.innerHTML = data.songs.map(s => `
        <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer"
             onclick="namEditSong('${encodeURIComponent(s.filename)}', '${esc(s.title).replace(/'/g,"\\'")} - ${esc(s.artist).replace(/'/g,"\\'")}')">
            <div class="flex-1 min-w-0">
                <span class="text-sm text-white">${esc(s.title)}</span>
                <span class="text-xs text-gray-500 ml-2">${esc(s.artist)}</span>
            </div>
            <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
        </div>
    `).join('');
};

window.namEditSong = async function(encodedFilename, displayName) {
    const filename = decodeURIComponent(encodedFilename);
    document.getElementById('nam-search-results').innerHTML = '';
    document.getElementById('nam-mapping-editor').classList.remove('hidden');
    document.getElementById('nam-mapping-title').textContent = displayName;

    // Fetch tones, mappings, and presets in parallel
    const [tonesResp, mappingsResp, presetsResp] = await Promise.all([
        fetch(`/api/plugins/nam_tone/song-tones/${encodeURIComponent(filename)}`),
        fetch(`/api/plugins/nam_tone/mappings/${encodeURIComponent(filename)}`),
        fetch('/api/plugins/nam_tone/presets'),
    ]);
    const tonesData = await tonesResp.json();
    const mappingsData = await mappingsResp.json();
    const presets = await presetsResp.json();

    const tones = tonesData.tones || [];
    const mappingsByKey = {};
    for (const m of mappingsData) {
        mappingsByKey[m.tone_key] = m;
    }

    const container = document.getElementById('nam-tone-mappings');
    if (tones.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">No tones found in this song.</p>';
        return;
    }

    container.innerHTML = tones.map(t => {
        const m = mappingsByKey[t.key] || {};
        return `<div class="bg-dark-700/50 border border-gray-800/50 rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <span class="text-sm font-semibold text-white">${esc(t.name)}</span>
                    <span class="text-xs text-gray-600 ml-2">${esc(t.arrangement)}</span>
                </div>
            </div>
            <div>
                <label class="text-[10px] text-gray-500 block mb-1">Preset</label>
                <select data-tone="${esc(t.key)}" class="nam-tone-preset w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                    <option value="">-- None --</option>
                    ${presets.map(p =>
                        `<option value="${p.id}" ${p.id == m.preset_id ? 'selected' : ''}>${esc(p.name)}</option>`
                    ).join('')}
                </select>
            </div>
        </div>`;
    }).join('');

    // Auto-save on change
    container.querySelectorAll('.nam-tone-preset').forEach(sel => {
        sel.addEventListener('change', () => {
            const toneKey = sel.dataset.tone;
            const presetId = parseInt(sel.value);
            if (!presetId) return;
            fetch(`/api/plugins/nam_tone/mappings/${encodeURIComponent(filename)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tone_key: toneKey, preset_id: presetId }),
            });
        });
    });
};

// ── Settings Widget Handlers ───────────────────────────────────────────────

// Internal helpers: update the cached value, GainNode, and UI label without
// persisting to localStorage. Used by _namApplyPreset so tone/preset changes
// don't overwrite the user's saved global gains.
function _namApplyInputGain(val) {
    _namInputGainVal = parseFloat(val);
    if (_namInputGain) _namInputGain.gain.value = _namInputGainVal;
    const label = document.getElementById('nam-input-gain-label');
    if (label) label.textContent = _namInputGainVal.toFixed(1);
    const slider = document.getElementById('nam-input-gain-slider');
    if (slider) slider.value = _namInputGainVal;
}

function _namApplyOutputGain(val) {
    _namOutputGainVal = parseFloat(val);
    if (_namOutputGain) _namOutputGain.gain.value = _namOutputGainVal;
    const label = document.getElementById('nam-output-gain-label');
    if (label) label.textContent = _namOutputGainVal.toFixed(2);
    const slider = document.getElementById('nam-output-gain-slider');
    if (slider) slider.value = _namOutputGainVal;
}

function _namInitSettingsControls() {
    _namApplyInputGain(_namInputGainVal);
    _namApplyOutputGain(_namOutputGainVal);

    const browserDevice = document.getElementById('nam-device-select');
    if (browserDevice) browserDevice.value = _namDeviceId;
    const channel = document.getElementById('nam-channel-select');
    if (channel) channel.value = _namChannel;
    const gate = document.getElementById('nam-gate-slider');
    if (gate) gate.value = _namGateThreshold;
    const gateLabel = document.getElementById('nam-gate-label');
    if (gateLabel) gateLabel.textContent = _namGateThreshold.toFixed(0) + ' dB';
    const duck = document.getElementById('nam-duck-guitar');
    if (duck) duck.checked = _namDuckGuitar;

    const api = _namDesktopAudio();
    const nativeAvailable = _namSupportsNativeDeviceSettings(api);
    _namUpdateEngineModeControls(nativeAvailable);
    _namUpdateEngineModeVisibility(nativeAvailable);
    if (nativeAvailable && _namEngineMode === 'native') window.namPopulateNativeDevices().catch(e => {
        console.warn('[NAM] Native device populate failed:', e);
        _namSetNativeDeviceStatus('Unavailable', 'error');
    });
    if (!nativeAvailable || _namEngineMode === 'wasm') window.namPopulateDevices().catch(e => {
        console.warn('[NAM] Browser device populate failed:', e);
    });
    _namPopulateSettingsPresetSelector().catch(e => {
        console.warn('[NAM] Settings preset test populate failed:', e);
    });
}

async function _namRebuildActiveGraphForEngineChange() {
    if (!_namEnabled) return;
    const preset = _namCurrentPreset;
    _namSetSettingsPresetTestStatus('Switching...');
    await _namTeardown();
    _namCurrentPreset = preset;
    await _namBuildGraph();
    if (_namTestMode && preset) {
        await _namApplyPreset(preset);
    } else {
        await _namApplyCurrentSongTone(true);
    }
    _namDuckGuitarStem();
    _namUpdateStatus();
    _namUpdateSettingsPresetTestStatus();
}

async function _namRebuildBrowserWasmPath() {
    if (!_namEnabled || _namNativeMode) return;
    const preset = _namCurrentPreset;
    const tone = _namCurrentTone;
    try {
        await _namTeardown();
        _namCurrentPreset = preset;
        _namCurrentTone = tone;
        await _namBuildWasmGraph();
        if (_namTestMode && preset) {
            await _namApplyWasmPreset(preset);
        } else {
            await _namApplyCurrentSongTone(true);
        }
        _namDuckGuitarStem();
        _namUpdateStatus();
        _namUpdateSettingsPresetTestStatus();
    } catch (e) {
        console.error('[NAM] Browser input rebuild failed:', e);
        _namBuilding = false;
        _namEnabled = false;
        _namRestoreGuitarStem();
        _namUpdateAmpButton();
        _namUpdatePresetTestButtons();
        _namUpdateStatus();
        _namSetSettingsPresetTestStatus('Input switch failed', 'error');
    }
}

async function _namStopSettingsPresetTestForSettingChange() {
    if (!_namTestMode) return false;
    await window.namStopPresetTest();
    _namHideSettingsPresetTestStatus();
    return true;
}

window.namSetEngineMode = async function(mode) {
    const next = mode === 'wasm' ? 'wasm' : 'native';
    if (_namEngineMode === next) return;
    await _namStopSettingsPresetTestForSettingChange();
    _namEngineMode = next;
    _namSaveSettings();

    _namUpdateEngineModeVisibility(_namSupportsNativeDeviceSettings(_namDesktopAudio()));
    if (_namEngineMode === 'native') window.namPopulateNativeDevices().catch(e => {
        console.warn('[NAM] Native device populate failed:', e);
        _namSetNativeDeviceStatus('Unavailable', 'error');
    });
    if (_namEngineMode === 'wasm') window.namPopulateDevices().catch(e => {
        console.warn('[NAM] Browser device populate failed:', e);
    });

    _namRebuildActiveGraphForEngineChange().catch(e => {
        console.error('[NAM] Engine switch failed:', e);
        _namBuilding = false;
        _namEnabled = false;
        _namTeardown().catch(err => console.warn('[NAM] Teardown after engine switch failed:', err));
        _namUpdateAmpButton();
        _namUpdatePresetTestButtons();
        _namUpdateStatus();
        _namSetSettingsPresetTestStatus('Switch failed', 'error');
    });
};

window.namSettingsPresetChanged = function() {
    const select = document.getElementById('nam-settings-preset-select');
    _namSettingsPresetTestId = select ? select.value : '';
    _namUpdateSettingsPresetTestControls();
};

window.namTestSettingsPreset = async function() {
    const select = document.getElementById('nam-settings-preset-select');
    const presetId = select ? select.value : '';
    if (!presetId) return;
    await window.namTestPreset(presetId);
};

window.namSelectNativeDeviceType = async function(typeName) {
    await _namStopSettingsPresetTestForSettingChange();
    const settings = _namNativeDeviceFormValues();
    _namRenderNativeDeviceDropdowns(typeName, settings.input, settings.output);
    _namUpdateNativeApplyButtonState();
    await window.namRefreshNativeDeviceOptions();
};

window.namRefreshNativeDeviceOptions = async function(forceRefresh = false) {
    await _namStopSettingsPresetTestForSettingChange();
    const api = _namDesktopAudio();
    if (!_namSupportsNativeDeviceSettings(api) || !await _namDesktopAudioAvailable(api)) {
        _namSetNativeDeviceStatus('Unavailable', 'error');
        return;
    }

    _namSetNativeDeviceBusy(true);
    _namSetNativeDeviceStatus(forceRefresh ? 'Refreshing buffers...' : 'Loading buffers...');
    try {
        const settings = _namNativeDeviceFormValues();
        await _namRefreshNativeDeviceTimingControls(api, null, settings, true, forceRefresh);
        _namSetNativeDeviceStatus(forceRefresh ? 'Options refreshed' : 'Options ready', 'ok');
        _namUpdateNativeApplyButtonState();
    } catch (e) {
        console.warn('[NAM] Native buffer refresh failed:', e);
        _namSetNativeDeviceStatus('Refresh failed', 'error');
    } finally {
        _namSetNativeDeviceBusy(false);
        _namUpdateNativeApplyButtonState();
    }
};

window.namNativeDeviceSettingChanged = async function() {
    await _namStopSettingsPresetTestForSettingChange();
    _namUpdateNativeApplyButtonState();
};

window.namPopulateNativeDevices = async function(forceRefresh = false) {
    if (forceRefresh) await _namStopSettingsPresetTestForSettingChange();
    const api = _namDesktopAudio();
    if (!_namSupportsNativeDeviceSettings(api) || !await _namDesktopAudioAvailable(api)) {
        _namUpdateEngineModeControls(false);
        _namUpdateEngineModeVisibility(false);
        return;
    }
    _namUpdateEngineModeControls(true);
    _namUpdateEngineModeVisibility(true);

    if (forceRefresh) _namNativeDeviceOptionsCache.clear();
    _namSetNativeDeviceBusy(true);
    _namSetNativeDeviceStatus(forceRefresh ? 'Refreshing devices...' : 'Loading...');
    try {
        const [types, rates, buffers, current] = await Promise.all([
            api.getDeviceTypes(),
            api.getSampleRates(),
            api.getBufferSizes(),
            api.getCurrentDevice().catch(() => null),
        ]);
        _namNativeDeviceTypes = _namSupportedNativeDeviceTypes(types);
        const form = _namNativeDeviceFormValues();
        const saved = _namLoadNativeDeviceSettings() || {};
        const preferredType = (forceRefresh && form.type) || saved.type || (current && current.type) || '';
        const type = _namNativeDeviceTypes.some(t => t.name === preferredType)
            ? preferredType
            : ((_namNativeDeviceTypes[0] && _namNativeDeviceTypes[0].name) || '');
        const input = forceRefresh ? form.input : (saved.input !== undefined ? saved.input : ((current && current.input) || ''));
        const output = forceRefresh ? form.output : (saved.output !== undefined ? saved.output : ((current && current.output) || ''));
        const sampleRate = (forceRefresh && form.sampleRate) || saved.sampleRate || (current && current.sampleRate) || 48000;
        const bufferSize = (forceRefresh && form.bufferSize) || saved.bufferSize || (current && current.blockSize) || 256;

        _namSetSelectOptions(
            document.getElementById('nam-native-device-type'),
            _namNativeDeviceTypes.map(t => t.name),
            type,
            null
        );
        const selectedDevices = _namRenderNativeDeviceDropdowns(type, input, output);
        await _namRefreshNativeDeviceTimingControls(api, current, {
            type,
            input: selectedDevices.input,
            output: selectedDevices.output,
            sampleRate,
            bufferSize,
            channel: _namChannel,
        }, true, forceRefresh);
        _namNativeAppliedSettings = _namNativeSettingsFromDevice(current, {
            type,
            input: selectedDevices.input,
            output: selectedDevices.output,
            sampleRate,
            bufferSize,
            channel: _namChannel,
        });
        _namSetNativeDeviceStatus(forceRefresh ? 'Options refreshed' : 'Options ready', 'ok');
        _namUpdateNativeApplyButtonState();
    } catch (e) {
        console.warn('[NAM] Native device populate failed:', e);
        _namSetNativeDeviceStatus(forceRefresh ? 'Refresh failed' : 'Unavailable', 'error');
    } finally {
        _namSetNativeDeviceBusy(false);
        _namUpdateNativeApplyButtonState();
    }
};

window.namApplyNativeDevice = async function() {
    await _namStopSettingsPresetTestForSettingChange();
    const api = _namDesktopAudio();
    if (!_namSupportsNativeDeviceSettings(api) || !await _namDesktopAudioAvailable(api)) {
        _namSetNativeDeviceStatus('Unavailable', 'error');
        return;
    }

    _namSetNativeDeviceBusy(true);
    _namSetNativeDeviceStatus('Applying...');
    try {
        const settings = _namNativeDeviceFormValues();
        const ok = await _namApplyNativeDeviceSettings(api, settings, _namEnabled && _namNativeMode);
        if (!ok) {
            _namSetNativeDeviceStatus('Failed', 'error');
            return;
        }
        if (typeof api.setInputChannel === 'function') await api.setInputChannel(_namNativeInputChannel());
        const actualDevice = await api.getCurrentDevice().catch(() => null);
        _namRememberAcceptedNativeBuffer(settings, actualDevice);
        const actual = await _namRefreshNativeDeviceTimingControls(api, actualDevice, settings, false, false, true);
        const appliedSettings = _namActualNativeDeviceSettings(settings, actual);
        _namNativeAppliedSettings = _namNormalizeNativeSettings(appliedSettings);
        _namSaveNativeDeviceSettings(appliedSettings);
        await _namRefreshNativeLatency(api, settings);
        _namSetNativeDeviceStatus(_namNativeLatencyText || 'Applied', 'ok');
        _namUpdateStatus();
        _namUpdateNativeApplyButtonState();
    } catch (e) {
        console.warn('[NAM] Native device apply failed:', e);
        _namSetNativeDeviceStatus('Failed', 'error');
        _namUpdateStatus();
        _namUpdateNativeApplyButtonState();
    } finally {
        _namSetNativeDeviceBusy(false);
        _namUpdateNativeApplyButtonState();
    }
};

window.namSelectDevice = async function(deviceId) {
    await _namStopSettingsPresetTestForSettingChange();
    _namDeviceId = deviceId;
    _namSaveSettings();
    await _namRebuildBrowserWasmPath();
};

window.namSelectChannel = async function(channel) {
    await _namStopSettingsPresetTestForSettingChange();
    _namChannel = channel;
    _namSaveSettings();
    await _namRebuildBrowserWasmPath();
    _namUpdateNativeApplyButtonState();
};

window.namSetInputGain = function(val) {
    _namApplyInputGain(val);
    _namSetNativeGain('input', _namInputGainVal);
    _namSavedInputGainVal = _namInputGainVal;
    _namSaveSettings();
};

window.namSetOutputGain = function(val) {
    _namApplyOutputGain(val);
    _namSetNativeGain('output', _namOutputGainVal);
    _namSavedOutputGainVal = _namOutputGainVal;
    _namSaveSettings();
};

window.namSetGateThreshold = function(val) {
    _namGateThreshold = parseFloat(val);
    if (_namWorkletNode) {
        _namWorkletNode.port.postMessage({ type: 'set-gate', threshold: _namGateThreshold });
    }
    const api = _namDesktopAudio();
    if (_namNativeMode && api && typeof api.setNoiseGate === 'function') {
        api.setNoiseGate({
            enabled: true,
            thresholdDb: _namGateThreshold,
            releaseMs: 100,
            depthDb: -80,
        }).catch(e => console.warn('[NAM] Native gate update failed:', e));
    }
    _namSaveSettings();
    const label = document.getElementById('nam-gate-label');
    if (label) label.textContent = _namGateThreshold.toFixed(0) + ' dB';
};

window.namSetDuckGuitar = function(checked) {
    _namDuckGuitar = checked;
    _namSaveSettings();
    if (_namEnabled && _namDuckGuitar) _namDuckGuitarStem();
    if (!_namDuckGuitar) _namRestoreGuitarStem();
};

// Populate device dropdown (called when settings screen shows)
window.namPopulateDevices = async function() {
    try {
        // Request permission first if needed
        if (!_namStream) {
            try {
                const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                s.getTracks().forEach(t => t.stop());
            } catch (_) {}
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const sel = document.getElementById('nam-device-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">Default</option>';
        for (const d of devices) {
            if (d.kind !== 'audioinput') continue;
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
            if (d.deviceId === _namDeviceId) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.value = [...sel.options].some(opt => opt.value === _namDeviceId) ? _namDeviceId : '';
    } catch (e) { /* permission not yet granted */ }
};

setTimeout(_namInitSettingsControls, 0);

// Populate model/IR dropdowns in preset editor
window.namPopulatePresetDropdowns = async function() {
    const [modelsResp, irsResp] = await Promise.all([
        fetch('/api/plugins/nam_tone/models'),
        fetch('/api/plugins/nam_tone/irs'),
    ]);
    const models = await modelsResp.json();
    const irs = await irsResp.json();

    const modelSel = document.getElementById('nam-preset-model');
    const irSel = document.getElementById('nam-preset-ir');
    if (modelSel) {
        const cur = modelSel.value;
        modelSel.innerHTML = '<option value="">-- None --</option>' +
            models.map(m => `<option value="${esc(m.name)}" ${m.name === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    }
    if (irSel) {
        const cur = irSel.value;
        irSel.innerHTML = '<option value="">-- None --</option>' +
            irs.map(m => `<option value="${esc(m.name)}" ${m.name === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    }
};

})();
