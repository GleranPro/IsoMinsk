# -*- coding: utf-8 -*-
"""Texture -> per-triangle flat colours.

The GLBs are "baked colour" atlases: every UV island is a flat-ish patch of
colour. The engine renders landmarks with flat-shaded vertex colours (same as
the museum exhibits), so each triangle gets one colour sampled at the centroid
of its UV triangle (nearest texel, averaged over the three corners and the
centroid to stay robust against island borders).
"""

from __future__ import annotations

import numpy as np

from lm_common import Model


def triangle_colors(model: Model) -> np.ndarray:
    """(T,3) uint8 colour per triangle."""
    tex = np.asarray(model.texture, dtype=np.float64)
    h, w, _ = tex.shape
    uv = model.uvs[model.indices]  # (T,3,2)
    centroid = uv.mean(axis=1)
    # pull the corner samples 60% towards the centroid so they stay inside the island
    corners = centroid[:, None, :] + (uv - centroid[:, None, :]) * 0.4
    samples = np.concatenate([centroid[:, None, :], corners], axis=1)  # (T,4,2)
    px = np.clip((samples[..., 0] * w).astype(np.int64), 0, w - 1)
    py = np.clip((samples[..., 1] * h).astype(np.int64), 0, h - 1)
    colors = tex[py, px]  # (T,4,3)
    weights = np.array([2.0, 1.0, 1.0, 1.0])[None, :, None]
    out = (colors * weights).sum(axis=1) / weights.sum()
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)
