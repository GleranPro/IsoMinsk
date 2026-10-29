# Requirements — original project brief (verbatim)

> **Source of record.** This is the original assignment text, provided verbatim by
> the project owner on 2026-10-29 (recovered from the first message of the
> project). It is stored unchanged apart from markdown formatting normalisation;
> do not edit it. The compliance analysis against this brief lives in
> [`docs/REQUIREMENTS.md`](REQUIREMENTS.md).

---

# PROJECT: ISOMETRIC MINSK

## Your role

You are the Lead Software Architect, Technical Project Manager, and Integration Engineer of **Isometric Minsk**, an interactive pixel-art 3D map of Minsk, Belarus.

You are working in an AI coding environment. You must actively implement the project, not merely write a development plan.

**Use parallel subagents wherever the execution environment supports them.** You are responsible for the architecture, delegation, integration, testing, quality, and final working application.

Do not ask for confirmation on ordinary engineering decisions. Make reasonable choices, document them, and proceed.

Communicate with me in Russian. Code, technical documentation, commit messages, and agent instructions may be in English.

## 1. Product vision

Build an application inspired by:

- https://bedirhanyildirim.com/warsaw-izo/
- https://bedirhanyildirim.com/pixel-art-map-of-warsaw/

Study the original author's technical explanation before implementation.

The goal is an interactive, geographically accurate, procedurally generated 3D model of Minsk, displayed through a stylized isometric pixel-art renderer.

**This is not a static image generator.**

The application must support:

- Real-world streets, building footprints, parks, and water.
- True 3D buildings with visible walls, roofs, floors, windows, and recognizable facade architecture.
- An orthographic, freely pannable, zoomable, and rotatable camera.
- Pixel-art rendering through real-time GPU rasterization.
- Dynamic loading of city areas.
- Building selection and information display.
- Configurable time of day with lighting and shadows.
- Future support for seasons, animated public transport, terrain, and landmark models.

The target is a visually polished interactive city, not a generic GIS viewer or a collection of plain extruded boxes.

A particularly important requirement is capturing Minsk's architectural identity: Soviet neoclassical buildings, Stalinist architecture along Independence Avenue, Soviet residential neighborhoods, and modern developments.

## 2. Constraints and priorities

Development environment:

- Windows 11
- PowerShell
- Node.js 24
- NVIDIA RTX 3080 Laptop, 16 GB VRAM
- 32 GB system RAM

Prefer free and open-source tooling. Avoid paid APIs and cloud GPU services.

Do not build a backend unless genuinely necessary. Prefer static hosting with precomputed city data.

Use AI for programming, research, and asset preparation. Do NOT generate the complete city as AI images. The final map must be based on real geographical geometry.

Priorities, in order:

1. An actually working application.
2. Accurate location and footprint of buildings.
3. Quality of building facades and recognizable architectural style.
4. High-quality pixel-art rendering.
5. Camera navigation and user interaction.
6. Performance and scalability.
7. Geographic expansion.
8. Secondary animations and atmospheric details.

Do not sacrifice working code or visual quality just to implement more features.

## 3. Technical architecture

Recommended technology stack:

Frontend:

- TypeScript
- Vite
- Three.js
- React for menus and interface only
- GLSL shaders / WebGL2

Offline geographical processing:

- Python 3.11+
- PyProj
- Shapely
- GDAL/Rasterio where appropriate
- PyOsmium or compatible OSM parsing tools

Testing:

- Vitest for pure geometry, coordinate math, and data validation
- Playwright for browser testing and screenshots

Architecture:

Raw geospatial datasets
→ Offline normalization and validation
→ Local metric coordinate system
→ Geographical tile generation
→ Scene geometry generation
→ GPU rendering
→ Pixel-art postprocessing
→ Interactive browser application.

The 3D renderer must be independent from the offline data pipeline.

React must not create or manage thousands of individual building components.

Use a local metric coordinate system, preferably EPSG:32635 (UTM zone 35N), with a floating/local origin in the renderer to prevent precision issues.

Create consistent coordinate conventions across all modules.

Use a tile grid of approximately 512 × 512 meters initially, configurable later.

MVP tile data may use compact JSON/GeoJSON. Design the format so that production data can later be encoded as compact binary arrays with Brotli compression.

The browser must never need to download the entire city's raw geospatial dataset.

## 4. Data acquisition and source evaluation

Research and use legitimate geospatial sources.

Primary sources:

OpenStreetMap / Geofabrik:
https://download.geofabrik.de/europe/belarus.html

Overture Maps:
https://docs.overturemaps.org/getting-data/

GlobalBuildingAtlas:
https://github.com/zhu-xlab/GlobalBuildingAtlas

OSM building tagging:
https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings

