import * as THREE from 'three';

/**
 * Water from pipeline/water.py: flat surfaces at the level the laser scan
 * measured, as runs of square cells. The surface reaches a few metres past
 * OSM's outline, under the banks, so the shoreline is wherever the real
 * bank rises out of it. Waves are moving normals, no geometry.
 */

interface WaterData {
  cell: number;
  minX: number;
  minZ: number;
  /** [row, [[first column, length, level in cm], ...]] */
  rows: [number, [number, number, number][]][];
}

const NOISE = /* glsl */`
  float whash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(whash(i), whash(i + vec2(1, 0)), f.x),
               mix(whash(i + vec2(0, 1)), whash(i + vec2(1, 1)), f.x), f.y);
  }
`;

/** Dark, glossy, with two layers of drifting ripples; uniforms.uTime animates. */
export function waterMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0f2a33, roughness: 0.07, metalness: 0.0 });
  const uniforms = { uTime: { value: 0 } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWaterPos;
        uniform float uTime;
        ${NOISE}`)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          vec2 p = vWaterPos.xz;
          vec2 a = vec2(wnoise(p * 0.7 + uTime * 0.3), wnoise(p * 0.7 - uTime * 0.25 + 3.1)) - 0.5;
          vec2 b = vec2(wnoise(p * 2.3 - uTime * 0.6 + 7.0), wnoise(p * 2.1 + uTime * 0.5)) - 0.5;
          vec2 w = a * 0.5 + b * 0.2;
          vec3 T = normalize(mat3(viewMatrix) * vec3(1.0, 0.0, 0.0));
          vec3 B = normalize(mat3(viewMatrix) * vec3(0.0, 0.0, 1.0));
          normal = normalize(normal + T * w.x + B * w.y);
        }
      `);
  };
  m.customProgramCacheKey = () => 'water';
  return m;
}

/** One mesh for a tile's water, positioned relative to (ox, oz). */
export function waterMesh(data: WaterData, ox: number, oz: number, mat: THREE.Material): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const s = data.cell;
  for (const [row, runs] of data.rows) {
    const z0 = data.minZ + row * s - oz, z1 = z0 + s;
    for (const [col, len, ycm] of runs) {
      const x0 = data.minX + col * s - ox, x1 = x0 + len * s, y = ycm / 100;
      const k = pos.length / 3;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(
    new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'water';
  return mesh;
}
