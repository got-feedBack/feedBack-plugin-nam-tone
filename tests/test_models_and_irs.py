"""Model (.nam) and IR (.wav) upload/list/delete/serve, incl. traversal guards."""


def _upload(client, url, name, content=b"data"):
    return client.post(url, files={"file": (name, content, "application/octet-stream")})


def test_models_empty_list(client):
    assert client.get("/api/plugins/nam_tone/models").json() == []


def test_upload_and_list_model(client):
    r = _upload(client, "/api/plugins/nam_tone/models", "clean.nam", b"NAMDATA")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "name": "clean.nam", "size": 7}

    listed = client.get("/api/plugins/nam_tone/models").json()
    assert len(listed) == 1
    assert listed[0]["name"] == "clean.nam"
    assert listed[0]["size"] == 7


def test_upload_model_rejects_traversal_filename(client):
    r = _upload(client, "/api/plugins/nam_tone/models", "../../evil.nam", b"x")
    assert r.status_code == 400


def test_delete_model(client):
    _upload(client, "/api/plugins/nam_tone/models", "clean.nam")
    assert client.delete("/api/plugins/nam_tone/models/clean.nam").json() == {"ok": True}
    assert client.get("/api/plugins/nam_tone/models").json() == []


def test_delete_model_missing_is_ok(client):
    # Delete is idempotent: no 404 for an already-gone file.
    assert client.delete("/api/plugins/nam_tone/models/nope.nam").json() == {"ok": True}


def test_delete_model_rejects_traversal(client):
    r = client.delete("/api/plugins/nam_tone/models/..%2F..%2Fescape.nam")
    assert r.status_code == 400


def test_models_list_ignores_non_nam_files(client, config_dir):
    models_dir = config_dir / "nam_models"
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / "readme.txt").write_text("hi")
    assert client.get("/api/plugins/nam_tone/models").json() == []


def test_irs_empty_list(client):
    assert client.get("/api/plugins/nam_tone/irs").json() == []


def test_upload_ir_falls_back_to_raw_bytes_without_ffmpeg(client, monkeypatch):
    import subprocess

    def fake_run(*a, **kw):
        raise FileNotFoundError("ffmpeg not installed")
    monkeypatch.setattr(subprocess, "run", fake_run)

    r = _upload(client, "/api/plugins/nam_tone/irs", "cab.wav", b"RAWWAVDATA")
    assert r.status_code == 200
    assert r.json()["name"] == "cab.wav"
    assert r.json()["size"] == len(b"RAWWAVDATA")

    listed = client.get("/api/plugins/nam_tone/irs").json()
    assert listed[0]["name"] == "cab.wav"


def test_upload_ir_rejects_traversal_filename(client):
    r = _upload(client, "/api/plugins/nam_tone/irs", "../escape.wav", b"x")
    assert r.status_code == 400


def test_delete_ir(client, monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError()))
    _upload(client, "/api/plugins/nam_tone/irs", "cab.wav", b"x")
    assert client.delete("/api/plugins/nam_tone/irs/cab.wav").json() == {"ok": True}
    assert client.get("/api/plugins/nam_tone/irs").json() == []


def test_serve_file_model_and_ir(client, monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError()))
    _upload(client, "/api/plugins/nam_tone/models", "clean.nam", b'{"k":1}')
    _upload(client, "/api/plugins/nam_tone/irs", "cab.wav", b"WAVDATA")

    r = client.get("/api/plugins/nam_tone/file/model/clean.nam")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")

    r = client.get("/api/plugins/nam_tone/file/ir/cab.wav")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/wav")


def test_serve_file_invalid_type(client):
    assert client.get("/api/plugins/nam_tone/file/bogus/x").status_code == 400


def test_serve_file_missing_404(client):
    assert client.get("/api/plugins/nam_tone/file/model/nope.nam").status_code == 404


def test_serve_file_rejects_traversal(client):
    r = client.get("/api/plugins/nam_tone/file/model/..%2F..%2Frequirements.txt")
    assert r.status_code in (400, 404)
