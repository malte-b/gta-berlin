import * as THREE from 'three';

/* Shared shader chunks ---------------------------------------------------- */

// Positions arrive as unsigned shorts quantised to the tile's bounding box, so
// every material expands them with the tile's qmin/qscale before projecting.
const DEQUANT = /* glsl */`
  uniform vec3 qmin;
  uniform vec3 qscale;
`;

// Flat normals are reconstructed from screen-space derivatives instead of being
// stored per vertex. LoD2 faces are flat, so this is exact, it costs nothing in
// the vertex buffer, and it avoids the smeared look of averaged normals.
const FLAT_NORMAL = /* glsl */`
  vec3 flatNormal(vec3 p) {
    vec3 n = normalize(cross(dFdx(p), dFdy(p)));
    return dot(n, normalize(cameraPosition - p)) < 0.0 ? -n : n;
  }
`;

const NOISE = /* glsl */`
  // Albedo below is written the way a designer reads it, i.e. in sRGB. three
  // re-encodes the framebuffer to sRGB on output, so it has to be linearised
  // first or every surface comes out milky and washed out.
  vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }

  // three only injects its tone mapping into its own materials, so raw
  // ShaderMaterials have to do it themselves or highlights clip flat.
  vec3 tonemap(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }
  float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453); }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }
`;

const FOG = /* glsl */`
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  uniform float exposure;
  vec3 applyFog(vec3 c, vec3 p) {
    float d = length(cameraPosition - p);
    return mix(c, fogColor, smoothstep(fogNear, fogFar, d));
  }
`;

/** Uniforms every tile material shares; each tile clones them for its own qmin. */
export function commonUniforms() {
  return {
    qmin:     { value: new THREE.Vector3() },
    qscale:   { value: new THREE.Vector3(1, 1, 1) },
    sunDir:   { value: new THREE.Vector3(0.42, 0.78, 0.46).normalize() },
    fogColor: { value: new THREE.Color(0x9fb0c4) },
    fogNear:  { value: 340 },
    fogFar:   { value: 1500 },
    night:    { value: 0 },
    exposure: { value: 1.35 },
    time:     { value: 0 },
  };
}

/* Buildings --------------------------------------------------------------- */