Investigate additional openly available DEM, building height, and rooftop data for Minsk.

Do not assume any source has complete coverage, exact roof geometry, or commercial-use permission.

GlobalBuildingAtlas LoD1 and height datasets have noncommercial licensing restrictions. Keep restricted sources optional and isolated until their licenses and project use are compatible.

OpenStreetMap-derived data must retain correct attribution and comply with ODbL obligations.

Do not mass-download satellite images or map tiles from services that prohibit automated bulk downloading.

For every dataset record:

- Provider and source URL.
- Coverage and resolution.
- Date/version where available.
- Licensing and attribution.
- Quality and confidence limitations.

### Building geometry sources

Use a fallback hierarchy:

1. Explicit OSM building geometry, parts, roof, and height attributes.
2. Valid external building-height data, when legally usable and geometrically matched.
3. Building level counts converted into approximate height.
4. Architectural and neighborhood heuristics.
5. Explicit configurable default values.

Maintain provenance for inferred geometry. Never silently present inferred roof shapes or heights as surveyed measurements.

Compare building coverage and height completeness for the pilot area before selecting external datasets.

Do not download a global dataset merely to render one square kilometer of Minsk.

## 5. Initial scope: a working vertical slice

**Start with central Minsk, centered approximately at latitude 53.902, longitude 27.561, near October Square.**

Choose the precise center based on actual OSM features.

Initial playable area: approximately 1 × 1 km, expandable to around 2 × 2 km.

Include actual buildings, roads, green areas, and relevant geographic features inside the selected boundary.

This is the mandatory first milestone.

Do not attempt whole-city generation before the first district looks convincing and operates correctly.

### Milestone A: Geospatial foundation

Implement:

- Automated acquisition or extraction of OSM data for the selected geographic area.
- Building footprint extraction.
- Multipolygon and inner-ring support.
- Parsing OSM `building:part` relations and tags.
- Roads and paths.
- Parks and green areas.
- Water geometry.
- Coordinate conversion into local meters.
- Normalized data schema.
- Reproducible tile generation.
- Tests for invalid geometries, duplicate buildings, and projection correctness.

Generate a data coverage report:

- Number of building footprints.
- Percentage with explicit height.
- Percentage with `building:levels`.
- Percentage with roof shape information.
- Number of invalid or unmatched polygons.
- Building heights inferred from defaults.
- Available external height coverage.

Output should be actual files, not a plan describing them.

### Milestone B: Real 3D buildings

This is a critical milestone.

Implement procedural generation of real building meshes from footprints.

Every visible building must have:

- Vertical facade geometry.
- Roof geometry.
- Consistent elevation and building height.
- Distinct face normals and correct shading.
- Reasonable material and color assignment.
- No holes or floating geometry.

Support complex footprints, concave polygons, holes, and building parts without double-rendering overlapping volumes.

Support, at minimum, roof types:

- Flat
- Gabled
- Hipped
- Skillion
- Pyramidal

Use explicit OSM roof attributes where available. For unsupported complex shapes, use a robust fallback with a warning rather than broken geometry.

### Milestone C: Procedural facades

**Do not stop at building extrusion.**

Build a dedicated facade generation system.

Required facade features:

- Windows arranged in rows and columns.
- Floor-height-aware placement.
- Building-type-dependent window spacing.
- Distinct facade colors and materials.
- Entrances or ground-floor visual differentiation.
- Simplified balconies for appropriate residential archetypes.
- Simple cornices and facade decorations where applicable.
- Different shading for facade orientation.

Develop architectural presets:

1. Soviet neoclassical / Stalinist architecture.
2. Khrushchev-era low-rise apartment blocks.
3. Brezhnev-era panel apartment blocks.
4. Modern apartment towers.
5. Standard office and commercial buildings.
6. Small detached buildings.

Architectural classification must use actual metadata when present. Geographic neighborhood heuristics may supplement the classification but should not be treated as fact.

Generate windows and facade details efficiently through procedural materials, shader logic, instancing, or batched geometry. Avoid one draw call per window.

At close zoom, buildings must visibly have windows and facade structure.

At medium zoom, the city should resemble an actual stylized Minsk neighborhood, rather than grey blocks.

At far zoom, disable unnecessary small details.

### Milestone D: Isometric rendering

Implement:

- Orthographic camera with a classic isometric default angle.
- Smooth pan, zoom, and rotation.
- Mouse and keyboard controls.
- Ground and building shadows.
- Ambient and directional lighting.
- Color palettes appropriate for a pixel-art city.
- Strong readability of building silhouettes.

Implement the pixel-art appearance as an actual post-processing stage.

Suggested techniques:

