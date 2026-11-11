"""Download the aviation-museum models listed in MODELS.json.

Sketchfab requires an API token (their download endpoint returns 401 without
one). Provide it either as the SKETCHFAB_TOKEN environment variable or in
`%USERPROFILE%\\.sketchfab_token` (one line, never commit it).

The script never prints the token, writes raw downloads to
`assets/aviation-museum/raw/<slug>/`, keeps an ATTRIBUTION.txt next to every
model and updates MODELS.json status. CC0/CC-BY only: entries flagged
NonCommercial/ShareAlike are refused.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
MANIFEST = ASSETS / "MODELS.json"
API = "https://api.sketchfab.com/v3/models"
ALLOWED_LICENSES = ("CC0", "CC Attribution")


def read_token() -> str | None:
    token = os.environ.get("SKETCHFAB_TOKEN")
    if token:
        return token.strip()
    token_file = Path(os.environ.get("USERPROFILE", str(Path.home()))) / ".sketchfab_token"
    if token_file.exists():
        return token_file.read_text(encoding="utf-8").strip()
    return None


def download(url: str, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "iso-minsk-museum"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return destination.stat().st_size


def fetch_download_url(uid: str, token: str) -> dict:
    """Ask Sketchfab for the archive URLs, retrying on rate limits."""
    request = urllib.request.Request(
        f"{API}/{uid}/download",
        headers={"Authorization": f"Token {token}", "User-Agent": "iso-minsk-museum"},
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code in (429, 500, 502, 503, 504):
                wait = 15 * (attempt + 1)
                print(f"[wait] {uid}: HTTP {error.code}, retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except Exception as error:  # noqa: BLE001 - transient network
            last_error = error
            time.sleep(5 * (attempt + 1))
    raise last_error if last_error else RuntimeError("download URL request failed")


def archive_url(payload: dict, key: str) -> str | None:
    entry = payload.get(key)
    if isinstance(entry, dict):
        return entry.get("url")
    if isinstance(entry, str):
        return entry
    return None


def main() -> int:
    token = read_token()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pending = [
        item
        for item in manifest["items"]
        if item.get("source") == "sketchfab" and item.get("uid")
        and item.get("status") != "downloaded"
    ]

    if not token:
        print(
            "ERROR: Sketchfab API token is missing.\n"
            "  Create it at https://sketchfab.com/settings/password (API token)\n"
            "  and save it to %USERPROFILE%\\.sketchfab_token or set SKETCHFAB_TOKEN.\n"
            f"  {len(pending)} Sketchfab models are ready to download.",
            file=sys.stderr,
        )
        return 2

    failures: list[str] = []
    for item in pending:
        slug = item["slug"]
        # Sketchfab rate-limits the download endpoint (~15 requests); pace it.
        time.sleep(3)
        license_label = item.get("license") or ""
        if not any(token_label in license_label for token_label in ALLOWED_LICENSES):
            print(f"[skip] {slug}: license {license_label!r} is not CC0/CC-BY", file=sys.stderr)
            continue
        try:
            payload = fetch_download_url(item["uid"], token)
        except urllib.error.HTTPError as error:
            failures.append(f"{slug}: HTTP {error.code}")
            print(f"[fail] {slug}: HTTP {error.code}", file=sys.stderr)
            continue
        except Exception as error:  # noqa: BLE001 - research/import tool
            failures.append(f"{slug}: {error}")
            print(f"[fail] {slug}: {error}", file=sys.stderr)
            continue

        url = archive_url(payload, "glb") or archive_url(payload, "gltf")
        if not url:
            failures.append(f"{slug}: no glb/gltf archive in download response")
            print(f"[fail] {slug}: no glb/gltf archive", file=sys.stderr)
            continue
        extension = ".glb" if payload.get("glb") else ".gltf"
        destination = ASSETS / "raw" / slug / f"{slug}{extension}"
        try:
            size = download(url, destination)
        except Exception as error:  # noqa: BLE001
            failures.append(f"{slug}: download failed: {error}")
            print(f"[fail] {slug}: download failed: {error}", file=sys.stderr)
            continue

        (ASSETS / "raw" / slug / "ATTRIBUTION.txt").write_text(
            f"{item['label']} ({item['slug']})\n"
            f"Author: {item.get('author') or 'unknown'}\n"
            f"License: {license_label}\n"
            f"Source: https://sketchfab.com/3d-models/{item['uid']}\n"
            f"Downloaded: {time.strftime('%Y-%m-%d')}\n",
            encoding="utf-8",
        )
        item["status"] = "downloaded"
        item["raw"] = str(destination.relative_to(ASSETS)).replace("\\", "/")
        item["bytes"] = size
        print(f"[ok] {slug}: {size / 1e6:.1f} MB -> {item['raw']}")

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    downloaded = sum(1 for item in manifest["items"] if item.get("status") == "downloaded")
    missing = sum(1 for item in manifest["items"] if item.get("source") == "missing")
    print(f"\nDownloaded: {downloaded}; missing (no CC model): {missing}; failures: {len(failures)}")
    for failure in failures:
        print(f"  - {failure}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
