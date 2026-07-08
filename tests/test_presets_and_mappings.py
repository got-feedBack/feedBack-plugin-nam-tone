"""Preset CRUD, native-preset chain building, tone mappings."""

PRESETS = "/api/plugins/nam_tone/presets"


def _upload_model(client, name, content=b'{"k":1}'):
    return client.post("/api/plugins/nam_tone/models",
                        files={"file": (name, content, "application/octet-stream")})


def _upload_ir(client, name, content=b"WAV", monkeypatch=None):
    return client.post("/api/plugins/nam_tone/irs",
                        files={"file": (name, content, "application/octet-stream")})


def test_presets_empty_list(client):
    assert client.get(PRESETS).json() == []


def test_save_and_list_preset(client):
    r = client.post(PRESETS, json={"name": "Crunch", "input_gain": 1.2})
    assert r.status_code == 200
    presets = client.get(PRESETS).json()
    assert len(presets) == 1
    assert presets[0]["name"] == "Crunch"
    assert presets[0]["input_gain"] == 1.2
    assert presets[0]["output_gain"] == 0.5  # default
    assert presets[0]["gate_threshold"] == -60.0  # default


def test_save_preset_upserts_by_unique_name(client):
    client.post(PRESETS, json={"name": "Crunch", "input_gain": 1.0})
    client.post(PRESETS, json={"name": "Crunch", "input_gain": 2.0})
    presets = client.get(PRESETS).json()
    assert len(presets) == 1
    assert presets[0]["input_gain"] == 2.0


def test_delete_preset(client):
    client.post(PRESETS, json={"name": "Crunch"})
    preset_id = client.get(PRESETS).json()[0]["id"]
    assert client.delete(f"{PRESETS}/{preset_id}").json() == {"ok": True}
    assert client.get(PRESETS).json() == []


def test_native_preset_missing_id_404(client):
    assert client.get("/api/plugins/nam_tone/native-preset/9999").status_code == 404


def test_native_preset_missing_model_file_404(client):
    client.post(PRESETS, json={"name": "Crunch", "model_file": "ghost.nam"})
    preset_id = client.get(PRESETS).json()[0]["id"]
    assert client.get(f"/api/plugins/nam_tone/native-preset/{preset_id}").status_code == 404


def test_native_preset_chain_with_model_and_ir(client, monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError()))
    _upload_model(client, "clean.nam")
    _upload_ir(client, "cab.wav")
    client.post(PRESETS, json={
        "name": "Crunch", "model_file": "clean.nam", "ir_file": "cab.wav",
        "input_gain": 1.5, "output_gain": 0.8,
    })
    preset_id = client.get(PRESETS).json()[0]["id"]

    r = client.get(f"/api/plugins/nam_tone/native-preset/{preset_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Crunch"
    chain = body["native_preset"]["chain"]
    assert len(chain) == 2
    assert chain[0]["type"] == 1  # model
    assert chain[0]["name"] == "clean"
    assert chain[1]["type"] == 2  # ir
    assert chain[1]["name"] == "cab"


def test_native_preset_model_only_uses_output_gain_on_model_stage(client):
    # With no IR stage downstream, the model stage itself carries output_gain
    # (the `1.0 if ir_path else float(output_gain)` branch in routes.py).
    _upload_model(client, "clean.nam")
    client.post(PRESETS, json={"name": "ModelOnly", "model_file": "clean.nam", "output_gain": 0.3})
    preset_id = client.get(PRESETS).json()[0]["id"]
    body = client.get(f"/api/plugins/nam_tone/native-preset/{preset_id}").json()
    chain = body["native_preset"]["chain"]
    assert len(chain) == 1

    import base64, json
    state = json.loads(base64.b64decode(chain[0]["state"]))
    assert state["outputLevel"] == 0.3


def test_native_preset_model_output_level_is_full_when_ir_follows(client, monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError()))
    _upload_model(client, "clean.nam")
    _upload_ir(client, "cab.wav")
    client.post(PRESETS, json={
        "name": "WithIr", "model_file": "clean.nam", "ir_file": "cab.wav", "output_gain": 0.3,
    })
    preset_id = client.get(PRESETS).json()[0]["id"]
    body = client.get(f"/api/plugins/nam_tone/native-preset/{preset_id}").json()
    chain = body["native_preset"]["chain"]

    import base64, json
    model_state = json.loads(base64.b64decode(chain[0]["state"]))
    ir_state = json.loads(base64.b64decode(chain[1]["state"]))
    assert model_state["outputLevel"] == 1.0  # gain moved to the IR stage
    assert ir_state["gain"] == 0.3


# ── Tone mappings ─────────────────────────────────────────────────────────────

def test_mappings_empty_for_unknown_song(client):
    assert client.get("/api/plugins/nam_tone/mappings/song.sloppak").json() == []


def test_save_and_get_mapping(client):
    client.post(PRESETS, json={"name": "Crunch"})
    preset_id = client.get(PRESETS).json()[0]["id"]

    r = client.post("/api/plugins/nam_tone/mappings/song.sloppak",
                     json={"tone_key": "lead", "preset_id": preset_id})
    assert r.json() == {"ok": True}

    mappings = client.get("/api/plugins/nam_tone/mappings/song.sloppak").json()
    assert len(mappings) == 1
    assert mappings[0]["tone_key"] == "lead"
    assert mappings[0]["preset_name"] == "Crunch"


def test_save_mapping_upserts_by_filename_and_tone_key(client):
    client.post(PRESETS, json={"name": "A"})
    client.post(PRESETS, json={"name": "B"})
    presets = {p["name"]: p["id"] for p in client.get(PRESETS).json()}

    client.post("/api/plugins/nam_tone/mappings/song.sloppak",
                json={"tone_key": "lead", "preset_id": presets["A"]})
    client.post("/api/plugins/nam_tone/mappings/song.sloppak",
                json={"tone_key": "lead", "preset_id": presets["B"]})

    mappings = client.get("/api/plugins/nam_tone/mappings/song.sloppak").json()
    assert len(mappings) == 1
    assert mappings[0]["preset_name"] == "B"


def test_delete_mapping(client):
    client.post(PRESETS, json={"name": "Crunch"})
    preset_id = client.get(PRESETS).json()[0]["id"]
    client.post("/api/plugins/nam_tone/mappings/song.sloppak",
                json={"tone_key": "lead", "preset_id": preset_id})
    mapping_id = client.get("/api/plugins/nam_tone/mappings/song.sloppak").json()[0]["id"]

    assert client.delete(f"/api/plugins/nam_tone/mappings/{mapping_id}").json() == {"ok": True}
    assert client.get("/api/plugins/nam_tone/mappings/song.sloppak").json() == []


def test_delete_preset_cascades_mappings(client):
    client.post(PRESETS, json={"name": "Crunch"})
    preset_id = client.get(PRESETS).json()[0]["id"]
    client.post("/api/plugins/nam_tone/mappings/song.sloppak",
                json={"tone_key": "lead", "preset_id": preset_id})

    client.delete(f"{PRESETS}/{preset_id}")
    assert client.get("/api/plugins/nam_tone/mappings/song.sloppak").json() == []


def test_song_tones_returns_empty_list(client):
    assert client.get("/api/plugins/nam_tone/song-tones/song.sloppak").json() == {"tones": []}
