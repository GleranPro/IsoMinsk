/**
 * WebGL2 renderer host.
 *
 * Owns the canvas element, the WebGLRenderer configuration (low-resolution,
 * sRGB, tone mapping, shadows, context-loss reporting) and the resize plumbing.
 * The renderer draws into either the default framebuffer (pixel-art effect off)
 * or a low-resolution render target owned by the post-processing module.
 */

import * as THREE from 'three';

export interface RendererHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** CSS pixel size of the drawing surface. */
  readonly width: number;
  readonly height: number;
  /** Measure the container and resize the drawing buffer when it changed. */
  resize(): boolean;
  dispose(): void;
}

export interface RendererHostOptions {
  /** Called once if the WebGL context is lost, and again when restored. */
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onError?: (message: string) => void;
  /** Tone mapping exposure; the pixel pass mirrors it in GLSL. */
  exposure?: number;
}

export function createRendererHost(
  container: HTMLElement,
  options: RendererHostOptions = {},
): RendererHost | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
  } catch (error) {
    options.onError?.(`WebGL2 renderer could not be created: ${String(error)}`);
    return null;
  }

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.outline = 'none';
  canvas.style.touchAction = 'none';
  canvas.style.imageRendering = 'pixelated';
  canvas.setAttribute('aria-label', 'Isometric map of Minsk');
  container.appendChild(canvas);

  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Shadow maps are re-rendered only when the camera / lighting / tiles change.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.debug.checkShaderErrors = true;

  let width = 1;
  let height = 1;
  let disposed = false;

  function measure(): { width: number; height: number } {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width || container.clientWidth || 1));
    const h = Math.max(1, Math.floor(rect.height || container.clientHeight || 1));
    return { width: w, height: h };
  }

  function resize(): boolean {
    if (disposed) return false;
    const next = measure();
    if (next.width === width && next.height === height) return false;
    width = next.width;
    height = next.height;
    // updateStyle = false: the stylesheet stretches the canvas to 100%.
    renderer.setSize(width, height, false);
    renderer.setViewport(0, 0, width, height);
    return true;
  }

  resize();

  const onContextLost = (event: Event) => {
    event.preventDefault();
    options.onContextLost?.();
  };
  const onContextRestored = () => {
    renderer.shadowMap.needsUpdate = true;
    options.onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost as EventListener, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  return {
    renderer,
    canvas,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* context may already be gone */
      }
      canvas.remove();
    },
  };
}
