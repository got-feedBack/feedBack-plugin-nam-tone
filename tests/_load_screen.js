// Load screen.js into a Node vm with just enough DOM to drive the preset
// editor / player controls. screen.js is a browser script (an IIFE that
// publishes `window.nam*` handlers), so tests exercise the real file rather
// than a copy. Only the surfaces the tests touch are emulated:
//   - <select>: `value` only sticks when a matching <option> exists (like a
//     browser — otherwise it reads back ""), `innerHTML` parses <option>s.
//   - fetch: routed to a per-test handler table, POST bodies recorded.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', 'screen.js');

function makeOption(value, text, selected) {
    return { tagName: 'OPTION', value: String(value), textContent: text, selected: !!selected };
}

function makeSelect(id) {
    const el = {
        id,
        tagName: 'SELECT',
        options: [makeOption('', '-- None --', true)],
        children: null,
        className: '',
        title: '',
        onchange: null,
        parentNode: null,
        get value() {
            const sel = this.options.find(o => o.selected);
            return sel ? sel.value : '';
        },
        set value(v) {
            let hit = false;
            for (const o of this.options) {
                o.selected = !hit && o.value === String(v);
                if (o.selected) hit = true;
            }
        },
        set innerHTML(html) {
            this.options = [];
            const re = /<option value="([^"]*)"\s*(selected)?[^>]*>([^<]*)<\/option>/g;
            let m;
            while ((m = re.exec(html)) !== null) this.options.push(makeOption(m[1], m[3], !!m[2]));
            if (!this.options.some(o => o.selected) && this.options.length) this.options[0].selected = true;
        },
        get innerHTML() { return ''; },
        appendChild(child) {
            if (child && child.tagName === 'OPTION') {
                this.options.push(child);
                if (this.options.length === 1) child.selected = true;
            }
            return child;
        },
    };
    el.children = el.options;
    return el;
}

function makeInput(id, value = '') {
    return { id, tagName: 'INPUT', value };
}

function makeContainer(id) {
    const el = {
        id,
        tagName: 'DIV',
        childNodes: [],
        appendChild(child) {
            if (child.parentNode && child.parentNode !== el) child.parentNode.removeChild(child);
            el.childNodes = el.childNodes.filter(c => c !== child);
            el.childNodes.push(child);
            child.parentNode = el;
            return child;
        },
        insertBefore(child, ref) {
            el.childNodes = el.childNodes.filter(c => c !== child);
            const i = el.childNodes.indexOf(ref);
            if (i < 0) el.childNodes.push(child); else el.childNodes.splice(i, 0, child);
            child.parentNode = el;
            return child;
        },
        removeChild(child) {
            el.childNodes = el.childNodes.filter(c => c !== child);
            child.parentNode = null;
            return child;
        },
        contains(node) {
            if (node === el) return true;
            return el.childNodes.some(c => c === node || (typeof c.contains === 'function' && c.contains(node)));
        },
        querySelector() { return null; },
    };
    return el;
}

function loadScreen({ routes = {}, elements = {}, before } = {}) {
    const posts = [];
    const registry = new Map();
    for (const [id, el] of Object.entries(elements)) registry.set(id, el);

    const document = {
        getElementById: (id) => {
            if (registry.has(id)) return registry.get(id);
            // Document-wide lookup by id across mounted containers.
            for (const el of registry.values()) {
                for (const c of (el.childNodes || [])) if (c.id === id) return c;
            }
            return null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => {
            if (tag === 'option') return makeOption('', '', false);
            if (tag === 'select') return makeSelect('');
            if (tag === 'button') return { tagName: 'BUTTON', id: '', className: '', textContent: '', title: '', onclick: null, parentNode: null };
            return makeContainer('');
        },
        addEventListener: () => {},
        body: makeContainer('body'),
    };

    async function fetchStub(url, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        if (method !== 'GET') {
            posts.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
            return { ok: true, json: async () => ({ ok: true }) };
        }
        const handler = routes[url];
        if (!handler) throw new Error('unrouted fetch ' + url);
        const data = typeof handler === 'function' ? await handler() : handler;
        return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) };
    }

    const sandbox = {
        document,
        fetch: fetchStub,
        console: { log() {}, warn() {}, error() {}, info() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout: () => 0,
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        addEventListener() {},
        removeEventListener() {},
        navigator: { mediaDevices: {} },
        // Core app.js global the plugin's templates use.
        esc: (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        Promise, JSON, Array, Map, Set, Math, Number, String, Object, Error,
    };
    sandbox.window = sandbox;
    if (typeof before === 'function') before(sandbox);
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'screen.js' });
    return { window: sandbox, document, posts, registry };
}

module.exports = { loadScreen, makeSelect, makeInput, makeContainer };
