// Editing a preset must not wipe its model / IR.
//
// The preset editor's model/IR <select>s are only filled lazily (onfocus).
// namEditPreset used to assign `select.value = preset.model_file` while the
// select still held just "-- None --" — a value with no matching option reads
// back "", so the next Save POSTed model_file: "" / ir_file: "" and the
// preset lost its amp model and cab.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, makeSelect, makeInput } = require('./_load_screen');

const PRESET = {
    id: 1, name: 'Clean', model_file: 'twin.nam', ir_file: 'cab.wav',
    input_gain: 1.2, output_gain: 0.6, gate_threshold: -55, settings_json: '{}',
};

function editorElements() {
    return {
        'nam-preset-name': makeInput('nam-preset-name'),
        'nam-preset-model': makeSelect('nam-preset-model'),
        'nam-preset-ir': makeSelect('nam-preset-ir'),
        'nam-preset-input-gain': makeInput('nam-preset-input-gain'),
        'nam-preset-output-gain': makeInput('nam-preset-output-gain'),
        'nam-preset-gate': makeInput('nam-preset-gate'),
    };
}

function load({ models = [{ name: 'twin.nam' }], irs = [{ name: 'cab.wav' }], modelsFail = false } = {}) {
    return loadScreen({
        elements: editorElements(),
        routes: {
            '/api/plugins/nam_tone/presets': [PRESET],
            '/api/plugins/nam_tone/models': modelsFail ? () => { throw new Error('offline'); } : models,
            '/api/plugins/nam_tone/irs': irs,
        },
    });
}

test('edit on a fresh screen selects the saved model and IR', async () => {
    const env = load();
    await env.window.namEditPreset(1);
    assert.equal(env.document.getElementById('nam-preset-model').value, 'twin.nam');
    assert.equal(env.document.getElementById('nam-preset-ir').value, 'cab.wav');
    assert.equal(env.document.getElementById('nam-preset-name').value, 'Clean');
});

test('edit then save round-trips model_file / ir_file', async () => {
    const env = load();
    await env.window.namEditPreset(1);
    await env.window.namSavePreset();
    const post = env.posts.find(p => p.url === '/api/plugins/nam_tone/presets');
    assert.ok(post, 'save POSTed the preset');
    assert.equal(post.body.name, 'Clean');
    assert.equal(post.body.model_file, 'twin.nam');
    assert.equal(post.body.ir_file, 'cab.wav');
});

test('a model/IR no longer on disk is kept (flagged) rather than cleared', async () => {
    const env = load({ models: [{ name: 'other.nam' }], irs: [] });
    await env.window.namEditPreset(1);
    const modelSel = env.document.getElementById('nam-preset-model');
    assert.equal(modelSel.value, 'twin.nam');
    const added = modelSel.options.find(o => o.value === 'twin.nam');
    assert.match(added.textContent, /missing/);
    assert.equal(env.document.getElementById('nam-preset-ir').value, 'cab.wav');
});

test('a failed list refresh still keeps the saved values', async () => {
    const env = load({ modelsFail: true });
    await env.window.namEditPreset(1);
    assert.equal(env.document.getElementById('nam-preset-model').value, 'twin.nam');
    assert.equal(env.document.getElementById('nam-preset-ir').value, 'cab.wav');
});

test('a preset with no model/IR stays on "-- None --"', async () => {
    const env = loadScreen({
        elements: editorElements(),
        routes: {
            '/api/plugins/nam_tone/presets': [{ ...PRESET, model_file: '', ir_file: '' }],
            '/api/plugins/nam_tone/models': [{ name: 'twin.nam' }],
            '/api/plugins/nam_tone/irs': [],
        },
    });
    await env.window.namEditPreset(1);
    const modelSel = env.document.getElementById('nam-preset-model');
    assert.equal(modelSel.value, '');
    assert.equal(modelSel.options.some(o => /missing/.test(o.textContent)), false);
});

test('focusing a dropdown after edit keeps a missing model/IR, and save keeps it', async () => {
    const env = load({ models: [{ name: 'other.nam' }], irs: [] });
    await env.window.namEditPreset(1);
    // The selects re-populate on focus; that rebuild must not drop "(missing)".
    await env.window.namPopulatePresetDropdowns();
    const modelSel = env.document.getElementById('nam-preset-model');
    assert.equal(modelSel.value, 'twin.nam');
    assert.ok(modelSel.options.some(o => o.value === 'twin.nam' && /missing/.test(o.textContent)));
    assert.equal(env.document.getElementById('nam-preset-ir').value, 'cab.wav');
    await env.window.namSavePreset();
    const post = env.posts.find(p => p.url === '/api/plugins/nam_tone/presets');
    assert.equal(post.body.model_file, 'twin.nam');
    assert.equal(post.body.ir_file, 'cab.wav');
});
