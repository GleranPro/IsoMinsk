/**
 * Landmark pins — DOM marker layer above the landmark models.
 *
 * Ported from the Warsaw IZO reference (docs/REVERSE_ENGINEERING_WARSAW_IZO.md,
 * §4): a 9×11 pixel-art pin (18×22 CSS px, `image-rendering: pixelated`) is
 * projected from the top of every landmark, overlapping pins are gathered into
 * a group and spread into a row, and a click within 20 px of the marker centre
 * opens the landmark card — even when the model itself is too small or hidden
 * to raycast.
 *
 * The layer is inert to pointers (`pointer-events: none`). Clicks and hover are
 * hit-tested from the existing canvas input path, so dragging a pin pans the
 * map exactly like dragging the ground and the scene pick order stays intact.
 */

import { Vector3, type Camera } from 'three';
import type { LandmarkMeta } from './landmarkLayer';

/**
 * 9×11 marker from the reference: black outline, gold body (#e4b54a — the same
 * accent the app uses for selection) and a dark glyph. Drawn as SVG rects so
 * the browser keeps it crisp at the 2× integer scale.
 */
const PIN_BITMAP = [
  '.KKKKKKK.',
  'KAAAAAAAK',
  'KAAADAAAK',
  'KAAAAAAAK',
  'KAADDAAAK',
  'KAAADAAAK',
  'KAAADAAAK',
  'KAADDDAAK',
  '.KKAAAKK.',
  '...KAK...',
  '....K....',
] as const;

const PIN_COLORS: Record<string, string> = {
  K: '#000000',
  A: '#e4b54a',
  D: '#1d2333',
};

/** Integer upscale of the pixel grid (the reference uses 2). */
export const PIN_SCALE = 2;
export const PIN_WIDTH = PIN_BITMAP[0].length * PIN_SCALE;
export const PIN_HEIGHT = PIN_BITMAP.length * PIN_SCALE;
/** Gap between the model top and the pin tip, CSS px. */
export const PIN_LIFT = 4;
/** Pins overlapping within these gaps are laid out as one row. */
const PIN_GROUP_GAP_X = 2;
const PIN_GROUP_GAP_Y = 4;
/** Cursor distance (CSS px, Chebyshev) that still counts as a pin click. */
export const PIN_HIT_RADIUS = 20;
/** Hard cap on simultaneously visible pins (the reference uses 80). */
export const MAX_PINS = 80;
/** A landmark counts as major from this height / footprint span (reference). */
const MAJOR_HEIGHT_M = 40;
const MAJOR_SPAN_M = 180;

let cachedIconUrl: string | null = null;

/** Data URL of the marker bitmap (cached; safe in a Node unit test). */
export function pinIconDataUrl(): string {
  if (cachedIconUrl) return cachedIconUrl;
  let rects = '';
  PIN_BITMAP.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const color = PIN_COLORS[cell];
      if (!color) return;
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
    });
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN_BITMAP[0].length} ` +
    `${PIN_BITMAP.length}" width="${PIN_WIDTH}" height="${PIN_HEIGHT}" ` +
    `shape-rendering="crispEdges">${rects}</svg>`;
  cachedIconUrl = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return cachedIconUrl;
}

/** Major landmarks stay visible when the pin cap is hit (reference rule). */
export function landmarkPinIsMajor(meta: Pick<LandmarkMeta, 'heightM' | 'extent'>): boolean {
  const [minE, minN, maxE, maxN] = meta.extent;
  const span = Math.max(maxE - minE, maxN - minN);
  return meta.heightM >= MAJOR_HEIGHT_M || span >= MAJOR_SPAN_M;
}

export interface LandmarkPinAnchor {
  slug: string;
  label: string;
  /** Screen point of the model top, container-local CSS px. */
  x: number;
  y: number;
  major: boolean;
}

export interface PlacedLandmarkPin extends LandmarkPinAnchor {
  /** Top-left corner of the 18×22 marker. */
  left: number;
  top: number;
  /** Marker centre used by the click/hover hit test. */
  hitX: number;
  hitY: number;
}

export interface PinViewport {
  width: number;
  height: number;
}

/**
 * Filter, cap, cluster and place the pins for one frame. Pure so the layout can
 * be unit tested without a DOM (the class below only paints the result).
 */
