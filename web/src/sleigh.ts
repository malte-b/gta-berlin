import * as THREE from 'three';
import { makeHuman, poseDrive } from './character';

/**
 * Santa's sleigh for the Christmas market run: a sledge on curled runners,
 * Santa (the usual jointed figure in red, with a beard and a hat) and two
 * pairs of reindeer in front, the leader with a red nose. Primitives only,
 * like the other characters, and modelled facing +Z.
 */

function mat(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive });
}

function box(w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
}

function reindeer(nose: boolean): THREE.Group {
  const fur = mat(0x7a4f2c);
  const pale = mat(0xd9c3a0);
  const g = new THREE.Group();
  const body = box(0.5, 0.55, 1.25, fur);
  body.position.y = 1.05;
  g.add(body);
  const neck = box(0.26, 0.6, 0.28, fur);
  neck.position.set(0, 1.45, 0.62);
  neck.rotation.x = 0.5;
  g.add(neck);
  const head = box(0.28, 0.28, 0.5, fur);
  head.position.set(0, 1.78, 0.86);
  g.add(head);
  const snout = box(0.2, 0.18, 0.18, pale);
  snout.position.set(0, 1.72, 1.15);
  g.add(snout);
  if (nose) {
    const red = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mat(0xff2020, 0xff2020));
    red.position.set(0, 1.74, 1.26);
    g.add(red);
  }
  const antlerMat = mat(0xe8dcc0);
  for (const s of [-1, 1]) {
    const a = box(0.05, 0.42, 0.05, antlerMat);
    a.position.set(0.12 * s, 2.05, 0.8);
    a.rotation.z = -0.4 * s;
    const b = box(0.05, 0.22, 0.05, antlerMat);
    b.position.set(0.24 * s, 2.15, 0.9);
    b.rotation.x = 0.7;
    g.add(a, b);
  }
  const tail = box(0.14, 0.14, 0.1, pale);
  tail.position.set(0, 1.2, -0.66);
  g.add(tail);
  // legs pivot at the hip so they can gallop
  const legs: THREE.Group[] = [];
  for (const [lx, lz] of [[-0.18, 0.48], [0.18, 0.48], [-0.18, -0.48], [0.18, -0.48]]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx, 0.85, lz);
    const leg = box(0.11, 0.8, 0.11, fur);
    leg.position.y = -0.4;
    pivot.add(leg);
    g.add(pivot);
    legs.push(pivot);
  }
  g.userData.legs = legs;
  return g;
}

export function makeSleigh(): THREE.Group {
  const root = new THREE.Group();
  const red = mat(0xb3121f);
  const gold = mat(0xe8b23a, 0x3a2600);

  // the sledge: a tub with a high back
  const tub = box(1.5, 0.7, 2.4, red);
  tub.position.y = 0.95;
  const back = box(1.5, 0.9, 0.25, red);
  back.position.set(0, 1.5, -1.1);
  const trim = box(1.56, 0.08, 2.46, gold);
  trim.position.y = 1.32;
  root.add(tub, back, trim);
  // a sack of presents in the back
  const sack = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), mat(0x6b4a2b));
  sack.scale.set(1, 1.15, 0.9);
  sack.position.set(0.25, 1.65, -0.65);
  root.add(sack);
  for (const [px, pz, c] of [[-0.45, -0.55, 0x2f8f4e], [-0.4, 0.05, 0x2a62c9]] as const) {
    const p = box(0.36, 0.36, 0.36, mat(c));
    p.position.set(px, 1.45, pz);
    p.rotation.y = 0.4;
    root.add(p);
  }
  // runners, curled up at the front
  for (const s of [-1, 1]) {
    const run = box(0.08, 0.08, 3.0, gold);
    run.position.set(0.62 * s, 0.32, 0.1);
    const curl = box(0.08, 0.6, 0.08, gold);
    curl.position.set(0.62 * s, 0.58, 1.6);
    curl.rotation.x = -0.5;
    root.add(run, curl);
    for (const z of [-0.8, 0.8]) {
      const strut = box(0.06, 0.45, 0.06, gold);
      strut.position.set(0.62 * s, 0.55, z);
      root.add(strut);
    }
  }

  const santa = makeHuman({ top: 0xc8102e, legs: 0xc8102e, hair: 0xf2f2f2 });
  poseDrive(santa);
  santa.position.set(0, 0.55, -0.15);
  const head = (santa.userData.rig as { head: THREE.Group }).head;
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), mat(0xf6f6f6));
  beard.scale.set(1, 1.2, 0.7);
  beard.position.set(0, 0.05, 0.1);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 12), red);
  hat.position.set(0, 0.42, -0.03);
  hat.rotation.x = -0.35;
  const bobble = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), mat(0xffffff));
  bobble.position.set(0, 0.58, -0.1);
  head.add(beard, hat, bobble);
  root.add(santa);

  // two pairs of reindeer on a harness pole, the leader with Rudolph's nose
  const team: THREE.Group[] = [];
  for (const [i, z] of [3.3, 5.3].entries()) {
    for (const s of [-1, 1]) {
      const r = reindeer(i === 1 && s === 1);
      r.position.set(0.55 * s, 0, z);
      root.add(r);
      team.push(r);
    }
  }
  const pole = box(0.06, 0.06, 4.6, gold);
  pole.position.set(0, 1.0, 3.4);
  root.add(pole);
  // a lantern on the front so the sleigh reads at night - glowing, not a
  // light: a new light would recompile every material in the city
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8),
                              new THREE.MeshBasicMaterial({ color: 0xffd28a }));
  lamp.position.set(0, 2.0, 1.45);
  const post = box(0.05, 0.7, 0.05, gold);
  post.position.set(0, 1.7, 1.45);
  root.add(lamp, post);
  root.userData.team = team;
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return root;
}

/** Gallop the reindeer; t in seconds. */
export function poseSleigh(sleigh: THREE.Object3D, t: number): void {
  const team = sleigh.userData.team as THREE.Group[];
  team.forEach((r, i) => {
    const ph = t * 9 + i * 0.7;
    const legs = r.userData.legs as THREE.Group[];
    legs[0].rotation.x = Math.sin(ph) * 0.7;
    legs[1].rotation.x = Math.sin(ph + 0.4) * 0.7;
    legs[2].rotation.x = Math.sin(ph + Math.PI) * 0.7;
    legs[3].rotation.x = Math.sin(ph + Math.PI + 0.4) * 0.7;
    r.position.y = Math.abs(Math.sin(ph)) * 0.25;
  });
}
