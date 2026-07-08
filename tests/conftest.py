import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# The plugin is a flat module directory; make routes importable from tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routes  # noqa: E402


@pytest.fixture
def config_dir(tmp_path):
    d = tmp_path / "config"
    d.mkdir()
    return d


@pytest.fixture
def client(config_dir):
    # routes.py keeps module-level globals (_conn etc.); reset between tests
    # so each test gets a fresh sqlite connection bound to its own tmp_path.
    routes._conn = None
    routes._db_path = None
    routes._models_dir = None
    routes._irs_dir = None
    app = FastAPI()
    routes.setup(app, {"config_dir": config_dir})
    with TestClient(app) as c:
        yield c
