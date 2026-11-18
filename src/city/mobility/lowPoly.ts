/**
 * Isometric Minsk — низкополигональный конструктор геометрии мобильности.
 *
 * Общий помощник для процедурных моделей транспорта (`vehicleGeometry.ts`) и
 * светофоров (`signalGeometry.ts`). Он не создаёт материалов и текстур: каждая
 * модель — один неиндексированный `BufferGeometry` с атрибутами `position` и
 * `color` (vertex colors), поэтому весь парк рисуется общим материалом.
 *
 * Соглашения по локальным осям моделей:
 *   +X — направление движения (перед транспорта / направление обслуживаемого
 *        движения у светофора);
 *   +Y — вверх;
 *   +Z — вправо относительно направления +X (X × Y = Z, правая тройка).
 *
 * Цвета вершин хранятся в ЛИНЕЙНОМ рабочем пространстве three.js: функция
 * `linearRgb()` переводит sRGB-hex в линейные значения, потому что материалы с
 * `vertexColors` умножают атрибут напрямую, без дополнительной конверсии.
 * Материал-владелец обязан использовать `vertexColors: true`.
 */

import * as THREE from 'three';

/** Линейный цвет RGB в рабочем пространстве three.js, компоненты 0..1. */
export type LinearRgb = readonly [number, number, number];

/** Точка локального пространства модели, метры. */
export type Vec3 = readonly [number, number, number];

/** Стороны параллелепипеда для `SurfaceBuilder.box`. */
export type BoxFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Множители затенения по умолчанию: верх светлее, низ темнее. */
export const DEFAULT_FACE_SHADE: Readonly<Record<BoxFace, number>> = {
  top: 1,
  bottom: 0.5,
  front: 0.96,
  back: 0.82,
  left: 0.9,
  right: 0.9,
};

/** Без затенения: все грани одного цвета (стекло, фонари, линзы). */
export const FLAT_FACE_SHADE: Readonly<Record<BoxFace, number>> = {
  top: 1,
  bottom: 1,
  front: 1,
  back: 1,
  left: 1,
  right: 1,
};

const HEX_PATTERN = /^#([0-9a-f]{6})$/i;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** sRGB-компонента 0..1 -> линейная (точная формула IEC 61966-2-1). */
export function srgbToLinear(value: number): number {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB-hex `#rrggbb` -> линейный цвет. Бросает на некорректном значении. */
export function linearRgb(hex: string): LinearRgb {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) throw new Error(`ожидался цвет #rrggbb, получено "${hex}"`);
  const value = Number.parseInt(match[1], 16);
  return [
    srgbToLinear(((value >> 16) & 0xff) / 255),
    srgbToLinear(((value >> 8) & 0xff) / 255),
    srgbToLinear((value & 0xff) / 255),
  ];
}

/** Умножение линейного цвета на коэффициент (для затенения граней). */
export function scaleRgb(color: LinearRgb, factor: number): LinearRgb {
  return [clamp01(color[0] * factor), clamp01(color[1] * factor), clamp01(color[2] * factor)];
}

/** Смешивание двух линейных цветов. */
export function mixRgb(a: LinearRgb, b: LinearRgb, t: number): LinearRgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Размер атрибутов и индекса геометрии в байтах (учёт памяти шаблонов). */
export function geometryByteLength(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

/** Число треугольников геометрии с учётом индексирования. */
export function geometryTriangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  if (index) return index.count / 3;
  return geometry.getAttribute('position').count / 3;
}

function normalize3(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  if (length < 1e-9) return [0, 0, 0];
  return [x / length, y / length, z / length];
}

/**
 * Сборщик низкополигональной геометрии.
 *
 * Вершины не разделяются между треугольниками, поэтому `computeVertexNormals`
 * даёт плоские нормали без `mergeVertices` и без индексирования. Порядок обхода
 * треугольников задаётся вызывающим, а методы с явной нормалью (`quad`,
 * `triangleFacing`) при необходимости меняют обход, чтобы нормаль смотрела
 * наружу.
 */