export function layoutLandmarkPins(
  anchors: readonly LandmarkPinAnchor[],
  viewport: PinViewport,
): PlacedLandmarkPin[] {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const centreX = width / 2;
  const centreY = height / 2;

  const visible: LandmarkPinAnchor[] = [];
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;
    const left = anchor.x - PIN_WIDTH / 2;
    const top = anchor.y - PIN_LIFT - PIN_HEIGHT;
    if (left < -PIN_WIDTH || left > width + PIN_WIDTH) continue;
    if (top < 0 || top > height + PIN_HEIGHT) continue;
    visible.push(anchor);
  }

  if (visible.length > MAX_PINS) {
    visible.sort((a, b) => {
      if (a.major !== b.major) return a.major ? -1 : 1;
      const da = Math.abs(a.x - centreX) + Math.abs(a.y - centreY);
      const db = Math.abs(b.x - centreX) + Math.abs(b.y - centreY);
      return da - db;
    });
    visible.length = MAX_PINS;
  }

  const pins: PlacedLandmarkPin[] = visible.map((anchor) => ({
    ...anchor,
    left: Math.round(anchor.x - PIN_WIDTH / 2),
    top: Math.round(anchor.y - PIN_LIFT - PIN_HEIGHT),
    hitX: Math.round(anchor.x),
    hitY: Math.round(anchor.y - PIN_HEIGHT / 2),
  }));

  // Group transitively overlapping markers, then spread each group into one
  // horizontal row around its mean x (the reference layout).
  const groups: PlacedLandmarkPin[][] = [];
  for (const pin of [...pins].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const group = groups.find((members) =>
      members.some(
        (other) =>
          Math.abs(other.x - pin.x) < PIN_WIDTH + PIN_GROUP_GAP_X &&
          Math.abs(other.y - pin.y) < PIN_HEIGHT + PIN_GROUP_GAP_Y,
      ),
    );
    if (group) group.push(pin);
    else groups.push([pin]);
  }

  for (const group of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
    const meanX = group.reduce((sum, pin) => sum + pin.x, 0) / group.length;
    const topY = Math.min(...group.map((pin) => pin.y));
    const step = PIN_WIDTH + PIN_GROUP_GAP_X;
    group.forEach((pin, index) => {
      const x = Math.round(meanX + (index - (group.length - 1) / 2) * step);
      pin.x = x;
      pin.y = topY;
      pin.left = Math.round(x - PIN_WIDTH / 2);
      pin.top = Math.round(topY - PIN_LIFT - PIN_HEIGHT);
      pin.hitX = x;
      pin.hitY = Math.round(topY - PIN_HEIGHT / 2);
    });
  }

  return pins.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Slug of the pin under a container-local point (nearest Manhattan winner). */
export function hitLandmarkPin(
  pins: readonly PlacedLandmarkPin[],
  x: number,
  y: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const pin of pins) {
    const dx = Math.abs(x - pin.hitX);
    const dy = Math.abs(y - pin.hitY);
    if (dx > PIN_HIT_RADIUS || dy > PIN_HIT_RADIUS) continue;
    const distance = dx + dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pin.slug;
    }
  }
  return best;
}

export interface LandmarkPinState {
  pins: Array<{
    slug: string;
    label: string;
    left: number;
    top: number;
    hitX: number;
    hitY: number;
    selected: boolean;
    hovered: boolean;
  }>;
}

/** DOM marker layer; one reusable element per landmark, painted per frame. */
export class LandmarkPinLayer {
  readonly element: HTMLDivElement;
  private readonly container: HTMLElement;
  private readonly elements = new Map<string, HTMLDivElement>();
  private readonly tooltip: HTMLDivElement;
  private metas: readonly LandmarkMeta[] = [];
  private titles: Readonly<Record<string, string>> = {};
  private placed: PlacedLandmarkPin[] = [];
  private selected: string | null = null;
  private hovered: string | null = null;
  private tooltipWidth = 0;
  private tooltipHeight = 0;
  private readonly projected = new Vector3();

  constructor(container: HTMLElement) {
    this.container = container;
    this.element = document.createElement('div');
    this.element.className = 'landmark-pins';
    this.element.dataset.testid = 'landmark-pins';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.style.setProperty('--landmark-pin', pinIconDataUrl());
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'landmark-pin-tip';
    this.tooltip.hidden = true;
    this.element.appendChild(this.tooltip);
    container.appendChild(this.element);
  }

  /** Landmarks to draw (call once the baked manifest has loaded). */
  setLandmarks(
    metas: readonly LandmarkMeta[],
    titles: Readonly<Record<string, string>> = {},
  ): void {
    this.titles = titles;
    this.metas = metas.filter(
      (meta) =>
        Number.isFinite(meta.x) &&
        Number.isFinite(meta.y) &&
        Number.isFinite(meta.heightM) &&
        Array.isArray(meta.extent) &&
        meta.extent.length === 4,
    );
    const known = new Set(this.metas.map((meta) => meta.slug));
    for (const [slug, element] of this.elements) {
      if (known.has(slug)) continue;
      element.remove();
      this.elements.delete(slug);
    }
  }