const BUILDING_VERT = /* glsl */`
  ${DEQUANT}
  attribute float akind;
  attribute float abheight;
  attribute float abbase;
  attribute float atint;
  varying vec3 vPos;
  varying float vKind, vBH, vBase, vTint;
  void main() {
    vec3 p = qmin + position * qscale;
    vPos = p;
    vKind = akind;
    vBH = abheight;
    vBase = abbase - 40.0;      // see BASE_OFFSET in the pipeline
    vTint = atint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const BUILDING_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vPos;
  varying float vKind, vBH, vBase, vTint;
  uniform vec3 sunDir;
  uniform float night;
  ${NOISE}
  ${FLAT_NORMAL}
  ${FOG}

  // Rendered facades in Berlin: sandstone, grey render, ochre, pale green, brick.
  vec3 facadeColour(float t) {
    vec3 c1 = vec3(0.82, 0.78, 0.70);
    vec3 c2 = vec3(0.68, 0.68, 0.66);
    vec3 c3 = vec3(0.79, 0.69, 0.53);
    vec3 c4 = vec3(0.63, 0.67, 0.61);
    vec3 c5 = vec3(0.60, 0.42, 0.36);
    if (t < 0.32) return mix(c1, c2, t / 0.32);
    if (t < 0.58) return mix(c2, c3, (t - 0.32) / 0.26);
    if (t < 0.82) return mix(c3, c4, (t - 0.58) / 0.24);
    return mix(c4, c5, (t - 0.82) / 0.18);
  }

  void main() {
    vec3 n = flatNormal(vPos);
    float t = vTint / 255.0;
    vec3 col;

    if (vKind < 0.5) {
      // ---- wall: procedural window grid keyed to the building's own base ----
      vec3 base = facadeColour(t);
      float floorH = 3.25;
      float fy = (vPos.y - vBase) / floorH;
      vec3 tang = normalize(cross(n, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
      float u = dot(vPos.xz, tang.xz) / 2.85;
      float wx = fract(u), wy = fract(fy);

      // Hard steps alias into heavy moire once a window is near pixel-sized,
      // which is most of the skyline. Widen the edges by the screen-space
      // derivative of the pattern, then fade the whole grid out when a cell no
      // longer covers a pixel, so distant facades settle to their average tone.
      float du = fwidth(u), dv = fwidth(fy);
      float bx = smoothstep(0.20 - du, 0.20 + du, wx)
               * (1.0 - smoothstep(0.80 - du, 0.80 + du, wx));
      float by = smoothstep(0.30 - dv, 0.30 + dv, wy)
               * (1.0 - smoothstep(0.86 - dv, 0.86 + dv, wy));
      float win = bx * by * 0.88;
      float ground = 1.0 - smoothstep(0.9, 1.0, fy);   // shopfronts at street level
      win = max(win, ground
        * smoothstep(0.07 - du, 0.07 + du, wx) * (1.0 - smoothstep(0.93 - du, 0.93 + du, wx))
        * smoothstep(0.14 - dv, 0.14 + dv, wy) * (1.0 - smoothstep(0.88 - dv, 0.88 + dv, wy)));
      win *= step(4.5, vBH);                    // sheds and garages stay blank
      // dissolve the grid well before it reaches pixel size; a busy checker
      // reads as noise across a skyline, not as windows
      win *= 1.0 - smoothstep(0.10, 0.34, max(du, dv));

      float lit = hash11(floor(u) * 13.0 + floor(fy) * 7.0 + vTint);
      vec3 glass = mix(vec3(0.22, 0.25, 0.30), vec3(0.38, 0.44, 0.50), lit * 0.7);
      glass += vec3(0.10, 0.12, 0.15) * max(n.y, 0.0);
      glass = mix(glass, vec3(1.00, 0.83, 0.52), night * step(0.58, lit));

      col = mix(base, glass, win);
      col *= 0.95 + 0.05 * vnoise(vPos.xz * 0.9 + vPos.y);
      col *= 1.0 - 0.07 * smoothstep(0.87, 0.99, wy) * (1.0 - win)
                 * (1.0 - smoothstep(0.20, 0.6, dv));               // floor bands
    } else if (vKind < 1.5) {
      // ---- roof ----
      float r = hash11(vTint * 3.7 + 1.3);
      col = mix(vec3(0.31, 0.30, 0.30), vec3(0.44, 0.27, 0.22), step(0.55, r));
      col = mix(col, vec3(0.25, 0.27, 0.29), step(0.86, r));
      col *= 0.90 + 0.18 * vnoise(vPos.xz * 1.7);
    } else {
      col = vec3(0.16, 0.15, 0.15);
    }

    col = srgbToLinear(col);

    // ---- lighting: hemisphere ambient + one sun, plus street-level darkening
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 sky = mix(vec3(0.62, 0.70, 0.86), vec3(0.030, 0.038, 0.070), night);
    vec3 sun = mix(vec3(1.15, 1.07, 0.92), vec3(0.05, 0.06, 0.11), night);
    float ao = 0.78 + 0.22 * clamp((vPos.y - vBase) / 16.0, 0.0, 1.0);

    vec3 lit = col * (sky * (0.55 + 0.30 * n.y) + sun * ndl) * ao;
    gl_FragColor = vec4(tonemap(applyFog(lit, vPos) * exposure), 1.0);
  }
`;

export function buildingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: commonUniforms(),
    vertexShader: BUILDING_VERT,
    fragmentShader: BUILDING_FRAG,
    side: THREE.FrontSide,
  });
}

/* Streets, water, parks --------------------------------------------------- */

