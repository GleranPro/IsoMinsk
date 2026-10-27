# Art reference — Isometric Warsaw (bedirhanyildirim.com)

## Source and method (verified)

- Interactive map: <https://bedirhanyildirim.com/warsaw-izo/> — pan, zoom, rotate in the browser.
- Write-up: <https://bedirhanyildirim.com/pixel-art-map-of-warsaw/> (published 21 Oct 2026, updated 24 Oct 2026). Both pages sit behind Cloudflare; the text was read through `r.jina.ai`.
- Author: Bedirhan Yıldırım. ~2 days, built with Claude Code agents, deployed as static files next to WordPress.
- Technique: **a real three.js 3D scene, not AI-painted tiles** — "rendered at half resolution, with a limited palette, dark outlines where depth jumps and every pixel snapped to a grid". No tile seams because the city is drawn in one piece.
- Data: OSM (streets, buildings, water, parks, lamps, traffic lights) + GUGiK **LoD2** buildings (131,686) + **1 m LiDAR terrain** + GUGiK orthophoto for **roof colours** + 1.93 M 3D trees + ZTM/PKP GTFS timetables.
- Scale: 197,000 buildings; 659 data squares of 1 km, loaded on demand; first view ~1.8 s desktop / 1.1 s phone.

## What makes it read as pixel art (from the published screenshots)

1. **Camera:** orthographic, classic isometric angles ("G" resets to them) — ~45° azimuth, ~35.264° elevation, i.e. the 2:1 projection. No perspective convergence; vertical edges stay parallel across the frame.
2. **Pixel grid:** uniform chunky pixels (roughly 2–4 screen px in the 1600 px screenshots), nearest-neighbour upscale, no anti-aliasing. Everything shares one grid, so roofs, kerbs and canopies stair-step consistently.
3. **Palette:** warm and desaturated. Facades cream / sand / salmon / ochre; panel blocks grey-green; glass towers slate blue and teal; roofs terracotta, grey-brown, occasional copper green; trees olive, ochre, orange; roads dark warm grey; pavements light warm grey; plazas sand.
4. **Value hierarchy:** roofs are the lightest large surfaces, facades mid, streets dark. From above, each block reads as a light roof plate framed by dark streets — that contrast, not outlines, does most of the legibility work.
5. **Outlines:** a thin darker edge only where depth jumps (building against ground or another building). Roof ridges and coplanar seams get shading, not outlines. No outline around windows.
6. **Shadows:** one directional sun from the real solar position; long, moderately soft shadows with cool, hue-preserving darkness; tree shadows are separate blobs; shadowed facades still show window bands thanks to ambient fill.
7. **Roofs:** real LoD2 ridgelines and hips (Old Town), colour sampled from orthophoto → variation per building; flat roofs keep parapets and rooftop boxes. Nobody would mistake two neighbouring roofs for one object.
8. **Facades:** window rows read as 1–2 px dark dashes with a one-floor rhythm; ground floors are darker (shopfronts); pastel plaster and brick tones; at distance the pattern collapses into a single tone with subtle banding — detail is scaled to the screen, not the model.
9. **Trees:** faceted low-poly canopies (2–3 visible tones, dark underside), sizes 4–8 m, clustered in rows along streets and clumps in parks. They are the main scale cue next to cars and lamps.
10. **Ground:** roads from OSM tags — width from lane count, medians, lane dashes, stop lines, 23,000 zebra crossings, red cycle lanes, kerbs as light 1–2 px bands, tram rails as thin dark lines. Markings appear only at close zoom.
11. **Density:** thousands of small objects (600k parked cars, 46,873 lamps, 6,700 signals) create high-frequency texture up close while far views stay clean. This is manual LOD: add detail, don't blur it.
12. **Night:** near-black blue base, sparse warm window dots, strings of street lamps tracing the road network, red/green signals; no bloom halos — the pixel grid survives.

## What to copy, what not to

- **Copy:** single sun, strict palette, depth-only outlines, roof colour separated from facade, high object density, detail gated by zoom.
- **Don't copy:** dependence on national LoD2/orthophoto (not available for Minsk), 240 hand-modelled landmarks, the 2-day agent workflow.

## Where our renderer is today (code check)

`docs/ARCHITECTURE.md` describes the intended pipeline; what the checkout currently contains is below.

- Ortho camera at 45° / 35.264°, default `orthoHeight` 420 m, 320 px internal render upscaled with `image-rendering: pixelated`, PCF shadows, Lambert materials.
- `buildingsMesh.ts`, `environmentMeshes.ts` and `facadeMaterial.ts` are **interface stubs**: axis-aligned boxes, flat ground, no trees, no markings, no procedural windows. The palette module and facade presets are real; the `outline` / `colorLevels` / `dither` settings exist but are **not wired to any pass**.
- Consequence: the biggest visual wins right now are geometry and materials, not post-processing.

## Recommendations (12)

1. **Build real LoD1 volumes first.** Extruded footprints with `min_height`, `building:part`, roof shapes and per-volume heights. Post FX cannot rescue boxes; most of the reference's quality comes from geometry and data, not from the pixel filter.
2. **Lock the pixel grid.** Snap the camera target to whole pixels for the current `orthoHeight` (world-to-screen = `2 × orthoHeight / renderHeight`) so panning doesn't shimmer. Keep 45° / 35.264° as the default and "G"-style reset.
3. **Quantise per material, not globally.** 4–5 step ramps for facade, roof, ground, water, foliage; a global 16-level posterise shifts hue across materials. Use `colorLevels` as a per-material clamp, and drop `dither` at 320 px.
4. **Outlines only on depth/normal discontinuities.** One output pixel, colour = base × ~0.55, never pure black; skip coplanar seams and window edges. Width must follow the render resolution, not the zoom.
5. **Facade rhythm at 1–2 px.** Window band ≈ 1 px + 1 px sill; ground floor distinct; cornice as a 1 px lighter line. Disable windows when the bay projects below ~2 px — noise is worse than a flat tone.
6. **Give roofs their own identity.** Material families (tile red-brown, metal grey-green, flat grey) distinct from facades; ridge direction from footprint PCA when `roof:shape` is missing; add chimneys, vents and lift shafts — rooftop clutter sells scale cheaply.
7. **Trees as faceted masses.** 8–12 triangle canopy, 2–3 tones plus dark underside, 4–8 m, clustered along streets and in parks; use OSM `natural=tree` where present and street-row heuristics elsewhere, never a uniform sprinkle.
8. **Dress the ground.** 1–2 px kerb/sidewalk bands, lane dashes and crossings only above a zoom threshold, red cycle lanes where tagged. Muted olive greens and warm greys; no texture noise — the reference's ground is almost flat colour.
9. **One sun, disciplined shadows.** Keep the directional light and PCF map, but tint shadows cool and cap opacity around 0.35–0.5; tighten the shadow frustum to the visible area. Shadowed facades must keep their window pattern.
10. **Atmosphere without a sky.** Fog to the background colour (no sky dome in ortho), 10–15% desaturation with distance, pale horizon so silhouettes stay crisp. Current `TIME_OF_DAY_PRESETS` colours are a good base.
11. **Night as a second palette, not a filter.** Sparse emissive windows (30–50%), OSM lamp points as warm 1 px dots tracing streets, no bloom; roads near-black so the lamp strings read like the reference.
12. **Spend the landmark budget wisely.** 5–10 hand-modelled Minsk landmarks (National Library, Independence Palace, Bolshoi, station, a few church towers) will carry the map; the other 99% should come from data, instanced and merged per 512 m tile to keep draw calls low.
