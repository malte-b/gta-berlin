import * as THREE from 'three';

/*
 * Materials.
 *
 * Everything that sits in the city is a three.js MeshStandardMaterial, so the
 * buildings OSM2World textured, the terrain and the trees all share one
 * physically based lighting model: the same sun, the same shadows, the same
 * fog and tone mapping. The terrain and trees extend the standard material
 * through onBeforeCompile instead of being raw shaders, which is what lets
 * them receive shadows for free.
 */

export interface GroundTextures {
  cover: THREE.Texture;
  coverMin: THREE.Vector2;
  coverSize: THREE.Vector2;
  color: Record<GroundKind, THREE.Texture>;
  normal: Record<GroundKind, THREE.Texture>;
}

export type GroundKind = 'asphalt' | 'paving' | 'grass' | 'yard';

/** A true-orthophoto tile draped over one terrain chunk. */
export interface OrthoTile {
  map: THREE.Texture;
  min: THREE.Vector2;
  size: number;
}

/** Real-world edge length one texture repeat represents, in metres. These
 *  match OSM2World's standard style for the same materials. */
const TILE_METRES: Record<GroundKind, number> = {
  asphalt: 1.2, paving: 1.0, grass: 1.0, yard: 1.6,
};

const NOISE = /* glsl */`
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }
`;

/**
 * The ground: laser-scan terrain painted with what OpenStreetMap says is
 * there. The cover mask carries one class per channel (R carriageway, G path,
 * B vegetation, A water) at 0.5 m; each class has a tiling PBR texture, and
 * the mask's linear filtering gives soft edges between them.
 *
 * Tiling textures repeat visibly over a city block, so every class is sampled
 * twice - at its true scale and at a larger, rotated one - and the two are
 * mixed by low-frequency noise. Cheap, and it removes the grid.
 *
 * With an orthophoto tile the photograph supplies the colour - real markings,
 * crossings, kerbs and paths. At 20 cm a pixel it turns to mush underfoot, so
 * close to the camera the class textures add their grain back: only their
 * brightness relative to their own average, so the photo's colours survive.
 */
