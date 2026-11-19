/**
 * Small interactive 3D viewer used by the model cards.
 *
 * Owns a tiny independent Three.js scene: the main city scene never lives in
 * React (see docs/ARCHITECTURE.md), but a card-sized preview is a UI widget.
 * Drag rotates the model; left alone it spins slowly and then eases to a stop.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface ModelPreviewGeometry {
  positions: Float32Array;
  colors: Float32Array;
}

interface ModelPreviewProps {
  preview: ModelPreviewGeometry | null;
  emptyLabel?: string;
  testId?: string;
}

export function ModelPreview({
  preview,
  emptyLabel = 'модель загружается…',
  testId,
}: ModelPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
    <div className="model-preview" data-testid={testId}>
      <canvas ref={canvasRef} />
      {!preview && <span className="model-preview-empty">{emptyLabel}</span>}
    </div>
  );
}
