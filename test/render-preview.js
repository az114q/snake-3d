/* CPU 光栅化预览：使用与 WebGL 着色器相同的公式，输出 PNG 供人工检查构图与配色 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { boot } = require('./harness');

const FOG = [0.016, 0.027, 0.055];
let TARGET = [0, 0, 0];
const KEY = norm([0.42, 1.0, 0.36]);
const FILL = norm([-0.55, 0.42, -0.62]);

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function shade(wp, nRaw, base, emit, cam, fogNear, fogFar) {
  const n = norm(nRaw);
  const key = Math.max(dot(n, KEY), 0);
  const fill = Math.max(dot(n, FILL), 0);
  let col = [0, 0, 0];
  const amt = 0.26 + 0.62 * key + 0.18 * fill;
  for (let i = 0; i < 3; i++) col[i] = base[i] * amt;

  const v = norm([cam[0] - wp[0], cam[1] - wp[1], cam[2] - wp[2]]);
  const rim = Math.pow(1 - clamp(dot(n, v), 0, 1), 2.6);
  for (let i = 0; i < 3; i++) {
    col[i] += base[i] * rim * 0.42;
    col[i] += base[i] * clamp(emit, 0, 1) * 0.75;
  }

  const dist = Math.hypot(cam[0] - wp[0], cam[1] - wp[1], cam[2] - wp[2]);
  const fog = smoothstep(fogNear, fogFar, dist);
  for (let i = 0; i < 3; i++) col[i] = mix(col[i], FOG[i], fog);
  return col;
}

function mulPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15]
  ];
}

function rasterize(calls, W, H) {
  const buf = new Float32Array(W * H * 3);
  const zBuf = new Float32Array(W * H).fill(Infinity);
  for (let i = 0; i < W * H; i++) {
    buf[i * 3] = FOG[0]; buf[i * 3 + 1] = FOG[1]; buf[i * 3 + 2] = FOG[2];
  }

  let tris = 0;
  for (const call of calls) {
    if (!call.pos || !call.nrm || !call.col) continue;
    const { pos, nrm, col, model, view, proj, color, alpha, emit } = call;
    const mvp = mul4(proj, view, model);
    const vp = mul4(proj, view, IDENT);
    const cam = call.camPos;
    const camDist = Math.hypot(cam[0] - TARGET[0], cam[1] - TARGET[1], cam[2] - TARGET[2]);
    const fogNear = camDist * 1.10, fogFar = camDist * 2.35;
    const nVerts = Math.min(call.count, pos.length / 3);

    for (let t = 0; t < nVerts; t += 3) {
      const verts = [];
      let skip = false;
      for (let k = 0; k < 3; k++) {
        const idx = t + k;
        const wx = pos[idx * 3], wy = pos[idx * 3 + 1], wz = pos[idx * 3 + 2];
        const world = mulPoint(model, wx, wy, wz);
        const clip = mulPoint(mvp, wx, wy, wz);
        if (clip[3] <= 0.06) { skip = true; break; }
        const ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
        verts.push({
          world,
          sx: (ndc[0] * 0.5 + 0.5) * W,
          sy: (1 - (ndc[1] * 0.5 + 0.5)) * H,
          z: ndc[2],
          w: clip[3],
          n: [nrm[idx * 3], nrm[idx * 3 + 1], nrm[idx * 3 + 2]],
          c: [col[idx * 3] * color[0], col[idx * 3 + 1] * color[1], col[idx * 3 + 2] * color[2]]
        });
      }
      if (skip) continue;
      tris++;

      const area = (verts[1].sx - verts[0].sx) * (verts[2].sy - verts[0].sy) -
                   (verts[2].sx - verts[0].sx) * (verts[1].sy - verts[0].sy);
      if (Math.abs(area) < 1e-7) continue;

      const minX = Math.max(0, Math.floor(Math.min(verts[0].sx, verts[1].sx, verts[2].sx)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(verts[0].sx, verts[1].sx, verts[2].sx)));
      const minY = Math.max(0, Math.floor(Math.min(verts[0].sy, verts[1].sy, verts[2].sy)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(verts[0].sy, verts[1].sy, verts[2].sy)));
      const invArea = 1 / area;
      const transparent = alpha < 0.999;

      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const w0 = ((verts[1].sx - cx) * (verts[2].sy - cy) - (verts[2].sx - cx) * (verts[1].sy - cy)) * invArea;
          const w1 = ((verts[2].sx - cx) * (verts[0].sy - cy) - (verts[0].sx - cx) * (verts[2].sy - cy)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;

          const z = w0 * verts[0].z + w1 * verts[1].z + w2 * verts[2].z;
          const di = py * W + px;
          if (!transparent && z >= zBuf[di]) continue;

          const iw0 = w0 / verts[0].w, iw1 = w1 / verts[1].w, iw2 = w2 / verts[2].w;
          const iwSum = iw0 + iw1 + iw2 || 1;
          const wp = [
            (iw0 * verts[0].world[0] + iw1 * verts[1].world[0] + iw2 * verts[2].world[0]) / iwSum,
            (iw0 * verts[0].world[1] + iw1 * verts[1].world[1] + iw2 * verts[2].world[1]) / iwSum,
            (iw0 * verts[0].world[2] + iw1 * verts[1].world[2] + iw2 * verts[2].world[2]) / iwSum
          ];
          const nn = [
            (iw0 * verts[0].n[0] + iw1 * verts[1].n[0] + iw2 * verts[2].n[0]) / iwSum,
            (iw0 * verts[0].n[1] + iw1 * verts[1].n[1] + iw2 * verts[2].n[1]) / iwSum,
            (iw0 * verts[0].n[2] + iw1 * verts[1].n[2] + iw2 * verts[2].n[2]) / iwSum
          ];
          const base = [
            (iw0 * verts[0].c[0] + iw1 * verts[1].c[0] + iw2 * verts[2].c[0]) / iwSum,
            (iw0 * verts[0].c[1] + iw1 * verts[1].c[1] + iw2 * verts[2].c[1]) / iwSum,
            (iw0 * verts[0].c[2] + iw1 * verts[1].c[2] + iw2 * verts[2].c[2]) / iwSum
          ];

          const outc = shade(wp, nn, base, emit, cam, fogNear, fogFar);
          if (transparent) {
            for (let i = 0; i < 3; i++) buf[di * 3 + i] = mix(buf[di * 3 + i], outc[i], alpha);
          } else {
            zBuf[di] = z;
            buf[di * 3] = outc[0]; buf[di * 3 + 1] = outc[1]; buf[di * 3 + 2] = outc[2];
          }
        }
      }
    }
  }
  return { buf, tris };
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function mul4(a, b, c) {
  return mulRaw(mulRaw(a, b), c);
}
function mulRaw(a, b) {
  const o = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      o[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return o;
}

/* ---- PNG ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function writePNG(file, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const v = rgb[(y * W + x) * 3 + c];
        raw[y * (W * 3 + 1) + 1 + x * 3 + c] = Math.round(clamp(Math.pow(Math.max(v, 0), 1 / 2.2), 0, 1) * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

function shot(name, w, h) {
  const hh = boot({ width: w, height: h, record: true });
  const api = hh.api;
  api.startGame();
  api.state.cells = [
    { x: 11, z: 8 }, { x: 10, z: 8 }, { x: 9, z: 8 }, { x: 9, z: 7 },
    { x: 9, z: 6 }, { x: 8, z: 6 }, { x: 7, z: 6 }, { x: 7, z: 7 },
    { x: 7, z: 8 }, { x: 7, z: 9 }
  ];
  api.state.dir = { x: 1, z: 0 };
  api.state.t = 1;
  api.state.food = { x: 13, z: 5, golden: false, born: 0, spin: 1.1 };
  api.state.screen = 'playing';
  api.cam.mode = 0;
  const d = api.desiredCamera();
  api.cam.pos = d.pos.slice();
  api.cam.target = d.target.slice();
  TARGET = d.target.slice();
  hh.rec.length = 0;
  api.render();

  const { buf, tris } = rasterize(hh.rec, w, h);
  const out = path.join(__dirname, '../preview', name + '.png');
  writePNG(out, w, h, buf);
  console.log(`${name}: ${hh.rec.length} draw calls, ${tris} triangles -> ${out}`);
}

shot('landscape', 1280, 720);
shot('portrait', 390, 844);
