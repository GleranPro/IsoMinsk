/**
 * Museum exhibit card.
 *
 * Opens when the user clicks an aircraft in the Lipki exhibition. Shows a small
 * interactive 3D preview (drag to rotate, it spins slowly on its own), the
 * exhibit reference and a short description, and links to the museum website.
 *
 * The preview is an independent tiny Three.js scene owned by this component; the
 * main scene never lives in React (see docs/ARCHITECTURE.md), but a 200 px card
 * viewer is a UI widget, not part of the streamed city.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { CityAppHandle, MuseumExhibitSelection } from '../shared/appApi';
import { MUSEUM_INFO, MUSEUM_SITE_PAGE, museumExhibitUrl } from './museumInfo';

interface MuseumPanelProps {
  selection: MuseumExhibitSelection;
  app: CityAppHandle | null;
  onClose: () => void;
}

export function MuseumPanel({ selection, app, onClose }: MuseumPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const info = MUSEUM_INFO[selection.slug];
  const preview = useMemo(
    () => (app ? app.getExhibitPreview(selection.index) : null),
    [app, selection.index],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !preview) return;
    const parent = canvas.parentElement;
    const width = Math.max(parent?.clientWidth ?? 320, 200);
    const height = Math.max(parent?.clientHeight ?? 200, 160);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x232c20, 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x232c20);
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 500);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(preview.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const radius = geometry.boundingSphere?.radius ?? 10;
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
      emissive: new THREE.Color().setRGB(0.05, 0.055, 0.05),
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    const grid = new THREE.GridHelper(radius * 2.4, 8, 0x3c4a38, 0x2f3a2c);
    grid.position.y = -0.02;
    scene.add(grid);

    const key = new THREE.DirectionalLight(0xfff2dd, 4.2);
    key.position.set(radius * 1.2, radius * 2.0, radius * 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 1.8);
    fill.position.set(-radius * 1.6, radius * 0.7, -radius * 1.2);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xd8e6f5, 0x4a5540, 1.6));

    camera.position.set(radius * 1.2, radius * 0.85, radius * 1.3);
    camera.lookAt(0, radius * 0.1, 0);

    let yaw = -0.6;
    let pitch = 0.28;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let speed = 0.22;

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      speed = 0.22;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      yaw += dx * 0.012;
      pitch = Math.max(-0.4, Math.min(1.2, pitch + dy * 0.008));
      speed = 0;
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);

    let raf = 0;
    const clock = new THREE.Clock();
    const render = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      yaw += speed * dt;
      mesh.rotation.y = yaw;
      mesh.rotation.x = pitch;
      mesh.rotation.z = 0;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      geometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [preview]);

  return (
    <aside className="hud museum-card" data-testid="museum-card">
      <header>
        <div>
          <h2>{selection.ref}</h2>
          <p className="museum-subtitle">
            {info?.title ?? selection.slug}
            {info ? ` · ${info.years}` : ''}
          </p>
        </div>
        <button type="button" className="museum-close" onClick={onClose} aria-label="Закрыть карточку">
          ×
        </button>
      </header>

      <div className="museum-preview" data-testid="museum-preview">
        <canvas ref={canvasRef} />
        {!preview && <span className="museum-preview-empty">модель загружается…</span>}
      </div>

      {info && <p className="museum-description">{info.description}</p>}

      <dl className="museum-facts">
        <div>
          <dt>Длина</dt>
          <dd>{selection.lengthM.toFixed(1)} м</dd>
        </div>
        <div>
          <dt>Размах</dt>
          <dd>{selection.spanM.toFixed(1)} м</dd>
        </div>
        <div>
          <dt>Курс</dt>
          <dd>{Math.round(selection.heading)}°</dd>
        </div>
        <div>
          <dt>Место</dt>
          <dd>
            {selection.x.toFixed(0)}, {selection.y.toFixed(0)} м
          </dd>
        </div>
      </dl>

      <div className="museum-links">
        <a href={museumExhibitUrl(selection.slug, selection.ref)} target="_blank" rel="noreferrer">
          Найти этот борт на сайте музея →
        </a>
        <a href={MUSEUM_SITE_PAGE} target="_blank" rel="noreferrer">
          Минский авиамузей на «Белорусском авиадневнике»
        </a>
      </div>
      <p className="museum-hint">Потяните модель, чтобы повернуть.</p>
    </aside>
  );
}
