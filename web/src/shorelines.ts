import * as THREE from 'three';
import { Decks } from './bridges';
import { bridgeMaterial } from './materials';
import { freeOnUpload } from './memory';

interface MeshData { v: [number, number, number][]; i: number[] }
export interface ShoreData {
  step: number;
  cols: number;
  cells: number[];
  top: MeshData & { r: number[][] };
  walls: MeshData;
}

/** The mapped river edge and its replacement ground triangles. */
export class Shorelines {
  private readonly cells: Set<number>;
  private readonly field: Decks;

  constructor(private readonly data: ShoreData) {
    this.cells = new Set(data.cells);
    this.field = new Decks({ decks: [{ k: 'road', t: 0, mesh: data.top,
      p: [[0, 0, 0, 1, 1], [1, 0, 0, 1, 1]] }] });
  }

  /** Cells use the same 4 m alignment as the coarse terrain mesh. */
  replaces(col: number, row: number): boolean {
    return this.cells.has(Math.floor(row / this.data.step) * this.data.cols + Math.floor(col / this.data.step));
  }

  height(x: number, z: number): number | null {
    return this.field.at(x, z)[0]?.y ?? null;
  }

  meshes(ox: number, oz: number, ground: THREE.Material): THREE.Group {
    const group = new THREE.Group();
    group.name = 'shorelines';
    const geometry = (data: MeshData) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(data.v.flatMap(([x, z, y]) => [x - ox, y, z - oz]), 3));
      g.setIndex(data.i);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    };
    const land = new THREE.Mesh(geometry(this.data.top), ground);
    land.name = 'bank tops';
    land.receiveShadow = true;
    freeOnUpload(land.geometry);
    group.add(land);
    if (this.data.walls.i.length) {
      const g = geometry(this.data.walls);
      const n = this.data.walls.v.length;
      const color = new THREE.Color(0x827b68);
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, (_, i) => {
        const damp = i % 4 === 1 || i % 4 === 2 ? 0.68 : 1;
        return [color.r * damp, color.g * damp, color.b * damp];
      }).flat(), 3));
      g.setAttribute('surfaceType', new THREE.Float32BufferAttribute(new Float32Array(n).fill(5), 1));
      g.setAttribute('photoMix', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      const walls = new THREE.Mesh(g, bridgeMaterial());
      walls.name = 'quays';
      walls.castShadow = walls.receiveShadow = true;
      freeOnUpload(g);
      group.add(walls);
    }
    return group;
  }
}
