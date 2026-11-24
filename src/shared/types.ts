/**
 * Isometric Minsk — shared data schemas.
 *
 * These types are the contract between the offline Python pipeline
 * (data/processed -> public/data/tiles) and the browser renderer.
 *
 * COORDINATE CONVENTION (identical everywhere in the app):
 *   All geometry is stored as LOCAL METRES in the UTM 35N plane, translated by
 *   the city origin: local = utm - originUtm.
 *
 *   When converted to Three.js world space:
 *      worldX =  localX
 *      worldY =  heightAboveGroundMetres
 *      worldZ = -localY     (north is -Z, so "up the screen" is north at azimuth 0)
 *
 *   Rings are arrays of [x, y] pairs in local metres. The first ring of a
 *   polygon is the exterior ring, any further rings are holes.
 *   Ring winding is normalised by the pipeline: exterior rings are
 *   counter-clockwise in local metres.
 */

/** A closed linear ring in local metres, without a duplicated closing vertex. */
export type Ring = [number, number][];

/** A polygon: exterior ring + optional holes. */
export type Polygon = Ring[];

/** Stable feature id: `${osmType[0]}${osmId}` e.g. "w123456", "r98765". */
export type FeatureId = string;

export type OsmType = 'way' | 'relation';

export type HeightSource = 'osm_height' | 'osm_levels' | 'heuristic' | 'default';

/**
 * Architectural archetype drives facade style, materials and window rhythm.
 * Classification prefers explicit OSM metadata, then neighborhood heuristics.
 */
export type Archetype =
  | 'stalin' // Soviet neoclassical / Stalinist along the avenue
  | 'khrushchev' // 5-storey low-rise panel/brick blocks
  | 'panel' // Brezhnev-era 9-12 storey panel blocks
  | 'modern' // modern apartment towers
  | 'office' // office and commercial
  | 'historic' // pre-war low-rise
  | 'industrial' // industrial sheds, depots
  | 'small' // garages, kiosks, outbuildings
  | 'civic' // public / cultural / religious buildings
  | 'palace' // monumental civic ensembles (colonnades, loggias)
  | 'stadium'; // sports arenas and grandstands (bowl geometry, no windows)

/**
 * Curated landmark ids that unlock landmark-specific procedural geometry.
 *
 * The offline pipeline assigns these to individual OSM features after manual
 * data review (see `docs/DATA_SOURCES.md`); geometry code may attach extra
 * superstructures (spires, clock dials, emblems) that OSM does not describe.
 */
export type LandmarkId =
  | 'minsk-gate' // Ворота Минска ensemble: two 11-storey towers (clock + emblem crowns)
  | 'national-library' // Национальная библиотека: rhombicuboctahedron "diamond" on a podium
  | 'victory-obelisk' // Монумент Победы on Victory Square: granite obelisk + gold star
  | 'red-church' // Костёл Св. Симеона и Елены: red-brick neo-gothic church, twin spires
  | 'tv-tower'; // Телебашня на ул. Коммунистической: 176 m lattice TV/radio mast

export type RoofShape =
  | 'flat'
  | 'gabled'
  | 'hipped'
  | 'pyramidal'
  | 'skillion'
  | 'dome'
  | 'complex';

/** One volume of a building (OSM `building:part` or the whole footprint). */
export interface BuildingVolume {
  /** Polygon in local metres (exterior ring first). */
  footprint: Polygon;
  /** Absolute bottom elevation of the volume, metres. */
  minHeight: number;
  /** Absolute top elevation (eave level) of the volume, metres. */
  height: number;
  roofShape: RoofShape;
  /** Vertical rise of the roof above `height`, metres. 0 for flat roofs. */
  roofHeight: number;
  /** Direction of the ridge (radians, CCW from +X) for gabled/skillion roofs. */
  roofDirection?: number;
  /** Provenance of the height value. */
  heightSource: HeightSource;
  /** True when this volume comes from an explicit OSM building:part. */
  isPart?: boolean;
}

