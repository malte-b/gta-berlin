import * as THREE from 'three';

/*
 * Keeping memory within what a phone browser tab gets (~1-1.5 GB in all).
 *
 * three.js keeps the CPU copy of every texture and mesh after uploading it,
 * which for a static city is dead weight; and each tile's buildings.glb
 * brings its own copies of the same two dozen OSM2World facade textures.
 * See docs/performance.md.
 */

/** Drop a static geometry's CPU arrays once they are on the GPU. Only for
 *  geometry nothing reads back: bounding volumes must be computed first. */
export function freeOnUpload(geo: THREE.BufferGeometry, keepIndex = false): void {
  const free = function (this: { array: unknown }) { this.array = null; };
  for (const a of Object.values(geo.attributes)) (a as THREE.BufferAttribute).onUpload(free);
  if (geo.index && !keepIndex) geo.index.onUpload(free);
}

/** Close a texture's decoded ImageBitmap once it is on the GPU. Its size is
 *  kept in userData.size - a closed bitmap reports 0 x 0 - for measuring. */
export function closeOnUpload(tex: THREE.Texture): void {
  tex.onUpdate = () => {
    const img = tex.image as ImageBitmap | undefined;
    if (img && typeof img.close === 'function') {
      tex.userData.size = [img.width, img.height];
      img.close();
    }
  };
}

/**
 * Textures that are the same in every tile, counted by the tiles using them.
 * OSM2World names its materials after what they are (BRICK, Windows_..., ...),
 * so a material name, a slot and a size identify a texture across tiles.
 */
class SharedTextures {
  private readonly byKey = new Map<string, THREE.Texture>();
  /** References per texture, not per key: one texture can sit under several
   *  keys (one glTF texture in materials of different names). */
  private readonly refs = new Map<THREE.Texture, number>();

  /** The shared copy of `tex`. The caller holds a reference until it calls
   *  release(key), and frees `tex` itself if nothing uses it any more (see
   *  shareMaterialTextures). */
  take(key: string, tex: THREE.Texture): THREE.Texture {
    let t = this.byKey.get(key);
    if (!t) {
      t = tex;
      this.byKey.set(key, t);
      if (!this.refs.has(t)) closeOnUpload(t);
    }
    this.refs.set(t, (this.refs.get(t) ?? 0) + 1);
    return t;
  }

  release(key: string): void {
    const t = this.byKey.get(key);
    if (!t) return;
    const n = (this.refs.get(t) ?? 1) - 1;
    if (n > 0) {
      this.refs.set(t, n);
      return;
    }
    this.refs.delete(t);
    t.dispose();
    for (const [k, v] of this.byKey) if (v === t) this.byKey.delete(k);
  }

  has(tex: THREE.Texture): boolean {
    return this.refs.has(tex);
  }

  get size(): number { return this.refs.size; }
}

export const sharedTextures = new SharedTextures();

const SLOTS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap'] as const;

/**
 * Point the textures of a set of glTF materials (one file's) at the shared
 * copies; returns the keys taken, to release when the materials go. Unnamed
 * materials keep theirs. Copies no material uses any more are freed - only
 * after all materials are done, since one texture can be in several.
 */
export function shareMaterialTextures(mats: Iterable<THREE.Material>): string[] {
  const keys: string[] = [];
  const before = new Set<THREE.Texture>();
  const list = [...mats] as THREE.MeshStandardMaterial[];
  for (const std of list) {
    for (const slot of SLOTS) {
      const tex = std[slot];
      if (!tex) continue;
      before.add(tex);
      if (!std.name) continue;
      const img = tex.image as { width?: number; height?: number } | undefined;
      const key = `${std.name}|${slot}|${img?.width ?? 0}x${img?.height ?? 0}`;
      std[slot] = sharedTextures.take(key, tex);
      keys.push(key);
    }
  }
  const after = new Set<THREE.Texture>();
  for (const std of list) for (const slot of SLOTS) if (std[slot]) after.add(std[slot]!);
  for (const tex of before) {
    if (after.has(tex)) continue;
    (tex.image as ImageBitmap | undefined)?.close?.();
    tex.dispose();
  }
  return keys;
}