const STREET_VERT = /* glsl */`
  ${DEQUANT}
  attribute float akind;
  varying vec3 vPos;
  varying float vKind;
  void main() {
    vec3 p = qmin + position * qscale;
    vPos = p;
    vKind = akind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const STREET_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vPos;
  varying float vKind;
  uniform vec3 sunDir;
  uniform float night;
  uniform float time;
  ${NOISE}
  ${FLAT_NORMAL}
  ${FOG}

  void main() {
    vec3 n = flatNormal(vPos);
    int k = int(vKind + 0.5);
    vec3 col;
    float spec = 0.0;

    if (k == 0) {                    // carriageway
      col = vec3(0.33, 0.33, 0.345);
      col *= 0.88 + 0.24 * vnoise(vPos.xz * 2.4);
    } else if (k == 1) {             // footway / cycleway
      col = vec3(0.55, 0.53, 0.50);
      col *= 0.90 + 0.20 * vnoise(vPos.xz * 3.6);
    } else if (k == 2) {             // water
      float w = vnoise(vPos.xz * 0.30 + vec2(time * 0.05, time * 0.03))
              + 0.5 * vnoise(vPos.xz * 0.9 - vec2(time * 0.08, 0.0));
      col = mix(vec3(0.13, 0.26, 0.36), vec3(0.20, 0.40, 0.50), w * 0.6);
      spec = 0.55;
    } else if (k == 3) {             // parks, forest, cemeteries
      float g = vnoise(vPos.xz * 0.55);
      col = mix(vec3(0.27, 0.40, 0.20), vec3(0.38, 0.52, 0.26), g);
      col *= 0.88 + 0.22 * vnoise(vPos.xz * 4.0);
    } else if (k == 5) {             // rail
      col = vec3(0.34, 0.30, 0.27);
      col *= 0.85 + 0.30 * vnoise(vPos.xz * 6.0);
    } else {                         // block interiors / everything else
      float g = vnoise(vPos.xz * 0.7);
      col = mix(vec3(0.29, 0.28, 0.27), vec3(0.34, 0.33, 0.31), g);
    }

    col = srgbToLinear(col);
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 sky = mix(vec3(0.64, 0.72, 0.88), vec3(0.030, 0.038, 0.070), night);
    vec3 sun = mix(vec3(1.12, 1.05, 0.92), vec3(0.05, 0.06, 0.11), night);
    vec3 lit = col * (sky * 0.72 + sun * ndl);

    if (spec > 0.0) {
      vec3 h = normalize(sunDir + normalize(cameraPosition - vPos));
      lit += sun * spec * pow(max(dot(n, h), 0.0), 48.0);
    }
    gl_FragColor = vec4(tonemap(applyFog(lit, vPos) * exposure), 1.0);
  }
`;

export function streetMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: commonUniforms(),
    vertexShader: STREET_VERT,
    fragmentShader: STREET_FRAG,
    side: THREE.DoubleSide,
  });
}

/* Sky --------------------------------------------------------------------- */

export function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
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

/* Photogrammetric mesh ----------------------------------------------------- */

const MESH_VERT = /* glsl */`
  ${DEQUANT}
  varying vec3 vPos;
  varying vec2 vUv;
  void main() {
    vec3 p = qmin + position * qscale;
    vPos = p;
    vUv = uv;                       // Uint16 attribute flagged normalized
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const MESH_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vPos;
  varying vec2 vUv;
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float night;
  ${NOISE}
  ${FLAT_NORMAL}
  ${FOG}

  void main() {
    // The aerial survey already baked sun, sky and shadows into the texture,
    // so relighting it properly would double up. Instead the photo is used
    // almost as-is and the reconstructed normal only adds a slight lift, just
    // enough to keep facades from reading as flat cardboard.
    vec3 base = srgbToLinear(texture2D(map, vUv).rgb);
    vec3 n = flatNormal(vPos);
    float ndl = max(dot(n, sunDir), 0.0);

    vec3 lit = base * (0.88 + 0.22 * ndl);

    if (night > 0.001) {
      // dusk: crush toward a cool ambient, keep a little of the photo's own
      // contrast so the streets stay readable
      vec3 dark = vec3(dot(base, vec3(0.299, 0.587, 0.114)));
      vec3 nightCol = mix(base, dark, 0.55) * vec3(0.13, 0.16, 0.26);
      lit = mix(lit, nightCol, night);
    }

    gl_FragColor = vec4(tonemap(applyFog(lit, vPos) * exposure), 1.0);
  }
`;

export function meshMaterial() {
  const u = commonUniforms();
  u.map = { value: null };
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: MESH_VERT,
    fragmentShader: MESH_FRAG,
    side: THREE.DoubleSide,   // photogrammetry has plenty of inconsistent winding
  });
}