/**
 * Provenance of an assigned style recipe (payload schema 1).
 *
 * `osm_hint` means a direct type/material/roof/date tag constrained the choice;
 * `heuristic` means only footprint shape, height/levels and district context
 * were used; `legacy_default` marks protected routes (curated landmarks,
 * palace, stadium) that keep their pre-recipe facade preset.
 */
export type BuildingStyleSource = 'osm_hint' | 'heuristic' | 'legacy_default';

/**
 * Offline-assigned building style variant (payload schema 1).
 *
 * An integer recipe id keeps 76,004 records compact. The renderer resolves it
 * through `src/shared/buildingStyles.ts`; ids `0..26` are the family catalog and
 * `27..37` are the legacy archetype presets. `eligibility` is kept for audit
 * only — it is not a claim of surveyed construction era or material.
 */
export interface BuildingStyleVariant {
  /** Version of the selection rules; change only with a reviewed migration. */
  schema: 1;
  /** Stable id in the shared recipe catalog (`0..26` families, `27..37` legacy). */
  recipeId: number;
  /** Where the choice came from. */
  source: BuildingStyleSource;
  /** Eligibility reasons recorded by the offline selector (audit only). */
  eligibility: string[];
}

/** A building, as rendered: one or more non-overlapping volumes. */
export interface BuildingFeature {
  id: FeatureId;
  osmType: OsmType;
  osmId: number;
  /** Human readable name when tagged. */
  name?: string;
  archetype: Archetype;
  /** Number of above-ground floors, when known. */
  levels?: number;
  /** Total height in metres (top of the main volume). */
  height: number;
  /** Dominant roof shape across volumes. */
  roofShape: RoofShape;
  /** Volumes to render; already de-overlapped by the offline pipeline. */
  volumes: BuildingVolume[];
  /**
   * Input volumes, recorded only when a style profile changed `volumes`.
   *
   * `sourceVolumes` is the mapped source massing; `volumes` is the rendered
   * profile. Omitted when identical, so old data stays byte-compatible.
   */
  sourceVolumes?: BuildingVolume[];
  /** Offline style recipe assignment (payload schema 1). Optional for old tiles. */
  styleVariant?: BuildingStyleVariant;
  /** Filtered OSM tags that are useful for the info panel. */
  tags: Record<string, string>;
  /** Optional short description used by the info panel. */
  address?: string;
  /**
   * Curated landmark id (data-pipeline assigned). When present the renderer may
   * add landmark-specific procedural geometry instead of the generic extrusion.
   */
  landmark?: LandmarkId;
  /**
   * Original OSM building outline in local metres (exterior ring first).
   *
   * Only emitted for curated landmarks: the generic per-tile de-overlap can cut
   * the base footprint into pieces around `building:part` volumes, so landmark
   * geometry needs the untrimmed outline to rebuild the real massing.
   */
  outline?: Polygon;
}

/** Road class, drives width and surface colour. */
export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'living_street'
  | 'pedestrian'
  | 'footway'
  | 'cycleway'
  | 'path'
  | 'steps'
  | 'track'
  | 'unknown';

export interface RoadPolygon {
  kind: 'road' | 'footway' | 'rail';
  class: RoadClass;
  /** Polygon of the buffered centreline in local metres. */
  polygon: Polygon;
  /** Width used to buffer the centreline, metres. */
  width: number;
  bridge?: boolean;
  tunnel?: boolean;
  /** Optional name for debugging. */
  name?: string;
}

/**
 * Surface material of a driving/paving piece.
 *
 * OSM `surface` values are folded into this small palette by the offline
 * pipeline (see `scripts/normalize/road_network.py`). The renderer maps the
 * material to a flat tone; no per-class tints are used for the normalized
 * surface partition, because class tints on overlapping polygons were the
 * source of the junction "patchwork" artefacts.
 */
export type RoadMaterial = 'asphalt' | 'stone' | 'concrete' | 'unpaved';

/** Render layer of a normalized road surface piece. */
export type RoadSurfaceKind = 'drivable' | 'paving' | 'kerb' | 'median';

