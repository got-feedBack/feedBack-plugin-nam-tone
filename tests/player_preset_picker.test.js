// Player preset picker — a live NAM preset dropdown next to the AMP toggle.
//
// Pins:
//   1. Mounted the v3 way: into feedBack.ui.playerControlSlot() when the host
//      is v3, else the legacy #player-controls bar (before ✕ Close).
//      Re-injection is idempotent against the actual container.
//   2. Options = "Song tones" + every saved preset; the pick stays selected.
//   3. With AMP off a pick is only remembered (no audio work).
//   4. With AMP on a pick applies live and pauses per-tone auto switching for
//      the rest of the song; the next song clears the pause.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, makeContainer } = require('./_load_screen');

const PRESETS = [
    { id: 1, name: 'Clean', model_file: 'a.nam', ir_file: '', input_gain: 1, output_gain: 0.5, gate_threshold: -60, settings_json: '{}' },
    { id: 2, name: 'Crunch', model_file: 'b.nam', ir_file: '', input_gain: 1, output_gain: 0.5, gate_threshold: -60, settings_json: '{}' },
];

function closeButton() {
    return { tagName: 'BUTTON', id: 'btn-close', parentNode: null };
}

function load({ v3 = true, intervals } = {}) {
    const slot = makeContainer('v3-plugin-controls-slot');
    const bar = makeContainer('player-controls');
    const close = closeButton();
    bar.appendChild(close);
    bar.querySelector = (q) => (q === 'button:last-child' ? bar.childNodes[bar.childNodes.length - 1] : null);
    const env = loadScreen({
        elements: { 'player-controls': bar, 'v3-plugin-controls-slot': slot },
        routes: { '/api/plugins/nam_tone/presets': PRESETS },
        before(sb) {
            sb.playSong = async () => {};
            sb.showScreen = () => {};
            if (intervals) sb.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
            if (v3) {
                sb.feedBack = { uiVersion: 'v3', ui: { playerControlSlot: () => slot } };
            }
        },
    });
    return { ...env, slot, bar, close };
}

const tick = () => new Promise((r) => setImmediate(r));

test('v3: AMP + picker mount into the plugin-control slot, idempotently', async () => {
    const env = load({ v3: true });
    await env.window.playSong('song.archive');
    await tick();
    const ids = env.slot.childNodes.map(c => c.id);
    assert.deepEqual(ids, ['btn-nam', 'nam-preset-picker']);
    assert.equal(env.bar.childNodes.length, 1, 'legacy bar untouched (only ✕ Close)');

    await env.window.playSong('song2.archive');
    await tick();
    assert.equal(env.slot.childNodes.length, 2, 'no duplicates on the next song');
});

test('legacy host: controls go into #player-controls before ✕ Close', async () => {
    const env = load({ v3: false });
    await env.window.playSong('song.archive');
    await tick();
    assert.deepEqual(env.bar.childNodes.map(c => c.id), ['btn-nam', 'nam-preset-picker', 'btn-close']);
});

test('picker lists "Song tones" + presets and remembers the pick with AMP off', async () => {
    const env = load();
    await env.window.playSong('song.archive');
    await tick();
    const sel = env.document.getElementById('nam-preset-picker');
    assert.deepEqual(sel.options.map(o => o.textContent), ['Song tones', 'Clean', 'Crunch']);
    assert.equal(sel.value, '');

    sel.value = '2';
    await env.window.namPlayerSelectPreset();
    // Re-populating (next song / preset list refresh) keeps the pick selected.
    await env.window.playSong('song2.archive');
    await tick();
    assert.equal(env.document.getElementById('nam-preset-picker').value, '2');
});

test('a pick whose preset was deleted falls back to "Song tones"', async () => {
    const env = load();
    await env.window.playSong('song.archive');
    await tick();
    const sel = env.document.getElementById('nam-preset-picker');
    sel.value = '2';
    await env.window.namPlayerSelectPreset();
    PRESETS.splice(1, 1);
    try {
        await env.window.playSong('song2.archive');
        await tick();
        assert.equal(env.document.getElementById('nam-preset-picker').value, '');
    } finally {
        PRESETS.push({ id: 2, name: 'Crunch', model_file: 'b.nam', ir_file: '', input_gain: 1, output_gain: 0.5, gate_threshold: -60, settings_json: '{}' });
    }
});

