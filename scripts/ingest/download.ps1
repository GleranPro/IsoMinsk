# Download the OpenStreetMap extract used by the offline pipeline.
#
# Two sources are supported (both are OpenStreetMap data, ODbL 1.0):
#   * BBBike city extract for Minsk (~35 MB, rebuilt weekly) — default, fast,
#     already limited to the city so the extraction step takes seconds;
#   * Geofabrik country extract for Belarus (~350 MB) — used with -Full when a
#     larger area is needed; the extraction step then takes a few minutes.
#
# Usage (from the repository root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ingest/download.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ingest/download.ps1 -Full
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ingest/download.ps1 -Force

param(
    [switch]$Full,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rawDir = Join-Path $root 'data/raw'
if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }

if ($Full) {
    $url = 'https://download.geofabrik.de/europe/belarus-latest.osm.pbf'
    $md5Url = 'https://download.geofabrik.de/europe/belarus-latest.osm.pbf.md5'
    $target = Join-Path $rawDir 'belarus-latest.osm.pbf'
    $label = 'Geofabrik Belarus (~350 MB)'
} else {
    $url = 'https://download.bbbike.org/osm/bbbike/Minsk/Minsk.osm.pbf'
    $md5Url = $null
    $target = Join-Path $rawDir 'Minsk.osm.pbf'
    $label = 'BBBike Minsk city extract (~35 MB)'
}

if ((Test-Path $target) -and (-not $Force)) {
    $size = (Get-Item $target).Length
    Write-Host "Raw extract already present: $target ($([math]::Round($size / 1MB, 1)) MB). Use -Force to re-download."
    exit 0
}

Write-Host "Downloading $label ..."
Write-Host "  source: $url"
curl.exe -s -S -L --retry 3 --retry-delay 5 -A 'IsometricMinsk/0.1 (offline data pipeline)' $url -o $target
if ($LASTEXITCODE -ne 0) { throw "Download failed with exit code $LASTEXITCODE" }

$size = (Get-Item $target).Length
Write-Host "Downloaded $([math]::Round($size / 1MB, 1)) MB to $target"

if ($md5Url) {
    try {
        $expected = (curl.exe -s -m 60 $md5Url).Split(' ')[0].Trim()
        if ($expected -and $expected.Length -eq 32) {
            $actual = (Get-FileHash -Algorithm MD5 -Path $target).Hash.ToLower()
            if ($actual -eq $expected.ToLower()) {
                Write-Host "MD5 verified: $actual"
            } else {
                Write-Warning "MD5 mismatch: expected $expected, got $actual"
            }
        }
    } catch {
        Write-Warning "Could not verify MD5 checksum: $_"
    }
}

Write-Host "Done. Next: npm run data:extract"