export class SurfaceBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  /** Число уже добавленных треугольников. */
  get triangleCount(): number {
    return this.positions.length / 9;
  }

  /** Один треугольник; обход используется как есть. */
  triangle(a: Vec3, b: Vec3, c: Vec3, color: LinearRgb): void {
    this.pushVertex(a, color);
    this.pushVertex(b, color);
    this.pushVertex(c, color);
  }

  /** Треугольник с гарантированной наружной нормалью `outward`. */
  triangleFacing(a: Vec3, b: Vec3, c: Vec3, outward: Vec3, color: LinearRgb): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
      this.pushVertex(a, color);
      this.pushVertex(c, color);
      this.pushVertex(b, color);
      return;
    }
    this.pushVertex(a, color);
    this.pushVertex(b, color);
    this.pushVertex(c, color);
  }

  /** Четырёхугольник как два треугольника с наружной нормалью `outward`. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, outward: Vec3, color: LinearRgb): void {
    this.triangleFacing(a, b, c, outward, color);
    this.triangleFacing(a, c, d, outward, color);
  }

  /** Параллелепипед с затенением граней (по умолчанию `DEFAULT_FACE_SHADE`). */
  box(
    center: Vec3,
    size: Vec3,
    color: LinearRgb,
    shade: Readonly<Record<BoxFace, number>> = DEFAULT_FACE_SHADE,
  ): void {
    const [cx, cy, cz] = center;
    const hx = size[0] * 0.5;
    const hy = size[1] * 0.5;
    const hz = size[2] * 0.5;
    const x0 = cx - hx;
    const x1 = cx + hx;
    const y0 = cy - hy;
    const y1 = cy + hy;
    const z0 = cz - hz;
    const z1 = cz + hz;
    const corner = (x: number, y: number, z: number): Vec3 => [x, y, z];
    // Индексы углов: 0..3 — низ (z0/z1, x0/x1), 4..7 — верх.
    const p0 = corner(x0, y0, z0);
    const p1 = corner(x1, y0, z0);
    const p2 = corner(x1, y0, z1);
    const p3 = corner(x0, y0, z1);
    const p4 = corner(x0, y1, z0);
    const p5 = corner(x1, y1, z0);
    const p6 = corner(x1, y1, z1);
    const p7 = corner(x0, y1, z1);
    this.quad(p4, p5, p6, p7, [0, 1, 0], scaleRgb(color, shade.top));
    this.quad(p0, p3, p2, p1, [0, -1, 0], scaleRgb(color, shade.bottom));
    this.quad(p1, p2, p6, p5, [1, 0, 0], scaleRgb(color, shade.front));
    this.quad(p0, p4, p7, p3, [-1, 0, 0], scaleRgb(color, shade.back));
    this.quad(p3, p2, p6, p7, [0, 0, 1], scaleRgb(color, shade.right));
    this.quad(p0, p1, p5, p4, [0, 0, -1], scaleRgb(color, shade.left));
  }

  /**
   * Цилиндр вдоль оси Z (колёса): ось проходит через `center`, торец смотрит в
   * ±Z. `halfLength` — половина толщины, `segments` — число боковых граней.
   */
  cylinderZ(
    center: Vec3,
    radius: number,
    halfLength: number,
    segments: number,
    sideColor: LinearRgb,
    capColor: LinearRgb,
  ): void {
    const [cx, cy, cz] = center;
    const count = Math.max(3, Math.round(segments));
    const z0 = cz - halfLength;
    const z1 = cz + halfLength;
    for (let i = 0; i < count; i += 1) {
      const a0 = (i / count) * Math.PI * 2;
      const a1 = ((i + 1) / count) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius;
      const y0 = cy + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const y1 = cy + Math.sin(a1) * radius;
      const mid = (a0 + a1) * 0.5;
      const outward = normalize3(Math.cos(mid), Math.sin(mid), 0);
      this.quad(
        [x0, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y0, z1],
        outward,
        sideColor,
      );
      this.triangleFacing([cx, cy, z0], [x0, y0, z0], [x1, y1, z0], [0, 0, -1], capColor);
      this.triangleFacing([cx, cy, z1], [x0, y0, z1], [x1, y1, z1], [0, 0, 1], capColor);
    }
  }

  /**
   * Цилиндр вдоль оси Y (стойки светофоров): основание в `base`, высота
   * `height`. Основание и верх закрыты крышками.
   */
  cylinderY(
    base: Vec3,
    radius: number,
    height: number,
    segments: number,
    sideColor: LinearRgb,
    capColor: LinearRgb,
  ): void {
    const [cx, cy, cz] = base;
    const count = Math.max(3, Math.round(segments));
    const y1 = cy + height;
    for (let i = 0; i < count; i += 1) {
      const a0 = (i / count) * Math.PI * 2;
      const a1 = ((i + 1) / count) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius;
      const z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const z1 = cz + Math.sin(a1) * radius;
      const mid = (a0 + a1) * 0.5;
      const outward = normalize3(Math.cos(mid), 0, Math.sin(mid));
      this.quad(
        [x0, cy, z0],
        [x1, cy, z1],
        [x1, y1, z1],
        [x0, y1, z0],
        outward,
        sideColor,
      );
      this.triangleFacing([cx, cy, cz], [x0, cy, z0], [x1, cy, z1], [0, -1, 0], capColor);
      this.triangleFacing([cx, y1, cz], [x0, y1, z0], [x1, y1, z1], [0, 1, 0], capColor);
    }
  }

  /**
   * Тонкий стержень (штанга троллейбуса, рычаг пантографа) из точки `a` в `b`.
   * Квадратное сечение `thickness` (полная толщина), торцы закрыты.
   */
  rod(a: Vec3, b: Vec3, thickness: number, color: LinearRgb): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) return;
    const dir: Vec3 = [dx / length, dy / length, dz / length];
    const reference: Vec3 = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize3(
      dir[1] * reference[2] - dir[2] * reference[1],
      dir[2] * reference[0] - dir[0] * reference[2],
      dir[0] * reference[1] - dir[1] * reference[0],
    );
    const v: Vec3 = [
      dir[1] * u[2] - dir[2] * u[1],
      dir[2] * u[0] - dir[0] * u[2],
      dir[0] * u[1] - dir[1] * u[0],
    ];
    const t = thickness * 0.5;
    const offset = (point: Vec3, su: number, sv: number): Vec3 => [
      point[0] + u[0] * t * su + v[0] * t * sv,
      point[1] + u[1] * t * su + v[1] * t * sv,
      point[2] + u[2] * t * su + v[2] * t * sv,
    ];
    const aUU = offset(a, 1, 1);
    const aUN = offset(a, 1, -1);
    const aNN = offset(a, -1, -1);
    const aNU = offset(a, -1, 1);
    const bUU = offset(b, 1, 1);
    const bUN = offset(b, 1, -1);
    const bNN = offset(b, -1, -1);
    const bNU = offset(b, -1, 1);
    this.quad(aUU, aUN, bUN, bUU, u, color);
    this.quad(aNN, aNU, bNU, bNN, [-u[0], -u[1], -u[2]], color);
    this.quad(aNU, aUU, bUU, bNU, v, color);
    this.quad(aUN, aNN, bNN, bUN, [-v[0], -v[1], -v[2]], color);
    this.triangleFacing(aUU, aUN, aNN, [-dir[0], -dir[1], -dir[2]], color);
    this.triangleFacing(aUU, aNN, aNU, [-dir[0], -dir[1], -dir[2]], color);
    this.triangleFacing(bUU, bUN, bNN, dir, color);
    this.triangleFacing(bUU, bNN, bNU, dir, color);
  }

  /**
   * Вытягивание замкнутого профиля вдоль X (кузов транспорта).
   *
   * `profile` — точки `[z, y]`, заданные ПРОТИВ часовой стрелки в плоскости
   * (z, y), если смотреть со стороны +X. `x0` — задний торец, `x1` — передний.
   * `colorForSegment` получает индекс стороны профиля (от нижней грани к
   * верхней) и обе точки, чтобы окрасить полосу окон/крышу/юбку.
   */
  loft(
    profile: readonly (readonly [number, number])[],
    x0: number,
    x1: number,
    colorForSegment: (index: number, from: readonly [number, number], to: readonly [number, number]) => LinearRgb,
    caps: Readonly<{ back: LinearRgb; front: LinearRgb }>,
  ): void {
    const count = profile.length;
    if (count < 3) throw new Error('профиль кузова должен содержать не менее трёх точек');
    let area = 0;
    for (let i = 0; i < count; i += 1) {
      const current = profile[i];
      const next = profile[(i + 1) % count];
      area += current[0] * next[1] - next[0] * current[1];
    }
    if (area <= 0) {
      throw new Error('профиль кузова должен быть задан против часовой стрелки в плоскости (z, y)');
    }
    for (let i = 0; i < count; i += 1) {
      const from = profile[i];
      const to = profile[(i + 1) % count];
      const dz = to[0] - from[0];
      const dy = to[1] - from[1];
      const outward: Vec3 = normalize3(0, -dz, dy);
      this.quad(
        [x0, from[1], from[0]],
        [x0, to[1], to[0]],
        [x1, to[1], to[0]],
        [x1, from[1], from[0]],
        outward,
        colorForSegment(i, from, to),
      );
    }
    // Торцы: веер от первой точки профиля; обход выправляется по нормали.
    const first = profile[0];
    for (let i = 1; i < count - 1; i += 1) {
      const b = profile[i];
      const c = profile[i + 1];
      this.triangleFacing([x1, first[1], first[0]], [x1, b[1], b[0]], [x1, c[1], c[0]], [1, 0, 0], caps.front);
      this.triangleFacing([x0, first[1], first[0]], [x0, b[1], b[0]], [x0, c[1], c[0]], [-1, 0, 0], caps.back);
    }
  }

  /** Готовая неиндексированная геометрия с позициями, цветами и нормалями. */
  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private pushVertex(point: Vec3, color: LinearRgb): void {
    this.positions.push(point[0], point[1], point[2]);
    this.colors.push(color[0], color[1], color[2]);
  }
}
