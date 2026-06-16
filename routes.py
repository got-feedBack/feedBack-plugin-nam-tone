"""NAM Tone Engine plugin — manage amp models, IR files, presets, and tone mappings."""

import base64
import json
import os
import sqlite3
import threading
from pathlib import Path

from fastapi import UploadFile, File
from fastapi.responses import FileResponse, Response

_db_path: str | None = None
_conn = None
_lock = threading.Lock()
_plugin_dir = Path(__file__).parent
_models_dir: Path | None = None
_irs_dir: Path | None = None


def _require_db_path() -> str:
    if _db_path is None:
        raise RuntimeError("NAM Tone plugin has not been initialized")
    return _db_path


def _require_models_dir() -> Path:
    if _models_dir is None:
        raise RuntimeError("NAM Tone plugin has not been initialized")
    return _models_dir


def _require_irs_dir() -> Path:
    if _irs_dir is None:
        raise RuntimeError("NAM Tone plugin has not been initialized")
    return _irs_dir


def _get_conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_require_db_path(), check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                model_file TEXT,
                ir_file TEXT,
                input_gain REAL NOT NULL DEFAULT 1.0,
                output_gain REAL NOT NULL DEFAULT 0.5,
                gate_threshold REAL NOT NULL DEFAULT -60.0,
                settings_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS tone_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                tone_key TEXT NOT NULL,
                preset_id INTEGER NOT NULL,
                UNIQUE(filename, tone_key),
                FOREIGN KEY (preset_id) REFERENCES presets(id)
            )
        """)
        _conn.commit()
    return _conn


def _state_b64(data: dict) -> str:
    payload = json.dumps(data, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(payload).decode("ascii")


def _safe_child(root: Path, name: str | None):
    if not name:
        return None
    root_resolved = root.resolve()
    path = (root / name).resolve()
    try:
        path.relative_to(root_resolved)
    except ValueError:
        return None
    return path


def _mapping_filenames(filename: str) -> list[str]:
    """Return filename aliases that should share tone mappings.

    Sloppak playback uses paths like "sloppak/boststar.sloppak" while the
    same song is often mapped from the original PSARC filename
    "boststar_p.psarc". Keep the exact filename first so direct mappings win.
    """
    names = [filename]
    normalized = filename.replace("\\", "/")
    if normalized.startswith("sloppak/") and normalized.lower().endswith(".sloppak"):
        psarc_name = f"{Path(normalized).stem}_p.psarc"
        if psarc_name not in names:
            names.append(psarc_name)
    return names


def setup(app, context):
    global _db_path, _models_dir, _irs_dir
    filename_aliases = context.get("filename_aliases") or _mapping_filenames
    config_dir = context["config_dir"]
    _db_path = str(config_dir / "nam_tone.db")
    models_dir = config_dir / "nam_models"
    irs_dir = config_dir / "nam_irs"
    _models_dir = models_dir
    _irs_dir = irs_dir
    models_dir.mkdir(exist_ok=True)
    irs_dir.mkdir(exist_ok=True)

    # ── Models ────────────────────────────────────────────────────────────

    @app.get("/api/plugins/nam_tone/models")
    def list_models():
        models_dir = _require_models_dir()
        files = []
        for f in sorted(models_dir.iterdir()):
            if f.suffix == ".nam":
                stat = f.stat()
                files.append({"name": f.name, "size": stat.st_size, "mtime": stat.st_mtime})
        return files

    @app.post("/api/plugins/nam_tone/models")
    async def upload_model(file: UploadFile = File(...)):
        dest = _safe_child(_require_models_dir(), file.filename)
        if dest is None:
            return Response("invalid filename", status_code=400)
        data = await file.read()
        dest.write_bytes(data)
        return {"ok": True, "name": file.filename, "size": len(data)}

    @app.delete("/api/plugins/nam_tone/models/{name:path}")
    def delete_model(name: str):
        path = _safe_child(_require_models_dir(), name)
        if path is None:
            return Response("invalid filename", status_code=400)
        if path.exists():
            path.unlink()
        return {"ok": True}

    # ── IRs ───────────────────────────────────────────────────────────────

    @app.get("/api/plugins/nam_tone/irs")
    def list_irs():
        irs_dir = _require_irs_dir()
        files = []
        for f in sorted(irs_dir.iterdir()):
            if f.suffix == ".wav":
                stat = f.stat()
                files.append({"name": f.name, "size": stat.st_size, "mtime": stat.st_mtime})
        return files

    @app.post("/api/plugins/nam_tone/irs")
    async def upload_ir(file: UploadFile = File(...)):
        import subprocess, tempfile
        dest = _safe_child(_require_irs_dir(), file.filename)
        if dest is None:
            return Response("invalid filename", status_code=400)
        data = await file.read()
        # Convert to browser-compatible WAV (PCM float32, 48kHz mono)
        # decodeAudioData is picky about formats; ffmpeg normalizes it
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_in:
            tmp_in.write(data)
            tmp_in_path = tmp_in.name
        try:
            result = subprocess.run([
                "ffmpeg", "-y", "-i", tmp_in_path,
                "-ar", "48000", "-ac", "1",
                "-c:a", "pcm_f32le",
                str(dest),
            ], capture_output=True, timeout=30)
            if result.returncode != 0:
                # ffmpeg failed, save raw file as fallback
                dest.write_bytes(data)
        except Exception:
            dest.write_bytes(data)
        finally:
            Path(tmp_in_path).unlink(missing_ok=True)
        stat = dest.stat()
        return {"ok": True, "name": file.filename, "size": stat.st_size}

    @app.delete("/api/plugins/nam_tone/irs/{name:path}")
    def delete_ir(name: str):
        path = _safe_child(_require_irs_dir(), name)
        if path is None:
            return Response("invalid filename", status_code=400)
        if path.exists():
            path.unlink()
        return {"ok": True}

    # ── Presets ───────────────────────────────────────────────────────────

    @app.get("/api/plugins/nam_tone/presets")
    def list_presets():
        conn = _get_conn()
        rows = conn.execute(
            "SELECT id, name, model_file, ir_file, input_gain, output_gain, "
            "gate_threshold, settings_json FROM presets ORDER BY name"
        ).fetchall()
        return [
            {"id": r[0], "name": r[1], "model_file": r[2], "ir_file": r[3],
             "input_gain": r[4], "output_gain": r[5], "gate_threshold": r[6],
             "settings_json": r[7]}
            for r in rows
        ]

    @app.post("/api/plugins/nam_tone/presets")
    def save_preset(data: dict):
        conn = _get_conn()
        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO presets "
                "(name, model_file, ir_file, input_gain, output_gain, gate_threshold, settings_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (data.get("name", ""), data.get("model_file", ""),
                 data.get("ir_file", ""), data.get("input_gain", 1.0),
                 data.get("output_gain", 0.5), data.get("gate_threshold", -60.0),
                 json.dumps(data.get("settings", {})))
            )
            conn.commit()
        return {"ok": True}

    @app.delete("/api/plugins/nam_tone/presets/{preset_id}")
    def delete_preset(preset_id: int):
        conn = _get_conn()
        with _lock:
            conn.execute("DELETE FROM tone_mappings WHERE preset_id = ?", (preset_id,))
            conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))
            conn.commit()
        return {"ok": True}

    @app.get("/api/plugins/nam_tone/native-preset/{preset_id}")
    def get_native_preset(preset_id: int):
        conn = _get_conn()
        row = conn.execute(
            "SELECT id, name, model_file, ir_file, input_gain, output_gain, gate_threshold "
            "FROM presets WHERE id = ?",
            (preset_id,),
        ).fetchone()
        if not row:
            return Response("not found", status_code=404)

        preset_id, name, model_file, ir_file, input_gain, output_gain, gate_threshold = row
        chain = []

        model_path = _safe_child(_require_models_dir(), model_file)
        ir_path = _safe_child(_require_irs_dir(), ir_file)
        if model_file and (model_path is None or not model_path.exists()):
            return Response("model not found", status_code=404)
        if ir_file and (ir_path is None or not ir_path.exists()):
            return Response("ir not found", status_code=404)

        if model_path:
            chain.append({
                "type": 1,
                "name": Path(model_file).stem,
                "path": str(model_path),
                "bypassed": False,
                "state": _state_b64({
                    "modelPath": str(model_path),
                    "inputLevel": float(input_gain),
                    "outputLevel": 1.0 if ir_path else float(output_gain),
                }),
            })

        if ir_path:
            chain.append({
                "type": 2,
                "name": Path(ir_file).stem,
                "path": str(ir_path),
                "bypassed": False,
                "state": _state_b64({
                    "irPath": str(ir_path),
                    "gain": float(output_gain),
                }),
            })

        return {
            "id": preset_id,
            "name": name,
            "input_gain": input_gain,
            "output_gain": output_gain,
            "gate_threshold": gate_threshold,
            "native_preset": {"version": 1, "chain": chain},
        }

    # ── Tone Mappings ─────────────────────────────────────────────────────

    @app.get("/api/plugins/nam_tone/mappings/{filename:path}")
    def get_mappings(filename: str):
        conn = _get_conn()
        filenames = filename_aliases(filename)
        placeholders = ",".join("?" for _ in filenames)
        rows = conn.execute(
            "SELECT tm.id, tm.tone_key, tm.preset_id, p.name, p.model_file, p.ir_file, "
            "p.input_gain, p.output_gain, p.gate_threshold "
            "FROM tone_mappings tm JOIN presets p ON tm.preset_id = p.id "
            f"WHERE tm.filename IN ({placeholders}) "
            "ORDER BY CASE tm.filename WHEN ? THEN 0 ELSE 1 END, tm.tone_key",
            (*filenames, filename)
        ).fetchall()
        mappings = []
        seen_tones = set()
        for r in rows:
            if r[1] in seen_tones:
                continue
            seen_tones.add(r[1])
            mappings.append({
                "id": r[0], "tone_key": r[1], "preset_id": r[2],
                "preset_name": r[3], "model_file": r[4], "ir_file": r[5],
                "input_gain": r[6], "output_gain": r[7], "gate_threshold": r[8],
            })
        return mappings

    @app.post("/api/plugins/nam_tone/mappings/{filename:path}")
    def save_mapping(filename: str, data: dict):
        conn = _get_conn()
        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO tone_mappings (filename, tone_key, preset_id) "
                "VALUES (?, ?, ?)",
                (filename, data.get("tone_key", ""), data.get("preset_id", 0))
            )
            conn.commit()
        return {"ok": True}

    @app.delete("/api/plugins/nam_tone/mappings/{mapping_id}")
    def delete_mapping(mapping_id: int):
        conn = _get_conn()
        with _lock:
            conn.execute("DELETE FROM tone_mappings WHERE id = ?", (mapping_id,))
            conn.commit()
        return {"ok": True}

    # ── Song Tones (extract from CDLC) ────────────────────────────────────

    @app.get("/api/plugins/nam_tone/song-tones/{filename:path}")
    def get_song_tones(filename: str):
        from psarc import read_psarc_entries
        dlc = context["get_dlc_dir"]()
        if not dlc:
            return {"error": "DLC folder not configured"}

        candidate_names = filename_aliases(filename)
        if filename.replace("\\", "/").lower().endswith(".sloppak"):
            candidate_names = [n for n in candidate_names if n.lower().endswith(".psarc")] + [filename]

        files = None
        for candidate_name in candidate_names:
            candidate_path = _safe_child(dlc, candidate_name)
            if candidate_path is None or not candidate_path.exists():
                continue
            try:
                files = read_psarc_entries(str(candidate_path), ["*.json"])
                break
            except ValueError:
                continue
        if files is None:
            return {"error": "File not found or not a PSARC"}

        tones = []
        seen = set()

        for path, data in sorted(files.items()):
            if not path.endswith(".json"):
                continue
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                import re
                text = data.decode("utf-8", errors="ignore")
                text = re.sub(r",\s*([}\]])", r"\1", text)
                try:
                    j = json.loads(text)
                except Exception:
                    continue

            for k, v in j.get("Entries", {}).items():
                attrs = v.get("Attributes", {})
                arr_name = attrs.get("ArrangementName", "")
                if arr_name in ("Vocals", "ShowLights", "JVocals"):
                    continue
                for t in attrs.get("Tones", []):
                    key = t.get("Key", "")
                    name = t.get("Name", key)
                    if key and key not in seen:
                        seen.add(key)
                        tones.append({"key": key, "name": name, "arrangement": arr_name})

        return {"tones": tones}

    # ── File Serving ──────────────────────────────────────────────────────

    @app.get("/api/plugins/nam_tone/file/{file_type}/{name:path}")
    def serve_file(file_type: str, name: str):
        if file_type == "model":
            path = _safe_child(_require_models_dir(), name)
            mt = "application/json"
        elif file_type == "ir":
            path = _safe_child(_require_irs_dir(), name)
            mt = "audio/wav"
        else:
            return Response("invalid type", status_code=400)

        if path is None:
            return Response("invalid filename", status_code=400)
        if not path.exists():
            return Response("not found", status_code=404)
        return FileResponse(str(path), media_type=mt)

    @app.get("/api/plugins/nam_tone/worklet/{filename:path}")
    def serve_worklet(filename: str):
        for subdir in ["worklet", "wasm"]:
            path = _safe_child(_plugin_dir / subdir, filename)
            if path is None:
                continue
            if path.exists():
                ext = path.suffix
                mt = {
                    ".js": "application/javascript",
                    ".wasm": "application/wasm",
                }.get(ext, "application/octet-stream")
                if ext == ".wasm":
                    return FileResponse(str(path), media_type=mt)
                return Response(path.read_text(), media_type=mt)
        return Response("not found", status_code=404)
