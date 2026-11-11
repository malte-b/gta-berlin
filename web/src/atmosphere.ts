import * as THREE from 'three';

/*
 * The air: haze and sky as one thing.
 *
 * three's fog blends every surface towards a single colour by depth, after
 * tone mapping. Against a gradient sky that leaves a seam at the horizon -
 * distant blocks fade to a grey that is not the blue behind them - and it
 * keeps the whole skyline equally buried. Here the fog chunks are replaced
 * for every material at once:
 *
 *  - the haze takes the colour of the sky along the same line of sight, so a
 *    fogged roof dissolves into exactly the sky behind it, warmer towards the
 *    sun;
 *  - it thins with height above the eye, so towers and the Fernsehturm stand
 *    out of the haze that fills the streets - but never at the far edge,
 *    which hides where the loaded city ends;
 *  - it is blended in linear light, before tone mapping, like the light it
 *    stands for, and so comes out the same drawn to the screen or into a
 *    render target.
 *
 * The sky (materials.ts skyMaterial) and the water's reflection call the same
 * atmoSky(), so all three agree on what the sky looks like.
 */

/** Where the sun stands: the light, the sky's disc and the haze's glow. */
export const SUN_DIR = new THREE.Vector3(0.42, 0.72, 0.46).normalize();

/** The haze at street level, in linear light. Through ACES they show as
 *  0x9fb2c6 and 0x0d1119 (at night exposure), the colours the fog had when
 *  it was blended in after tone mapping. */
export const FOG_DAY = new THREE.Color().setRGB(0.261, 0.366, 0.526);
export const FOG_NIGHT = new THREE.Color().setRGB(0.018, 0.023, 0.033);

const vec3 = (v: THREE.Vector3) => `vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

/**
 * GLSL: atmoSky(dir, fog) is the sky seen along a world direction, from the
 * fog colour at the horizon (and below it) up to the zenith; atmoDay(fog) is
 * how much daylight there is, read off the fog's brightness, so nothing else
 * has to be passed for night.
 */
export const SKY_GLSL = /* glsl */`
  const vec3 SUN_DIR = ${vec3(SUN_DIR)};
  float atmoDay(vec3 fog) {
    return smoothstep(0.03, 0.25, dot(fog, vec3(0.2126, 0.7152, 0.0722)));
  }
  vec3 atmoSky(vec3 dir, vec3 fog) {
    float day = atmoDay(fog);
    float h = max(dir.y, 0.0);
    // the old sky's zenith blues, matched through ACES like the fog
    vec3 zenith = mix(vec3(0.0026, 0.0027, 0.0032), vec3(0.032, 0.126, 0.43), day);
    vec3 col = mix(fog, zenith, pow(h, 0.5));
    float s = max(dot(dir, SUN_DIR), 0.0);
    return mix(col, fog * vec3(1.45, 1.18, 0.82), day * 0.55 * pow(s, 6.0) * (1.0 - 0.6 * h));
  }
`;

let installed = false;

/** Swap three's fog for this one. Call before anything is drawn: shader
 *  chunks are read when a program is compiled. */
export function installAtmosphere(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as Record<string, string>;
  C.fog_pars_vertex = /* glsl */`
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogRay;
    #endif
  `;
  // the eye-to-surface ray in world axes: transposed, the view rotation inverts
  C.fog_vertex = /* glsl */`
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
    #endif
  `;
  C.fog_pars_fragment = /* glsl */`
    ${SKY_GLSL}
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogRay;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
      // three hands the fog colour over in the output's colour space: sRGB
      // on screen, linear into a render target
      vec3 fogLinear() {
        if ( linearToOutputTexel( vec4( 0.25 ) ).r < 0.3 ) return fogColor;
        return mix( pow( fogColor * 0.9478673 + 0.0521327, vec3( 2.4 ) ), fogColor * 0.0773994,
                    vec3( lessThanEqual( fogColor, vec3( 0.04045 ) ) ) );
      }
    #endif
  `;
  // applied in the tone mapping chunk instead, which every material that
  // takes fog includes just before it
  C.fog_fragment = '';
  C.tonemapping_fragment = /* glsl */`
    #ifdef USE_FOG
    {
      float fogDist = length( vFogRay );
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp( - fogDensity * fogDensity * fogDist * fogDist );
      #else
        float fogF = smoothstep( fogNear, fogFar, fogDist );
        // thinner above the eye, but whole again at the far edge
        fogF = max( fogF * mix( 0.5, 1.0, exp( - max( vFogRay.y, 0.0 ) / 110.0 ) ),
                    smoothstep( mix( fogNear, fogFar, 0.8 ), fogFar, fogDist ) );
      #endif
      gl_FragColor.rgb = mix( gl_FragColor.rgb, atmoSky( vFogRay / max( fogDist, 1e-4 ), fogLinear() ), fogF );
    }
    #endif
  ` + C.tonemapping_fragment;
}
