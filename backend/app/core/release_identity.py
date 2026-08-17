import json
import re
from pathlib import Path


API_SCHEMA_VERSION = "1.0.0"
RELEASE_FILE = Path(__file__).resolve().parents[2] / "release.json"
SEMANTIC_VERSION_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)


def _load_product_release_version(path: Path = RELEASE_FILE) -> str:
    try:
        release = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Koaryu release identity is unreadable at {path}.") from exc

    version = release.get("product_version") if isinstance(release, dict) else None
    if not isinstance(version, str) or not SEMANTIC_VERSION_PATTERN.fullmatch(version):
        raise RuntimeError(
            f"Koaryu release identity at {path} must contain a semantic product_version."
        )

    return version


PRODUCT_RELEASE_VERSION = _load_product_release_version()