/**
 * One piece of the normalized, non-overlapping road surface partition
 * (payload 0.2.0).
 *
 * Pieces of the same kind never overlap. `drivable` material zones share
 * edges instead of stacking, so a material change is a crisp boundary and
 * coplanar z-fighting cannot occur (no per-polygon height jitter is used for
 * these pieces).
 */
export interface RoadSurfacePiece {
  kind: RoadSurfaceKind;
  /** Material of the surface; required for `drivable`, optional for `paving`. */
  material?: RoadMaterial;
  /** Polygon in local metres, exterior ring first. */
  polygon: Polygon;
  /** True for pieces on a raised bridge deck (renderer adds BRIDGE_RAISE_M). */
  bridge?: boolean;
  /**
   * True for the synthetic asphalt face of a junction (payload 0.3.0). The
   * renderer paints no lane markings inside it; pavements/kerbs are cut around
   * it by the offline pipeline.
   */
  junction?: boolean;
}

/**
 * Semantic road network piece for one tile (payload 0.2.0).
 *
 * The renderer derives lane markings, zebras and stop lines from these
 * centrelines instead of the overlapping surface polygons. `centerline` may
 * overhang the tile by ~4 m so a dash that straddles a tile border is still
 * generated by exactly one tile (the renderer culls bars whose centre is
 * outside the tile bounds).
 */
export interface RoadNetworkPiece {
  kind: 'road' | 'footway' | 'rail';
  class: RoadClass;
  /** Normalized carriageway width, metres. */
  width: number;
  /** Marked lanes: this direction for a one-way, total for a two-way. */
  lanes?: number;
  /**
   * Payload 0.3.0: lanes in the `centerline` direction for a two-way piece.
   * For a one-way piece this equals `lanes` (the direction of travel).
   */
  lanesForward?: number;
  /** Payload 0.3.0: lanes against the `centerline` direction (two-way only). */
  lanesBackward?: number;
  /** Payload 0.3.0: how the lane count was obtained (QA/transparency). */
  lanesSource?: 'tag' | 'default';
  /** `oneway=yes/1/-1` or `junction=roundabout`. */
  oneway?: boolean;
  /**
   * Payload 0.3.0: slip/link road (`highway=*_link`). Rendered as a narrow
   * connector with no centre line or lane dividers.
   */
  link?: boolean;
  /** Payload 0.3.0: `junction=roundabout` ring (one-way, no centre line). */
  roundabout?: boolean;
  /** Canonical material of the street. */
  material?: RoadMaterial;
  /** Raw OSM `surface` value (debug/QA only). */
  surface?: string;
  bridge?: boolean;
  name?: string;
  /**
   * True for a synthetic piece that merges the two near-coincident opposite
   * one-way carriageways of one street into a single two-way corridor
   * (no `oneway`, `lanes` summed, `width` = whole corridor). The renderer
   * paints a double solid centre line on it; QA width checks treat merged
   * pieces separately because they are legitimately wider than a carriageway.
   */
  merged?: boolean;
  /** Flat `[x0,y0,x1,y1,…]` open polyline in local metres. */
  centerline: number[];
  /** Arc length along the source way at `centerline[0]`, metres (dash phase). */
  centerlineOffset: number;
}

/**
 * One approach edge of a junction face (payload 0.3.0).
 */
export interface JunctionApproachFeature {
  /** Direction of travel towards the junction, radians CCW from +X (east, north). */
  angle: number;
  /** Carriageway width of the approach, metres. */
  width: number;
  /** Lanes entering the junction along this approach. */
  lanesForward: number;
  /** Lanes leaving the junction along this approach (0 for a one-way street). */
  lanesBackward: number;
  oneway: boolean;
  /** Slip/link approach (no lane paint). */
  link: boolean;
  /**
   * Stop line across the entering lanes at the junction face boundary, in local
   * metres. Present only where the approach is signalised or has a zebra.
   */
  stopLine?: { x: number; y: number; angle: number; width: number };
}

/**
 * A junction derived from the OSM road graph (payload 0.3.0).
 *
 * `polygon` is the single asphalt face of the junction: no lane markings may be
 * painted inside it. `radius`/`approaches:number` are kept for payload 0.2.0
 * compatibility; a 0.3.0 renderer uses `polygon` when present and only falls
 * back to the clearance radius when the face was dropped.
 */