// AMP-on path through a stubbed desktop native engine: every preset load is
// recorded by the native chain name the route hands back.
function loadWithEngine() {
    const loads = [];
    const intervals = [];
    const slot = makeContainer('v3-plugin-controls-slot');
    const nativeRoute = (id) => () => ({ native_preset: { name: 'p' + id, chain: [] } });
    const mapping = { tone_key: 'Clean', preset_id: 1, preset_name: 'Clean', model_file: 'a.nam' };
    const routes = {
        '/api/plugins/nam_tone/presets': PRESETS,
        '/api/plugins/nam_tone/native-preset/1': nativeRoute(1),
        '/api/plugins/nam_tone/native-preset/2': nativeRoute(2),
        '/api/plugins/nam_tone/mappings/mapped.archive': [mapping],
        '/api/plugins/nam_tone/mappings/plain.archive': [],
    };
    const env = loadScreen({
        elements: { 'v3-plugin-controls-slot': slot },
        routes,
        before(sb) {
            sb.playSong = async () => {};
            sb.showScreen = () => {};
            sb.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
            sb.feedBack = { uiVersion: 'v3', ui: { playerControlSlot: () => slot } };
            sb.highway = { getTime: () => 1, getToneChanges: () => [], getToneBase: () => 'Clean' };
            sb.feedBackDesktop = {
                audio: {
                    isAvailable: async () => true,
                    startAudio: async () => {},
                    isAudioRunning: async () => true,
                    clearChain: async () => {},
                    loadPreset: async (json) => { loads.push(JSON.parse(json).name); return { success: true }; },
                },
            };
        },
    });
    const flush = async () => { for (let i = 0; i < 20; i++) await tick(); };
    const pollTones = () => intervals.forEach(fn => fn());
    return { ...env, loads, flush, pollTones };
}

test('AMP on: a pick applies live and is not reverted by tone mappings', async () => {
    const env = loadWithEngine();
    await env.window.playSong('mapped.archive');
    await env.flush();
    env.document.getElementById('btn-nam').onclick();          // AMP on
    await env.flush();
    assert.equal(env.loads[env.loads.length - 1], 'p1', 'song mapping applied on AMP-on');

    const sel = env.document.getElementById('nam-preset-picker');
    sel.value = '2';
    await env.window.namPlayerSelectPreset();
    await env.flush();
    assert.equal(env.loads[env.loads.length - 1], 'p2', 'pick applied live');

    const before = env.loads.length;
    env.pollTones();
    await env.flush();
    assert.equal(env.loads.length, before, 'tone poll does not revert the pick');

    // Back to "Song tones" hands control back to the mapping.
    sel.value = '';
    await env.window.namPlayerSelectPreset();
    await env.flush();
    assert.equal(env.loads[env.loads.length - 1], 'p1');
});

test('the pick is the fallback for an unmapped song; mappings win on the next mapped song', async () => {
    const env = loadWithEngine();
    await env.window.playSong('plain.archive');
    await env.flush();
    const sel = env.document.getElementById('nam-preset-picker');
    sel.value = '2';
    await env.window.namPlayerSelectPreset();               // AMP off → remembered only
    await env.flush();
    assert.equal(env.loads.length, 0, 'no audio work while AMP is off');

    env.document.getElementById('btn-nam').onclick();          // AMP on, no mapping
    await env.flush();
    assert.equal(env.loads[env.loads.length - 1], 'p2', 'remembered pick applied on AMP-on');

    await env.window.playSong('mapped.archive');             // new song clears the override
    await env.flush();
    assert.equal(env.loads[env.loads.length - 1], 'p1', 'mapped song uses its mapping');
});