export function terrainMaterial(t: GroundTextures, ortho?: OrthoTile): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  if (ortho) m.defines = { USE_ORTHO: '' };
  const uniforms = {
    uOrtho: { value: ortho?.map ?? null },
    uOrthoMin: { value: ortho?.min ?? new THREE.Vector2() },
    uOrthoSize: { value: ortho?.size ?? 1 },
    uCover: { value: t.cover },
    uCoverMin: { value: t.coverMin },
    uCoverSize: { value: t.coverSize },
    uAsphalt: { value: t.color.asphalt }, uAsphaltN: { value: t.normal.asphalt },
    uPaving: { value: t.color.paving }, uPavingN: { value: t.normal.paving },
    uGrass: { value: t.color.grass }, uGrassN: { value: t.normal.grass },
    uYard: { value: t.color.yard }, uYardN: { value: t.normal.yard },
    uTime: { value: 0 },
    uWet: { value: 0 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vWorldPos;
        uniform sampler2D uCover;
        uniform vec2 uCoverMin, uCoverSize;
        uniform sampler2D uAsphalt, uAsphaltN, uPaving, uPavingN;
        uniform sampler2D uGrass, uGrassN, uYard, uYardN;
        uniform float uTime, uWet;
        uniform sampler2D uOrtho;
        uniform vec2 uOrthoMin;
        uniform float uOrthoSize;
        ${NOISE}
        // An aerial photo is not albedo: it already holds the sun and sky of
        // the survey day. Lit again as if it were bare surface colour it
        // comes out washed-out white, so it is brought down to the albedo
        // range of real pavements and roofs and given back some contrast.
        vec3 photoAlbedo(vec3 c) { return pow(c, vec3(1.18)) * 0.62; }
        // a texture's mean colour: any coordinate, sampled at its smallest mip
        vec3 mean(sampler2D t) { return texture2D(t, vec2(0.5), 16.0).rgb; }
        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        vec4 gCover;
        float gVar;
        vec2 rot(vec2 p) { return mat2(0.8, -0.6, 0.6, 0.8) * p; }
        vec3 tile(sampler2D t, vec2 p, float s) {
          vec3 a = texture2D(t, p / s).rgb;
          vec3 b = texture2D(t, rot(p) / (s * 2.7) + 0.37).rgb;
          return mix(a, b, gVar);
        }
        vec3 tileN(sampler2D t, vec2 p, float s) {
          vec3 a = texture2D(t, p / s).xyz;
          vec3 b = texture2D(t, rot(p) / (s * 2.7) + 0.37).xyz;
          return mix(a, b, gVar) * 2.0 - 1.0;
        }
      `)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 wxz = vWorldPos.xz;
        gCover = texture2D(uCover, (wxz - uCoverMin) / uCoverSize);
        gVar = smoothstep(0.3, 0.7, vnoise(wxz * 0.045));
        vec3 albedo = tile(uYard, wxz, ${TILE_METRES.yard.toFixed(2)});
        // unmapped ground in Berlin is mostly pavement; let the yard stones
        // show through only in patches
        float yard = smoothstep(0.45, 0.75, vnoise(wxz * 0.02 + 7.0));
        // Berlin pavement weathers grey; the texture is a freshly laid slab
        albedo = mix(tile(uPaving, wxz, ${TILE_METRES.paving.toFixed(2)}) * vec3(0.78, 0.78, 0.8),
                     albedo * 0.85, yard * 0.35);
        // OSM2World's grass texture is dry, sandy turf; push it toward a
        // watered park lawn, patchy rather than uniform
        vec3 lawn = tile(uGrass, wxz, ${TILE_METRES.grass.toFixed(2)})
                  * mix(vec3(0.42, 0.62, 0.26), vec3(0.55, 0.66, 0.30), vnoise(wxz * 0.13));
        albedo = mix(albedo, lawn, gCover.b);
        albedo = mix(albedo, tile(uPaving, rot(wxz), ${(TILE_METRES.paving * 0.8).toFixed(2)}) * vec3(0.95, 0.92, 0.86), gCover.g);
        albedo = mix(albedo, tile(uAsphalt, wxz, ${TILE_METRES.asphalt.toFixed(2)}), gCover.r);
        vec3 water = vec3(0.035, 0.07, 0.085);
        albedo = mix(albedo, water, gCover.a);
        #ifdef USE_ORTHO
          vec3 avg = mean(uYard);
          avg = mix(avg, mean(uGrass) * vec3(0.48, 0.64, 0.28), gCover.b);
          avg = mix(avg, mean(uPaving) * vec3(0.95, 0.92, 0.86), gCover.g);
          avg = mix(avg, mean(uAsphalt), gCover.r);
          float grain = luma(albedo) / max(luma(avg), 0.02);
          float near = 1.0 - smoothstep(12.0, 55.0, length(cameraPosition - vWorldPos));
          vec3 photo = photoAlbedo(texture2D(uOrtho, (wxz - uOrthoMin) / uOrthoSize).rgb);
          albedo = photo * mix(1.0, clamp(grain, 0.4, 1.8), near * 0.75);
        #else
          // large-scale grime so streets are not uniformly clean
          albedo *= 0.86 + 0.22 * vnoise(wxz * 0.11);
        #endif
        diffuseColor.rgb *= albedo;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        roughnessFactor = mix(roughnessFactor, 0.78, gCover.r);
        roughnessFactor = mix(roughnessFactor, 0.06, gCover.a);
        roughnessFactor = mix(roughnessFactor, 0.12, uWet * (1.0 - gCover.b));
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          vec2 p = vWorldPos.xz;
          vec3 tn = tileN(uYardN, p, ${TILE_METRES.yard.toFixed(2)});
          tn = mix(tn, tileN(uGrassN, p, ${TILE_METRES.grass.toFixed(2)}), gCover.b);
          tn = mix(tn, tileN(uPavingN, rot(p), ${(TILE_METRES.paving * 0.8).toFixed(2)}), gCover.g);
          tn = mix(tn, tileN(uAsphaltN, p, ${TILE_METRES.asphalt.toFixed(2)}), gCover.r);
          // ripples on water
          vec2 wv = vec2(vnoise(p * 0.7 + uTime * 0.3), vnoise(p * 0.7 - uTime * 0.25 + 3.1)) - 0.5;
          tn = mix(tn, vec3(wv * 0.6, 1.0), gCover.a);
          // The ground faces roughly up, so world x and z serve as tangent
          // and bitangent; take both into view space alongside the normal.
          vec3 T = normalize(mat3(viewMatrix) * vec3(1.0, 0.0, 0.0));
          vec3 B = normalize(mat3(viewMatrix) * vec3(0.0, 0.0, 1.0));
          normal = normalize(normal + (T * tn.x + B * tn.y) * 0.7);
        }
      `);
  };
  return m;
}

/**
 * Roofs from the orthophoto. Any surface of a building facing upward takes
 * its colour from the photograph instead of OSM2World's roof texture - real
 * tar, gravel, tiles, skylights and solar panels. The photo is a true
 * orthophoto, so roofs sit on their footprints to within about 0.4 m and the
 * lookup is a plain projection of world x/z.
 */