- Render into a lower-resolution framebuffer.
- Upscale using nearest-neighbor filtering.
- Use depth and normal information for selective outlines.
- Quantize or limit selected colors.
- Control shadow softness and contrast.
- Avoid excessive edge noise.

Expose a debug setting to toggle pixel-art postprocessing so the underlying 3D geometry can be inspected.

The result should feel like a handcrafted isometric city simulation, not a realistic 3D map with a pixelation filter randomly applied.

### Milestone E: Streets and environment

Generate:

- Roads with realistic approximate widths based on OSM attributes.
- Pavements and pedestrian paths.
- Street intersections.
- Parks and grass.
- River or water surfaces where present.
- Simplified trees.
- Railway/tram tracks if located within the pilot area.
- Appropriate surface materials.

Use deterministic vegetation placement based on known mapped trees and suitable land-use polygons.

Do not claim that procedurally placed trees represent individually surveyed trees.

Prevent road surfaces from intersecting walls or floating above the ground.

Terrain can initially be flat, provided the architecture explicitly supports a later terrain-height provider.

### Milestone F: User interaction

Required controls:

- Left-click drag or WASD for moving the camera.
- Mouse wheel for zoom.
- Q/E or right-click drag for camera rotation.
- A reset-to-isometric button.
- Click a building to inspect available metadata.
- Toggle pixel effect.
- Toggle facade details for debugging.
- Time-of-day slider.
- Simple application loading indicator.

Use raycasting or a compatible object-picking strategy with stable feature IDs.

Display an attribution panel for data sources.

## 6. Scaling strategy

After the initial district passes quality checks, implement a city-scale streaming system.

It must support:

- Visible-tile calculation from camera position.
- Background loading of nearby tiles.
- Tile caching and eviction.
- Cancellation of obsolete requests.
- Configurable LOD and view distance.
- Batched mesh generation.
- Shared material resources.
- Geometry and GPU-memory disposal.
- Stable identifiers across tile boundaries.
- Avoidance of duplicate buildings clipped across multiple tiles.

Prefer processing each building once, assigning a primary tile while allowing spatial indexing to include the entire shape when determining visibility.

Avoid geometry cracks at tile borders.

Separate generation of geographic data from interactive rendering.

Do not create tens of thousands of independent Three.js Mesh objects if batching can achieve the same result.

The finished application should be capable of supporting all administrative districts of Minsk without major architectural rewrites.

## 7. Future features — not MVP blockers

Once the foundation is solid, prepare an extensible architecture for:

- Tram vehicles moving along actual mapped track geometry.
- Trolleybuses following road and route geometry.
- Trains.
- Static parked vehicles.
- Sun position based on Minsk coordinates and date/time.
- Nighttime illuminated windows and street lamps.
- Autumn, winter, spring, and summer palettes.
- Snow-covered roofs and terrain.
- Custom landmark models.
- Information cards for historical architecture.
- Bookmarks and deep links to locations.
- Mobile support.

Do not imply transport uses real timetables unless an actual validated timetable dataset is integrated.

Do not implement these features merely to inflate progress while core geometry remains unfinished.

## 8. Multi-agent execution

First inspect the execution environment.

Determine which subagent, teammate, task delegation, parallel tool execution, git worktree, and browser-testing capabilities are actually available.

Use the environment's real mechanisms. Do not invent agent-spawning commands or claim subagents are running when they are not.

Act as the coordinating architect and integrator.

Before delegating implementation, define shared interfaces and project conventions.

Suggested agents:

**Agent A — Geodata Engineer**
Owns raw source ingestion, coordinate transforms, feature normalization, tile output, data validation, and source documentation.

**Agent B — Building Geometry Engineer**
Owns extrusion, building parts, polygon triangulation, roof geometry, height fallback logic, mesh generation, and related tests.

**Agent C — Facades and Art Direction**
Owns procedural facade materials, window patterns, architectural archetypes, pixel-art materials, and visual quality.

**Agent D — Rendering Engineer**
Owns Three.js renderer, camera controls, scene management, lighting, postprocessing, optimization, and object picking.

**Agent E — Environment Engineer**
Owns roads, intersections, terrain integration, vegetation, parks, paths, and water surfaces.

**Agent F — QA and Integration**
Owns browser tests, automated screenshots, performance monitoring, regression tests, and visual issue reporting.

As Lead Engineer, you own overall architecture, shared schemas, integration, and final acceptance.

### Coordination rules

- Establish interfaces before parallelizing dependent work.
- Give each agent a clearly bounded task.
- Assign explicit file/module ownership.
- Prefer separate git worktrees or branches for parallel development.
- Never allow two agents to overwrite the same shared files.
- Integrate completed work only after review and tests.
- Commit at meaningful, working checkpoints.
- Maintain a project-wide progress document and issue list.
- Avoid repeatedly rewriting the same architecture.
- Report genuine blockers rather than generating fake implementations.