  setSelected(slug: string | null): void {
    if (this.selected === slug) return;
    this.selected = slug;
    this.applyClasses();
  }

  setHover(slug: string | null): void {
    if (this.hovered === slug) return;
    this.hovered = slug;
    if (slug) {
      const meta = this.metas.find((entry) => entry.slug === slug);
      this.tooltip.textContent = this.titles[slug] ?? meta?.label ?? slug;
      this.tooltip.hidden = false;
      // Measure once per hover change, not per frame.
      this.tooltipWidth = this.tooltip.offsetWidth;
      this.tooltipHeight = this.tooltip.offsetHeight;
    } else {
      this.tooltip.hidden = true;
    }
    this.applyClasses();
  }

  getHover(): string | null {
    return this.hovered;
  }

  /** Project, cluster and paint the current frame. */
  update(camera: Camera): void {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || this.metas.length === 0) {
      this.place([]);
      return;
    }
    camera.updateMatrixWorld();
    const anchors: LandmarkPinAnchor[] = [];
    for (const meta of this.metas) {
      const [minE, minN, maxE, maxN] = meta.extent;
      const centreX = meta.x + (minE + maxE) / 2;
      const centreY = meta.y + (minN + maxN) / 2;
      this.projected.set(centreX, meta.heightM, -centreY).project(camera);
      if (this.projected.z < -1 || this.projected.z > 1) continue;
      anchors.push({
        slug: meta.slug,
        label: this.titles[meta.slug] ?? meta.label,
        x: ((this.projected.x + 1) / 2) * rect.width,
        y: ((1 - this.projected.y) / 2) * rect.height,
        major: landmarkPinIsMajor(meta),
      });
    }
    this.place(layoutLandmarkPins(anchors, { width: rect.width, height: rect.height }));
  }

  /** Container-local hit test for the canvas input path. */
  hitTest(clientX: number, clientY: number): string | null {
    const rect = this.container.getBoundingClientRect();
    return hitLandmarkPin(this.placed, clientX - rect.left, clientY - rect.top);
  }

  getState(): LandmarkPinState {
    return {
      pins: this.placed.map((pin) => ({
        slug: pin.slug,
        label: pin.label,
        left: pin.left,
        top: pin.top,
        hitX: pin.hitX,
        hitY: pin.hitY,
        selected: pin.slug === this.selected,
        hovered: pin.slug === this.hovered,
      })),
    };
  }

  dispose(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
    this.tooltip.remove();
    this.element.remove();
    this.placed = [];
    this.metas = [];
    this.selected = null;
    this.hovered = null;
  }

  private place(pins: PlacedLandmarkPin[]): void {
    this.placed = pins;
    const placedSlugs = new Set(pins.map((pin) => pin.slug));
    for (const [slug, element] of this.elements) {
      if (!placedSlugs.has(slug)) element.hidden = true;
    }
    for (const pin of pins) {
      let element = this.elements.get(pin.slug);
      if (!element) {
        element = document.createElement('div');
        element.className = 'landmark-pin';
        element.dataset.testid = 'landmark-pin';
        element.dataset.slug = pin.slug;
        element.hidden = true;
        this.element.appendChild(element);
        this.elements.set(pin.slug, element);
      }
      element.hidden = false;
      element.style.transform = `translate(${pin.left}px, ${pin.top}px)`;
      // Lower pins draw above higher ones, like the reference's y-sorted list;
      // the selected marker stays on top of its neighbours.
      element.style.zIndex = String(
        Math.round(pin.y) + (pin.slug === this.selected ? 1000 : 0),
      );
      this.markElement(element, pin.slug);
    }
    this.positionTooltip();
  }

  private applyClasses(): void {
    for (const [slug, element] of this.elements) this.markElement(element, slug);
    this.positionTooltip();
  }

  private markElement(element: HTMLDivElement, slug: string): void {
    element.classList.toggle('is-selected', slug === this.selected);
    element.classList.toggle('is-hovered', slug === this.hovered);
  }

  private positionTooltip(): void {
    if (!this.hovered) {
      this.tooltip.hidden = true;
      return;
    }
    const pin = this.placed.find((entry) => entry.slug === this.hovered);
    if (!pin) {
      this.tooltip.hidden = true;
      return;
    }
    const rect = this.container.getBoundingClientRect();
    const half = this.tooltipWidth / 2;
    const x = Math.min(
      Math.max(pin.hitX, half + 4),
      Math.max(half + 4, rect.width - half - 4),
    );
    const y = Math.min(pin.top + PIN_HEIGHT + 4, rect.height - this.tooltipHeight - 4);
    this.tooltip.hidden = false;
    this.tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(-50%)`;
  }
}