export interface JunctionFeature {
  /** Stable id derived from the graph node (QA/debug). */
  id?: string;
  x: number;
  y: number;
  /** Conservative radius of the junction box, metres (legacy clearance). */
  radius: number;
  /** Number of distinct streets meeting here. */
  approaches: number;
  /** Junction face ring in local metres, exterior ring first (payload 0.3.0). */
  polygon?: Polygon;
  /** Approach metadata for paint clipping and stop lines (payload 0.3.0). */
  approachEdges?: JunctionApproachFeature[];
  /** True when the face polygon had to fall back to a clearance circle. */
  fallback?: boolean;
}

/** A pedestrian crossing projected onto the road network (payload 0.2.0). */
export interface CrossingFeature {
  x: number;
  y: number;
  /** Road direction at the crossing, radians CCW from +X (east, north). */
  angle: number;
  /** Carriageway width at the crossing, metres. */
  width: number;
  /** Crossing width along the road, metres. */
  span: number;
  kind: 'zebra' | 'signals' | 'unmarked';
  roadClass: RoadClass;
  material?: RoadMaterial;
  oneway?: boolean;
}

export type SurfaceKind =
  | 'grass'
  | 'park'
  | 'forest'
  | 'scrub'
  | 'water'
  | 'river'
  | 'sand'
  | 'pitch'
  | 'cemetery'
  | 'railway'
  | 'plaza'
  | 'residential'
  | 'industrial'
  | 'commercial'
  | 'construction'
  /** amenity=parking areas (payload 0.4.1). */
  | 'parking'
  | 'unknown';

export interface SurfacePolygon {
  kind: SurfaceKind;
  polygon: Polygon;
  name?: string;
}

/** A deterministic tree instance. */
export interface TreeInstance {
  /** Local metres. */
  x: number;
  y: number;
  /** Trunk height, metres. */
  height: number;
  /** Crown radius, metres. */
  radius: number;
  /** 0..1 deterministic variation for colour / shape. */
  variation: number;
  /** Explicitly mapped OSM tree (true) or heuristically placed (false). */
  mapped: boolean;
  /**
   * 0 = broadleaf, 1 = conifer, from OSM `leaf_type`/`genus` where present.
   * Optional: old tiles without the field are read as 0 (broadleaf).
   */
  species?: 0 | 1;
}

/**
 * A non-building attraction rendered by the environment builder (park props).
 *
 * Ferris wheels are mapped in OSM as `attraction=big_wheel` nodes with only a
 * `height` tag; diameter, cabin count and wheel-plane orientation are curated
 * (see `docs/DATA_SOURCES.md`) and carried here so the renderer stays data-driven.
 */
export interface AttractionFeature {
  /** Stable id: `${osmType[0]}${osmId}` (e.g. "n3588199861"). */
  id: FeatureId;
  type: 'ferris-wheel';
  name?: string;
  /** Wheel centre (axle) position in local metres. */
  x: number;
  y: number;
  /** Wheel radius to the cabin pivots, metres. */
  radius: number;
  /** Axle height above ground, metres. */
  hubHeight: number;
  /** Total height above ground, metres (hub + radius + roof allowance). */
  height: number;
  /** Number of cabins evenly spaced on the rim. */
  cabins: number;
  /** Number of those cabins that are open (no window band), for colour variety. */
  openCabins?: number;
  /** Yaw of the wheel plane, radians CCW from +X (east). */
  rotation: number;
}

/** Stroke family of the raster ground compositor (payload 0.4.0). */
export type GroundStrokeKind =
  | 'road'
  | 'path'
  | 'cycle'
  | 'steps'
  | 'ped'
  | 'track'
  | 'tram'
  | 'rail'
  | 'aeroway';

/**
 * One OSM centreline painted into the ground texture (payload 0.4.0).
 *
 * Strokes are clipped per tile with a 64 m margin, so caps created by the clip
 * stay outside the tile and neighbouring tiles paint identical border texels.
 */
