import type * as THREE from 'three';

/*
 * Doing a lot without stopping the game.
 *
 * Bringing a tile to full detail used to happen in one go: terrain meshes,
 * merged buildings, trees, furniture and textures, all inside one frame,
 * which on a phone-speed CPU meant half a second without a picture. Work is
 * now cut into slices of a few milliseconds and spread over frames, and big
 * textures go to the GPU one per frame instead of all on first sight.
 */

/** Resolves at the start of the next frame. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Milliseconds of loading work allowed per frame. */
const BUDGET = 4;
let sliceStart = performance.now();

/** Yields to the next frame if this frame's budget is spent. Call between
 *  units of work; cheap when there is time left. */
export async function breathe(): Promise<void> {
  if (performance.now() - sliceStart < BUDGET) return;
  await nextFrame();
  sliceStart = performance.now();
}

let uploadTexture: (t: THREE.Texture) => void = () => {};

/** World hands over the renderer's texture upload. */
export function setUploader(fn: (t: THREE.Texture) => void): void {
  uploadTexture = fn;
}

/** Send a texture to the GPU now, in a frame of its own, rather than in the
 *  frame where it is first drawn alongside everything else. */
export async function upload(tex: THREE.Texture): Promise<void> {
  await nextFrame();
  uploadTexture(tex);
  sliceStart = performance.now();
}
