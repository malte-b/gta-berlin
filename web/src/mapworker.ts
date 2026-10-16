/*
 * Off the main thread, for tiles:
 *
 *  - "cover": the cover mask PNG decoded here, byte for byte, and scaled
 *    down. It is data - road, path, green, water in R, G, B, A - not a
 *    picture, and browsers treat pictures' alpha their own way: Firefox
 *    turned createImageBitmap's alpha to opaque, i.e. water everywhere, and
 *    any canvas premultiplies it, wiping the other channels where there is
 *    no water. The pipeline writes plain 8-bit PNGs (raster.write_png), so
 *    decoding them takes a DecompressionStream and the row filters.
 *  - "map": the minimap, 1 px = 1 m: ground cover, building footprints from
 *    the navigation grid, a hint of relief. A million pixels touched one by
 *    one - on a phone that was a visible hitch every time a tile came close.
 */

export interface CoverJob {
  kind: 'cover';
  png: Blob;
  /** Output pixels per input pixel: 1, 1/2, 1/8 ... */
  scale: number;
}

export interface MapJob {
  kind: 'map';
  png: Blob;
  coverMin: [number, number];
  coverRes: number;
  navMin: [number, number];
  navCell: number;
  nx: number;
  nz: number;
  terrain: Uint16Array;
  flags: Uint8Array;
  buildingFlag: number;
}

export interface Raster { data: Uint8Array<ArrayBuffer>; w: number; h: number; channels: number }

/** An 8-bit grey or RGBA PNG as raw bytes, exactly as stored. */
async function decodePng(blob: Blob): Promise<Raster> {
  const b = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(b.buffer);
  let w = 0, h = 0, channels = 4;
  const idat: Uint8Array<ArrayBuffer>[] = [];
  for (let p = 8; p < b.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8);
      h = dv.getUint32(p + 12);
      const depth = b[p + 16], ctype = b[p + 17], interlace = b[p + 20];
      if (depth !== 8 || interlace !== 0 || (ctype !== 6 && ctype !== 0 && ctype !== 2)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${ctype}, interlace ${interlace}`);
      }
      channels = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
    } else if (type === 'IDAT') {
      idat.push(b.subarray(p + 8, p + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  // undo the per-row filters
  const stride = w * channels;
  const out = new Uint8Array(stride * h);
  for (let r = 0; r < h; r++) {
    const f = raw[r * (stride + 1)];
    const src = r * (stride + 1) + 1, dst = r * stride, up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const u = r > 0 ? out[up + i] : 0;
      const c = r > 0 && i >= channels ? out[up + i - channels] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + u; break;
        case 3: v = x + ((a + u) >> 1); break;
        default: {
          const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c);
        }
      }
      out[dst + i] = v & 255;
    }
  }
  return { data: out, w, h, channels };
}

/** Box-filtered down by an integer factor, as RGBA. */
function shrink(src: Raster, factor: number): Raster {
  const w = Math.max(1, Math.floor(src.w / factor)), h = Math.max(1, Math.floor(src.h / factor));
  const out = new Uint8Array(w * h * 4);
  const n = factor * factor, ch = src.channels;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        let k = ((y * factor + dy) * src.w + x * factor) * ch;
        for (let dx = 0; dx < factor; dx++, k += ch) {
          for (let c = 0; c < 4; c++) sum[c] += c < ch ? src.data[k + c] : 255;
        }
      }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sum[c] / n);
    }
  }
  return { data: out, w, h, channels: 4 };
}

async function cover(job: CoverJob): Promise<Raster> {
  const png = await decodePng(job.png);
  const factor = Math.max(1, Math.round(1 / job.scale));
  return shrink(png, factor);       // factor 1: a straight copy to RGBA
}

async function map(j: MapJob): Promise<ImageBitmap> {
  const { nx, nz } = j;
  const cv = await decodePng(j.png);
  const ch = cv.channels;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < j.terrain.length; k += 13) {
    lo = Math.min(lo, j.terrain[k]);
    hi = Math.max(hi, j.terrain[k]);
  }
  const out = new ImageData(nx, nz);
  const d = out.data;
  for (let r = 0; r < nz; r++) {
    // the cover pixel under this metre's centre; the mask may reach past the tile
    const cz = Math.floor((j.navMin[1] + (r + 0.5) * j.navCell - j.coverMin[1]) / j.coverRes);
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c, o = k * 4;
      const cx = Math.floor((j.navMin[0] + (c + 0.5) * j.navCell - j.coverMin[0]) / j.coverRes);
      const inside = cx >= 0 && cz >= 0 && cx < cv.w && cz < cv.h;
      const q = (cz * cv.w + cx) * ch;
      const at = (i: number) => (inside && i < ch ? cv.data[q + i] : 0);
      const rel = (j.terrain[k] - lo) / Math.max(1, hi - lo);
      let R = 44 + rel * 30, G = 46 + rel * 30, B = 50 + rel * 30;
      if (at(2) > 110) { R = 46; G = 74; B = 44; }
      if (at(1) > 110) { R = 92; G = 90; B = 84; }
      if (at(0) > 110) { R = 104; G = 106; B = 112; }
      if (at(3) > 110) { R = 40; G = 78; B = 112; }
      if (j.flags[k] & j.buildingFlag) { R = 205; G = 196; B = 178; }
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 238;
    }
  }
  return createImageBitmap(out);
}

self.onmessage = async (e: MessageEvent<CoverJob | MapJob>) => {
  const post = (self as unknown as Worker).postMessage.bind(self);
  try {
    if (e.data.kind === 'cover') {
      const r = await cover(e.data);
      post({ ok: r }, [r.data.buffer]);
    } else {
      const bmp = await map(e.data);
      post({ ok: bmp }, [bmp]);
    }
  } catch (err) {
    post({ error: String(err) });
  }
};