export interface GroundStroke {
  k: GroundStrokeKind;
  /** Road class. */
  c: RoadClass;
  /** Carriageway / path width, metres. */
  w: number;
  /** Flat centreline [x0, y0, x1, y1, ...] in local metres. */
  p: number[];
  /** Arc length of p[0] along the source way, metres (dash phase). */
  s0: number;
  /** Fill rank: lower ranks are painted first (major street owns a junction). */
  r: number;
  /** Surface material when not asphalt. */
  mat?: RoadMaterial;
  /** 1 on a bridge deck (rendered as a raised deck, not into the ground). */
  b?: 1;
  /** Synthetic sidewalk width [left, right] of the centreline, metres. */
  sw?: [number, number];
  /** 1 when the carriageway gets a kerb casing. */
  kb?: 1;
  /** Lanes along / against the centreline direction. */
  lf?: number;
  lb?: number;
  /** 1 for one-way carriageways. */
  ow?: 1;
  /** 1 for link / channelization connectors (no lane paint). */
  ln?: 1;
  /** 1: a multi-lane link / connector whose lane dividers are painted (0.4.1). */
  pl?: 1;
  /** On-street parking strip width per side [left, right], metres (0.4.1). */
  pk?: [number, number];
  /** Parking orientation per side: 0 none, 1 parallel, 2 diagonal, 3 perpendicular. */
  po?: [number, number];
  /** 1 for roundabout rings. */
  ra?: 1;
  /**
   * Junction paint trims: flat [a0, b0, a1, b1, ...] arc-length intervals
   * (metres, same frame as `s0`) where no lane paint is drawn.
   */
  nj?: number[];
  /** Source OSM way id (diagnostics). */
  id?: number;
}

export interface GroundLayer {
  version: number;
  strokes: GroundStroke[];
  /** Crossings within 12 m of the tile (border-straddling zebras paint twice). */
  crossings?: CrossingFeature[];
  /**
   * Payload 0.4.1: polygons painted with the strokes — the gap between the two
   * halves of a dual carriageway (`asphalt`, or `tram` track bed when a tram
   * runs in it) and tram stop platforms (`platform`). Whole shapes, attached to
   * every tile they come within 64 m of.
   */
  fills?: GroundFill[];
  /** Payload 0.4.1: solid divider lines between dual-carriageway halves (flat x,y). */
  dividers?: number[][];
  /** Payload 0.4.1: data extent [minX, minY, maxX, maxY]; ground outside stays base. */
  clip?: [number, number, number, number];
  /**
   * Payload 0.4.2 (ground version 2): raised bridge decks owned by this tile
   * (one chunk of at most 128 m; see scripts/normalize/bridge_decks.py).
   */
  decks?: GroundDeck[];
  /** Payload 0.4.2: under-deck shadow polygons painted into the ground texture. */
  shadows?: { p: number[]; h?: number[][] }[];
}

/** One outline ring of a deck chunk: flat x,y; height per vertex; edge kind per edge. */
export interface GroundDeckRing {
  p: number[];
  /** Deck height above the ground at each vertex, metres. */
  z: number[];
  /** Per edge i (vertex i → i+1): 1 side (fascia + parapet), 0 end (meets the street), 2 chunk cut. */
  e: number[];
}

/** A raised bridge deck chunk (payload 0.4.2). */
export interface GroundDeck {
  /** OSM id of the first bridge way (diagnostics). */
  id: number;
  /** Bounds [minX, minY, maxX, maxY] of the deck chunk, metres. */
  bb: [number, number, number, number];
  /** Span height (plateau) above the ground, metres. */
  hz: number;
  /** Top surface triangles: flat [x, y, z] × 3 per triangle, CCW seen from above. */
  t: number[];
  /** Outline rings (exterior CCW, holes CW). */
  r: GroundDeckRing[];
  /** The bridge strokes painted onto the deck texture (no `b` flag). */
  s: GroundStroke[];
  /** Gap fills between the halves of a divided street on the deck. */
  f?: GroundFill[];
  /** Solid divider lines between those halves (flat x, y). */
  dv?: number[][];
}

