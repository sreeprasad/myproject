import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """Where recordings live: $SHOWME_DATA_DIR or <repo>/data."""
    d = Path(os.environ.get("SHOWME_DATA_DIR", REPO_ROOT / "data")).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def recording_dir(rec_id: str) -> Path:
    if not rec_id.replace("-", "").isalnum():
        raise ValueError(f"bad recording id: {rec_id!r}")
    return data_dir() / rec_id

