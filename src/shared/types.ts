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

/** How a pedestrian crossing is treated on the carriageway. */
export type CrossingKind =
  | 'zebra' // marked pedestrian crossing (white bars + stop lines)
  | 'unmarked' // highway=crossing without painted markings
  | 'signals'; // traffic-signal crossing (signals + stop lines; bars if painted)

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
  /**
   * Centreline of the OSM way clipped to this tile piece, as a flat
   * `[x0, y0, x1, y1, …]` array in local metres (open polyline, no closing
   * vertex). Supplied by pipelines from v0.2 for drivable `road` pieces only.
   *
   * This is the unlock for real lane markings, medians and bridge details:
   * they are laid out along the centreline instead of the polygon's
   * minimum-area rectangle. Renderers must keep a fallback for tiles written
   * by older pipelines (the field is absent there).
   */
  centerline?: number[];
  /**
   * Distance along the full OSM way from its first node to the first centreline
   * point, metres. Used to keep dashed markings phase-continuous across tile
   * borders.
   */
  centerlineOffset?: number;
  /** Total marked lanes in both directions (OSM `lanes`), 1..8. */
  lanes?: number;
  /** One-way carriageway (`oneway=yes` / `junction=roundabout`). */
  oneway?: boolean;
  /** OSM `surface` value when it is one the renderer tints (asphalt, paving_stones, …). */
  surface?: string;
  /** On-carriageway cycling provision: painted lane or raised track. */
  cycleway?: 'lane' | 'track';
  /** Where the pipeline emitted sidewalks for this way. */
  sidewalk?: 'both' | 'left' | 'right' | 'none';
  /** Sidewalk strip width used by the pipeline, metres. */
  sidewalkWidth?: number;
}

/**
 * A pedestrian crossing or signalised crossing of a drivable road, projected
 * onto the crossed road's centreline by the offline pipeline.
 *
 * The renderer draws the zebra bars and stop lines from this record, so the
 * marking layout follows the real crossing instead of a heuristic.
 */
export interface CrossingFeature {
  /** Crossing point on the crossed carriageway, local metres. */
  x: number;
  y: number;
  /** Direction of the crossed road at that point, radians CCW from +X (east). */
  angle: number;
  /** Carriageway width at the crossing, metres. */
  width: number;
  kind: CrossingKind;
  /** Class of the crossed road (drives which crossings are painted). */
  roadClass: RoadClass;
  /** Crossing width along the road axis, metres (default 4 m). */
  span?: number;
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
  | 'parking'
  | 'residential'
  | 'industrial'
  | 'commercial'
  | 'construction'
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

/** Everything needed to render one tile. */
export interface TileData {
  tileX: number;
  tileY: number;
  /** Tile bounds in local metres: [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  buildings: BuildingFeature[];
  surfaces: SurfacePolygon[];
  roads: RoadPolygon[];
  /** Pedestrian / signalised crossings on drivable roads. Optional for old tiles. */
  crossings?: CrossingFeature[];
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
    /** Pedestrian / signalised crossings; optional for older manifests. */
    crossings?: number;
    /** Parking surface polygons; optional for older manifests. */
    parking?: number;
    /** Park attractions (ferris wheels); optional for older manifests. */
    attractions?: number;
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