export interface GroundFill {
  m: 'asphalt' | 'concrete' | 'tram' | 'platform';
  /** Road class of the carriageway an asphalt fill belongs to (colour). */
  c?: RoadClass;
  /** Closed ring, flat [x0, y0, x1, y1, …], local metres. */
  p: number[];
  /** Holes of the polygon (flat rings), painted evenodd. */
  h?: number[][];
  /** 1: draw a kerb along the outline (carriageway-closing fills). */
  kb?: 1;
}

/** Everything needed to render one tile. */
export interface TileData {
  tileX: number;
  tileY: number;
  /** Tile bounds in local metres: [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  buildings: BuildingFeature[];
  surfaces: SurfacePolygon[];
  /**
   * Legacy buffered road polygons. Tiles generated by payload 0.2.0 only carry
   * rail polygons here; the drivable/paving partition lives in
   * `roadSurfaces` and the marking semantics in `roadNetwork`.
   */
  roads: RoadPolygon[];
  /** Normalized, non-overlapping road surface partition (payload 0.2.0). */
  roadSurfaces?: RoadSurfacePiece[];
  /** Semantic road network used for markings and crossings (payload 0.2.0). */
  roadNetwork?: RoadNetworkPiece[];
  /** Junction boxes that lane markings must not enter (payload 0.2.0). */
  junctions?: JunctionFeature[];
  /** Pedestrian crossings projected onto the road network (payload 0.2.0). */
  crossings?: CrossingFeature[];
  /**
   * Painter's-order ground strokes for the raster ground compositor (payload
   * 0.4.0, see docs/ROAD_NETWORK.md). Independent of the vector partition.
   */
  ground?: GroundLayer;
  trees: TreeInstance[];
  /** Non-building park attractions (ferris wheels). Optional for old tiles. */
  attractions?: AttractionFeature[];
  /**
   * Building ids whose footprint crosses this tile but which are owned by
   * another tile. Renderers use this for spatial indexing only; the geometry
   * itself lives in the owning tile so it is never rendered twice.
   */
  crossingBuildingIds?: FeatureId[];
}

export interface TileManifest {
  version: string;
  generatedAt: string;
  /** Projection used for local coordinates. */
  epsg: number;
  /** UTM 35N easting/northing that maps to local (0, 0). */
  originUtm: [number, number];
  /** Pilot centre used to derive originUtm. */
  centerLatLon: [number, number];
  tileSize: number;
  /** Inclusive min / max tile indices. */
  tileRange: { minX: number; minY: number; maxX: number; maxY: number };
  /** Total local-metre bounds covered by the tile grid (streamable extent). */
  bounds: [number, number, number, number];
  /** Requested pilot/city area inside the tile grid. */
  pilotBounds?: [number, number, number, number];
  tiles: TileIndexEntry[];
  counts: {
    buildings: number;
    buildingsWithExplicitHeight: number;
    buildingsWithLevels: number;
    buildingsWithRoofShape: number;
    surfaces: number;
    roads: number;
    trees: number;
    /** Park attractions (ferris wheels); optional for older manifests. */
    attractions?: number;
    /** Normalized surface pieces; optional for payload 0.2.0+ tiles. */
    roadSurfaces?: number;
    /** Network pieces carrying centrelines; optional for payload 0.2.0+. */
    roadNetwork?: number;
    /** Junction boxes; optional for payload 0.2.0+. */
    junctions?: number;
    /** Pedestrian crossings; optional for payload 0.2.0+. */
    crossings?: number;
  };
  /** Provenance and licence information, shown in the attribution panel. */
  attribution: AttributionEntry[];
}

export interface TileIndexEntry {
  x: number;
  y: number;
  /** Path relative to the data base URL, e.g. "tiles/3_4.json". */
  file: string;
  /** Number of buildings owned by this tile. */
  buildings: number;
  /** Uncompressed byte size of the tile JSON. */
  bytes: number;
}

export interface AttributionEntry {
  name: string;
  url: string;
  licence: string;
  note?: string;
}

/** Tile coordinates -> local metre bounds. */
export interface TileAddress {
  x: number;
  y: number;
}