If native subagents are unavailable, perform the tasks with the available orchestration mechanisms, or execute them sequentially. Keep the same modular architecture.

## 9. Repository structure

Start with approximately this structure:

isometric-minsk/

- src/
  - app/
  - engine/
    - camera/
    - renderer/
    - materials/
    - shaders/
    - tiles/
    - picking/
  - city/
    - buildings/
    - facades/
    - roofs/
    - roads/
    - environment/
  - ui/
  - shared/
- scripts/
  - ingest/
  - normalize/
  - tiles/
  - validation/
- public/
  - data/
  - landmarks/
- tests/
  - unit/
  - integration/
  - visual/
- docs/
  - ARCHITECTURE.md
  - DATA_SOURCES.md
  - AGENT_TASKS.md
  - PROGRESS.md
  - LIMITATIONS.md
- README.md

You may modify this layout when there is a clear technical reason.

## 10. Quality assurance

Every milestone must have testable acceptance criteria.

### Geodata tests

Validate coordinates, projections, building counts, geometry validity, feature IDs, and tile consistency.

### Geometry tests

Check that roofs are present, facade walls have correct winding and normals, height values are positive, and complex polygons do not crash the application.

### Browser tests

Verify that:

- The development server starts.
- A real Minsk district loads.
- Real building geometries are visible.
- Windows and facades are distinguishable.
- Camera movement, rotation, and zoom work.
- No critical browser errors occur.
- Building selection returns the correct data.
- Reloading and revisiting a tile work.

### Visual QA

If browser automation or screenshot tools are available:

1. Capture an overview of the district.
2. Capture a close-up of a residential building.
3. Capture a close-up of a large central building.
4. Capture a night scene.
5. Inspect screenshots for visual problems.
6. Correct the problems and retest.

Specifically look for:

- Missing roofs.
- Monotonous grey facades.
- Incorrect window placement.
- Floating buildings.
- Clipped roads.
- Excessive pixelation.
- Overlapping or duplicated structures.
- Broken shadows.
- Empty areas caused by failed data parsing.

Do not claim visual tests passed without actually inspecting the outputs.

### Performance

For the first district, aim for smooth 1080p rendering, approximately 45–60 FPS on the specified laptop with its dedicated GPU selected.

Measure real FPS, draw calls, triangle counts, tile-load time, and memory use. Treat the numbers as targets, not guaranteed results.

Do not optimize solely for a synthetic scene containing identical boxes.

## 11. Execution procedure

### Phase 0 — Research and bootstrap

Inspect the repository and runtime.

Research the referenced Warsaw project, available datasets, relevant licenses, and tooling.

Create the initial architecture, feature schemas, task breakdown, and executable project skeleton.

Start the application as soon as possible.

### Phase 1 — First real city render

Import actual central Minsk data.

Render building footprints as extruded 3D volumes, along with streets and basic ground surfaces.

Implement working camera controls.

At this stage the application must already run locally.

### Phase 2 — Architectural quality

Implement roofs, facade patterns, windows, materials, and improved lighting.

This phase must significantly improve the visual quality.

### Phase 3 — Pixel-art identity

Implement postprocessing, outlines, palette, final lighting, and visual adjustments.

Perform close-up and overview visual QA.

### Phase 4 — Streaming and expansion

Add the tile manager and scalability improvements.

Expand to additional districts only after the first district meets quality requirements.

### Phase 5 — Atmosphere and advanced systems

Implement secondary features according to quality, available data, and performance.

## 12. Completion requirements

The initial assignment is complete only when:

- A local browser application actually starts.
- It displays real geographic geometry from central Minsk.
- Buildings are true 3D objects with roofs and visible facades.
- Windows and architectural variations are present.
- An isometric pixel-art rendering mode works.
- Camera pan, rotation, and zoom work.
- The application is not a static illustration.
- Data sources and limitations are documented.
- Essential automated tests pass.
- At least one actual browser screenshot is available, if the environment supports screenshot capture.

Document the precise startup commands in README.md.

Provide a PowerShell-compatible workflow and avoid requiring undocumented manual GIS steps.

After each substantial development phase, report:

- Completed changes.
- Agents and modules involved.
- Files produced.
- Tests actually run.
- Screenshot or observable result.
- Known issues and uncertainties.
- Next priority.

Do not report completed tasks that have not been implemented and tested.

Do not waste time on decorative documentation while the application is not running.

Do not stop after generating a plan. **Begin implementing immediately, spawn supported subagents, integrate the results, and prioritize a playable, visually convincing first district of Minsk.**

When a hard blocker prevents further implementation, document the exact blocker and preserve all completed, runnable work.