export function photoRoofs(m: THREE.Material, map: THREE.Texture,
                           min: THREE.Vector2, size: THREE.Vector2): void {
  const uniforms = {
    uRoofPhoto: { value: map }, uRoofMin: { value: min }, uRoofSize: { value: size },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoofPos;\nvarying float vUp;')
      .replace('#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvRoofPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vRoofPos;
        varying float vUp;
        uniform sampler2D uRoofPhoto;
        uniform vec2 uRoofMin, uRoofSize;
      `)
      .replace('#include <map_fragment>', /* glsl */`#include <map_fragment>
        {
          vec2 ruv = (vRoofPos.xz - uRoofMin) / uRoofSize;
          float roof = smoothstep(0.5, 0.65, vUp)
                     * step(0.0, ruv.x) * step(ruv.x, 1.0) * step(0.0, ruv.y) * step(ruv.y, 1.0);
          // already lit, like the ground photo - see photoAlbedo there
          vec3 photo = pow(texture2D(uRoofPhoto, ruv).rgb, vec3(1.18)) * 0.62;
          diffuseColor.rgb = mix(diffuseColor.rgb, photo, roof);
        }
      `);
  };
  m.customProgramCacheKey = () => 'photo-roofs';
  m.needsUpdate = true;
}

/**
 * Tree crowns: lumpy instanced blobs. Colour comes per instance (genus plus
 * jitter) and the crown geometry carries baked ambient occlusion in its vertex
 * colours, darker underneath and inside, which is most of what makes a blob
 * read as foliage.
 */
export function crownMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false,
  });
}

export function trunkMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x4a3f36, roughness: 1, metalness: 0 });
}

/* Photogrammetric mesh ---------------------------------------------------- */

/**
 * The 3D-Meshmodell's own shader. The aerial survey baked sun, sky and shadow
 * into the photographs, so relighting them properly would double up: the
 * photo is used almost as-is, with a flat normal reconstructed from screen
 * derivatives adding only a slight lift. A raw shader, so it linearises,
 * fogs and tone maps itself, as three does for the PBR materials.
 */
export function meshMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,     // photogrammetry has plenty of inconsistent winding
    uniforms: {
      qmin: { value: new THREE.Vector3() },
      qscale: { value: new THREE.Vector3(1, 1, 1) },
      map: { value: null },
      sunDir: { value: new THREE.Vector3(0.42, 0.78, 0.46).normalize() },
      fogColor: { value: new THREE.Color(0x9fb0c4) },
      fogNear: { value: 340 },
      fogFar: { value: 1500 },
      night: { value: 0 },
      exposure: { value: 1.35 },
    },
    vertexShader: /* glsl */`
      uniform vec3 qmin;
      uniform vec3 qscale;
      varying vec3 vPos;
      varying vec2 vUv;
      void main() {
        vec3 p = qmin + position * qscale;
        vPos = p;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vPos;
      varying vec2 vUv;
      uniform sampler2D map;
      uniform vec3 sunDir;
      uniform float night;
      uniform vec3 fogColor;
      uniform float fogNear, fogFar, exposure;
      vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
      vec3 tonemap(vec3 x) {
        const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }
      void main() {
        vec3 base = srgbToLinear(texture2D(map, vUv).rgb);
        vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
        if (dot(n, normalize(cameraPosition - vPos)) < 0.0) n = -n;
        vec3 lit = base * (0.88 + 0.22 * max(dot(n, sunDir), 0.0));
        if (night > 0.001) {
          // dusk: crush toward a cool ambient, keeping some of the photo's own
          // contrast so the streets stay readable
          vec3 dark = vec3(dot(base, vec3(0.299, 0.587, 0.114)));
          lit = mix(lit, mix(base, dark, 0.55) * vec3(0.13, 0.16, 0.26), night);
        }
        float f = smoothstep(fogNear, fogFar, length(cameraPosition - vPos));
        gl_FragColor = vec4(tonemap(mix(lit, fogColor, f) * exposure), 1.0);
      }
    `,
  });
}

/* Sky --------------------------------------------------------------------- */

/** Gradient sky with a sun disc. A raw shader, so it tone maps itself to
 *  match what the renderer does to everything else. */
export function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      night: { value: 0 },
      sunDir: { value: new THREE.Vector3(0.42, 0.78, 0.46).normalize() },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform float night;
      uniform vec3 sunDir;
      vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
      vec3 tonemap(vec3 x) {
        const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 dayLow  = vec3(0.72, 0.79, 0.88);
        vec3 dayHigh = vec3(0.31, 0.48, 0.75);
        vec3 ngtLow  = vec3(0.09, 0.11, 0.17);
        vec3 ngtHigh = vec3(0.02, 0.03, 0.07);
        vec3 col = mix(mix(dayLow, dayHigh, pow(h, 0.8)),
                       mix(ngtLow, ngtHigh, pow(h, 0.8)), night);
        col = srgbToLinear(col);
        float sun = pow(max(dot(d, normalize(sunDir)), 0.0), 220.0);
        col += vec3(1.0, 0.92, 0.72) * sun * (1.0 - night * 0.85);
        gl_FragColor = vec4(tonemap(col * 1.35), 1.0);
      }
    `,
  });
}
