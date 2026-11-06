/** Geometry regressions: test the rendered triangles, not a copy of the height formula. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as typeof import('../web/src/bridges.ts');
  const THREE = await import('three');
  type Point = [number, number, number, number, number];
  const straight = new Decks({ decks: [{ k: 'road', t: 1.2, p: [[0, 0, 3, 2, 2], [10, 0, 3, 2, 2]] }] });
  const mesh = straight.mesh(0, 0);
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(5, 10, 0), new THREE.Vector3(0, -1, 0));
  assert.ok(Math.abs(ray.intersectObject(mesh)[0]?.point.y - 3) < 1e-5, 'the visible deck top must face up, at the collision height');
  ray.set(new THREE.Vector3(5, -10, 0), new THREE.Vector3(0, 1, 0));
  assert.ok(Math.abs(ray.intersectObject(mesh)[0]?.point.y - 1.8) < 1e-5, 'the underside must face down');
  ray.set(new THREE.Vector3(5, 2.4, 10), new THREE.Vector3(0, 0, -1));
  assert.ok(Math.abs(ray.intersectObject(mesh)[0]?.point.z - 2) < 1e-5, 'the side must face outward');

  // Sloping, asymmetric widths and a sharp bend exposed the old disc-shaped
  // collision patch: you could stand in mid-air outside the rendered surface.
  const points: Point[] = [[0, 0, 3, 2, 4], [8, 0, 3.4, 3, 4], [14, 6, 3.8, 3, 2], [14, 15, 4, 2, 2]];
  const bent = new Decks({ decks: [{ k: 'road', t: 1.2, p: points }] });
  const curvedMesh = bent.mesh(0, 0);
  curvedMesh.updateMatrixWorld(true);
  let samples = 0;
  for (let x = -1.87; x < 18; x += 0.43) {
    for (let z = -4.13; z < 17; z += 0.47) {
      ray.set(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
      const top = ray.intersectObject(curvedMesh).find((h) => h.face && h.face.normal.y > 0.5);
      const hit = bent.at(x, z)[0];
      assert.equal(Boolean(hit), Boolean(top), `visible and walkable footprints disagree at ${x}, ${z}`);
      if (hit && top) assert.ok(Math.abs(hit.y - top.point.y) < 1e-4, 'walk height must interpolate the same triangle as the renderer');
      samples++;
    }
  }
  assert.equal(straight.at(5, 1.8, 0.3).length, 0, 'walking clearance applies at the outer edge');
  assert.equal(straight.at(5, 0, 1).length, 1, 'cars fit in the carriageway');
  assert.equal(straight.at(0.05, 0, 1).length, 1, 'end landings stay open instead of gaining an invisible inset gap');
  // A concave, surveyed surface rather than a centreline strip. The empty
  // north-east corner must remain empty both visually and for collision.
  const polygon = new Decks({ decks: [{ k: 'road', t: 1, p: [[0, 2, 3, 2, 2], [8, 2, 3, 2, 2]],
    mesh: { v: [[0, 0, 3], [8, 0, 3], [8, 4, 3], [4, 4, 3], [4, 8, 3], [0, 8, 3]],
      i: [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4], r: [[0, 1, 2, 3, 4, 5]] } }] });
  const polygonMesh = polygon.mesh(0, 0);
  polygonMesh.updateMatrixWorld(true);
  for (const [x, z, inside] of [[2, 2, true], [6, 2, true], [2, 6, true], [6, 6, false]] as const) {
    ray.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
    assert.equal(Boolean(polygon.at(x, z).length), inside);
    assert.equal(Boolean(ray.intersectObject(polygonMesh).length), inside);
  }
  const half = (x0: number, x1: number) => new Decks({ decks: [{ k: 'road', t: 1,
    p: [[x0, 2, 3, 2, 2], [x1, 2, 3, 2, 2]], mesh: {
      v: [[x0, 0, 3], [x1, 0, 3], [x1, 4, 3], [x0, 4, 3]],
      i: [0, 2, 1, 0, 3, 2], r: [[0, 1, 2, 3]], clip: [x0, -10, x1, 10] } }] });
  assert.equal(half(0, 4).at(4, 2, 1)[0]?.y, half(4, 8).at(4, 2, 1)[0]?.y, 'tile cuts are neither steps nor collision borders');
  Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true });
  Object.defineProperty(globalThis, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
  const { World } = await vite.ssrLoadModule('/src/world.ts') as typeof import('../web/src/world.ts');
  const { Tile } = await vite.ssrLoadModule('/src/tile.ts') as typeof import('../web/src/tile.ts');
  const { Player } = await vite.ssrLoadModule('/src/player.ts') as typeof import('../web/src/player.ts');
  const world = new World(new THREE.Scene());
  const tile = new Tile('camera fixture', '', [-20, -5, -20, 20, 20, 20]);
  tile.level = 'full';
  tile.terrain = { height: () => -1 } as unknown as NonNullable<typeof tile.terrain>;
  tile.decks = straight;
  world.tiles.set(tile.key, tile);
  assert.equal(world.blocksCamera(5, 2.4, 0), true, 'a bridge slab blocks the camera');
  assert.equal(world.blocksCamera(5, 0.8, 0), false, 'the space below the slab stays open');
  const player = new Player(world);
  player.pos.set(5, -1, 0);
  player.pitch = -0.7;
  const camera = new THREE.PerspectiveCamera();
  player.applyCamera(camera);
  assert.ok(camera.position.y < 1.8, 'the camera boom must not tunnel through the bridge to an unobstructed endpoint above it');
  const short = camera.position.distanceTo(new THREE.Vector3(5, 0.72, 0));
  player.pitch = -0.05;
  const head = player.applyCamera(camera);
  assert.ok(camera.position.distanceTo(head) > short && camera.position.distanceTo(head) < 6.4, 'the camera eases out after clearing the obstruction');
  const structures = new Decks({ decks: [],
    piers: [{ r: [[0, 0], [2, 0], [2, 2], [0, 2]], y0: 0, y1: 4 }],
    roofs: [{ r: [[4, 0], [6, 0], [6, 2], [4, 2]], y: 4, t: 0.3 }] });
  assert.equal(structures.blocksCamera(1, 2, 1), true, 'piers have volume');
  assert.equal(structures.blocksCamera(1, 5, 1), false, 'a pier does not block the sky above it');
  assert.equal(structures.blocksCamera(5, 2, 1), false, 'the space beneath a canopy is open');
  assert.equal(structures.blocksCamera(5, 3.85, 1), true, 'the canopy roof blocks the camera');
  for (const m of [mesh, curvedMesh, polygonMesh]) {
    m.geometry.dispose();
    for (const material of Array.isArray(m.material) ? m.material : [m.material]) material.dispose();
  }
  console.log(`Bridge geometry: winding, camera clearance, tile cuts, concavity and ${samples} render/collision samples passed.`);
} finally {
  await vite.close();
}
