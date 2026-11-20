/* =====================================================================
   NEON SNAKE 3D — 一个零依赖的 WebGL 小引擎 + 贪吃蛇玩法
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     0. 基础工具
     ------------------------------------------------------------------ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const $ = (id) => document.getElementById(id);

  const N = 17;                       // 棋盘边长（格）
  const CELL = 1;                     // 每格世界尺寸
  const HALF = (N - 1) / 2;           // 中心偏移
  const FOG = [0.016, 0.027, 0.055];  // 雾色 / 背景色
  const UP = [0, 1, 0];

  const cellX = (x) => (x - HALF) * CELL;
  const cellZ = (z) => (z - HALF) * CELL;

  /* ------------------------------------------------------------------
     1. 矩阵运算（列主序，与 WebGL 一致）
     ------------------------------------------------------------------ */
  function matMul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function lookAt(eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1
    ]);
  }

  // T * Rx * Ry * Rz * S（等比缩放）
  function modelMat(px, py, pz, rx, ry, rz, s) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    const m00 = cy * cz, m01 = -cy * sz, m02 = sy;
    const m10 = cx * sz + sx * sy * cz, m11 = cx * cz - sx * sy * sz, m12 = -sx * cy;
    const m20 = sx * sz - cx * sy * cz, m21 = sx * cz + cx * sy * sz, m22 = cx * cy;

    return new Float32Array([
      m00 * s, m10 * s, m20 * s, 0,
      m01 * s, m11 * s, m21 * s, 0,
      m02 * s, m12 * s, m22 * s, 0,
      px, py, pz, 1
    ]);
  }

  function normalMatOf(m) {
    const out = new Float32Array(9);
    for (let c = 0; c < 3; c++) {
      const x = m[c * 4], y = m[c * 4 + 1], z = m[c * 4 + 2];
      const l = Math.hypot(x, y, z) || 1;
      out[c * 3] = x / l;
      out[c * 3 + 1] = y / l;
      out[c * 3 + 2] = z / l;
    }
    return out;
  }

  /* ------------------------------------------------------------------
     2. WebGL 初始化
     ------------------------------------------------------------------ */
  const canvas = $('gl');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' }) ||
             canvas.getContext('experimental-webgl', { antialias: true, alpha: false });

  if (!gl) {
    document.body.innerHTML = '<div class="fatal">当前浏览器不支持 WebGL，无法运行 3D 场景</div>';
    return;
  }

  const VERT = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec3 aColor;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform mat4 uModel;',
    'uniform mat3 uNormalMat;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'void main() {',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  vWorld = wp.xyz;',
    '  vNormal = uNormalMat * aNormal;',
    '  vColor = aColor;',
    '  gl_Position = uProj * uView * wp;',
    '}'
  ].join('\n');

  const FRAG = [
    'precision mediump float;',
    'uniform vec3 uColor;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uFogColor;',
    'uniform float uAlpha;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'uniform float uEmit;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  vec3 base = vColor * uColor;',
    '  vec3 keyDir = normalize(vec3(0.42, 1.0, 0.36));',
    '  vec3 fillDir = normalize(vec3(-0.55, 0.42, -0.62));',
    '  float key = max(dot(n, keyDir), 0.0);',
    '  float fill = max(dot(n, fillDir), 0.0);',
    '  vec3 col = base * (0.26 + 0.62 * key + 0.18 * fill);',
    '  vec3 viewDir = normalize(uCamPos - vWorld);',
    '  float rim = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 2.6);',
    '  col += base * rim * 0.42;',
    '  col += base * clamp(uEmit, 0.0, 1.0) * 0.75;',
    '  float dist = length(uCamPos - vWorld);',
    '  float fog = smoothstep(uFogNear, uFogFar, dist);',
    '  col = mix(col, uFogColor, fog);',
    '  gl_FragColor = vec4(col, uAlpha);',
    '}'
  ].join('\n');

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const A = {
    pos: gl.getAttribLocation(prog, 'aPos'),
    normal: gl.getAttribLocation(prog, 'aNormal'),
    color: gl.getAttribLocation(prog, 'aColor')
  };
  const U = {};
  ['uProj', 'uView', 'uModel', 'uNormalMat', 'uColor', 'uCamPos', 'uFogColor', 'uAlpha', 'uEmit', 'uFogNear', 'uFogFar'].forEach((k) => {
    U[k] = gl.getUniformLocation(prog, k);
  });

  gl.enableVertexAttribArray(A.pos);
  gl.enableVertexAttribArray(A.normal);
  gl.enableVertexAttribArray(A.color);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
  gl.uniform3fv(U.uFogColor, FOG);

  function buffer(data) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return b;
  }

  function meshFrom(pos, nrm, col) {
    return { p: buffer(pos), n: buffer(nrm), c: buffer(col), count: pos.length / 3 };
  }

  function bindMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.p);
    gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.n);
    gl.vertexAttribPointer(A.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.c);
    gl.vertexAttribPointer(A.color, 3, gl.FLOAT, false, 0, 0);
  }

  const WHITE = [1, 1, 1];

  function drawMesh(mesh, model, color, alpha, emit) {
    bindMesh(mesh);
    gl.uniformMatrix4fv(U.uModel, false, model);
    gl.uniformMatrix3fv(U.uNormalMat, false, normalMatOf(model));
    gl.uniform3fv(U.uColor, color);
    gl.uniform1f(U.uAlpha, alpha === undefined ? 1 : alpha);
    gl.uniform1f(U.uEmit, emit || 0);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  /* ------------------------------------------------------------------
     3. 几何体
     ------------------------------------------------------------------ */
  function pushTri(pos, nrm, col, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, r, g, b) {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { nrm.push(nx, ny, nz); col.push(r, g, b); }
  }

  const CUBE_FACES = [
    { n: [1, 0, 0], c: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
    { n: [-1, 0, 0], c: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
    { n: [0, 1, 0], c: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], c: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
    { n: [0, 0, 1], c: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], c: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] }
  ];

  // 向静态几何体追加一个盒子
  function addBox(pos, nrm, col, cx, cy, cz, sx, sy, sz, color) {
    const [r, g, b] = color;
    for (let f = 0; f < 6; f++) {
      const face = CUBE_FACES[f];
      const v = face.c.map((p) => [
        cx + p[0] * sx,
        cy + p[1] * sy,
        cz + p[2] * sz
      ]);
      const n = face.n;
      pushTri(pos, nrm, col,
        v[0][0], v[0][1], v[0][2],
        v[1][0], v[1][1], v[1][2],
        v[2][0], v[2][1], v[2][2],
        n[0], n[1], n[2], r, g, b);
      pushTri(pos, nrm, col,
        v[0][0], v[0][1], v[0][2],
        v[2][0], v[2][1], v[2][2],
        v[3][0], v[3][1], v[3][2],
        n[0], n[1], n[2], r, g, b);
    }
  }

  function makeUnitCube(color) {
    const pos = [], nrm = [], col = [];
    addBox(pos, nrm, col, 0, 0, 0, 1, 1, 1, color || [1, 1, 1]);
    return meshFrom(pos, nrm, col);
  }

  function makeSphere(seg, rings, color) {
    const pos = [], nrm = [], col = [];
    const c = color || [1, 1, 1];
    const vert = (i, j) => {
      const theta = (i / rings) * Math.PI;
      const phi = (j / seg) * Math.PI * 2;
      return [
        0.5 * Math.sin(theta) * Math.cos(phi),
        0.5 * Math.cos(theta),
        0.5 * Math.sin(theta) * Math.sin(phi)
      ];
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = vert(i, j), b = vert(i + 1, j), cc = vert(i + 1, j + 1), d = vert(i, j + 1);
        const quad = [a, b, cc, a, cc, d];
        for (let k = 0; k < 6; k++) {
          const p = quad[k];
          const l = Math.hypot(p[0], p[1], p[2]) || 1;
          pos.push(p[0], p[1], p[2]);
          nrm.push(p[0] / l, p[1] / l, p[2] / l);
          col.push(c[0], c[1], c[2]);
        }
      }
    }
    return meshFrom(pos, nrm, col);
  }

  const CUBE = makeUnitCube([1, 1, 1]);
  const SPHERE = makeSphere(22, 14, [1, 1, 1]);

  /* ------------------------------------------------------------------
     4. 静态场景：棋盘、底座、霓虹围栏
     ------------------------------------------------------------------ */
  function buildBoard() {
    const pos = [], nrm = [], col = [];

    // 悬浮底座
    addBox(pos, nrm, col, 0, -0.30, 0, N + 1.9, 0.34, N + 1.9, [0.028, 0.040, 0.070]);
    addBox(pos, nrm, col, 0, -0.52, 0, N + 1.1, 0.14, N + 1.1, [0.020, 0.030, 0.052]);

    // 霓虹底边条
    const edge = [0.16, 0.86, 0.72];
    const eOff = (N + 1.9) / 2 + 0.02;
    addBox(pos, nrm, col, 0, -0.12, -eOff, N + 1.94, 0.05, 0.06, edge);
    addBox(pos, nrm, col, 0, -0.12, eOff, N + 1.94, 0.05, 0.06, edge);
    addBox(pos, nrm, col, -eOff, -0.12, 0, 0.06, 0.05, N + 1.94, edge);
    addBox(pos, nrm, col, eOff, -0.12, 0, 0.06, 0.05, N + 1.94, edge);

    // 格子
    for (let x = 0; x < N; x++) {
      for (let z = 0; z < N; z++) {
        const even = (x + z) % 2 === 0;
        const c = even ? [0.062, 0.084, 0.140] : [0.038, 0.054, 0.096];
        addBox(pos, nrm, col, cellX(x), -0.075, cellZ(z), 0.94, 0.15, 0.94, c);
        if (!even) {
          // 格子中心一点微光，营造网格质感
          addBox(pos, nrm, col, cellX(x), -0.004, cellZ(z), 0.20, 0.012, 0.20, [0.09, 0.16, 0.24]);
        }
      }
    }

    // 四周墙体
    const wallH = 0.78, wallT = 0.34;
    const wallOff = N / 2 + wallT / 2;
    const wallLen = N + wallT * 2;
    const wallCol = [0.070, 0.098, 0.164];
    const capCol = [0.20, 0.94, 0.80];
    addBox(pos, nrm, col, 0, wallH / 2 - 0.08, -wallOff, wallLen, wallH, wallT, wallCol);
    addBox(pos, nrm, col, 0, wallH / 2 - 0.08, wallOff, wallLen, wallH, wallT, wallCol);
    addBox(pos, nrm, col, -wallOff, wallH / 2 - 0.08, 0, wallT, wallH, wallLen, wallCol);
    addBox(pos, nrm, col, wallOff, wallH / 2 - 0.08, 0, wallT, wallH, wallLen, wallCol);

    // 墙体顶部霓虹灯带
    const capY = wallH - 0.08;
    addBox(pos, nrm, col, 0, capY, -wallOff, wallLen, 0.045, wallT * 0.8, capCol);
    addBox(pos, nrm, col, 0, capY, wallOff, wallLen, 0.045, wallT * 0.8, capCol);
    addBox(pos, nrm, col, -wallOff, capY, 0, wallT * 0.8, 0.045, wallLen, capCol);
    addBox(pos, nrm, col, wallOff, capY, 0, wallT * 0.8, 0.045, wallLen, capCol);

    // 四角立柱
    const cornerOff = N / 2 + wallT / 2;
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      addBox(pos, nrm, col, sx * cornerOff, 0.30, sz * cornerOff, 0.52, 0.96, 0.52, [0.10, 0.14, 0.22]);
      addBox(pos, nrm, col, sx * cornerOff, 0.82, sz * cornerOff, 0.30, 0.10, 0.30, [0.24, 1.0, 0.86]);
    });

    return meshFrom(pos, nrm, col);
  }

  const BOARD = buildBoard();

  /* ------------------------------------------------------------------
     5. 游戏状态
     ------------------------------------------------------------------ */
  const DIRS = {
    up: { x: 0, z: -1 },
    down: { x: 0, z: 1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 }
  };

  const state = {
    screen: 'start',       // start | playing | paused | over
    cells: [],
    dir: { x: 1, z: 0 },
    queue: [],
    stepMs: 200,
    acc: 0,
    t: 0,                  // 当前步的插值进度 0..1
    eaten: 0,
    score: 0,
    best: 0,
    food: null,
    particles: [],
    shake: 0,
    time: 0,
    deathAt: 0,
    steps: 0,
    grace: 0
  };

  let soundOn = true;
  let audioCtx = null;

  function loadBest() {
    try {
      const v = parseInt(window.localStorage.getItem('neon-snake-3d-best') || '0', 10);
      return isNaN(v) ? 0 : v;
    } catch (e) {
      return 0;
    }
  }

  function saveBest(v) {
    try { window.localStorage.setItem('neon-snake-3d-best', String(v)); } catch (e) { /* ignore */ }
  }

  /* 音效：极简 WebAudio 合成 */
  function initAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
  }

  function beep(freq, dur, type, vol) {
    if (!soundOn || !audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol || 0.07, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (dur || 0.1));
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + (dur || 0.1) + 0.02);
  }

  function eatSound(golden) {
    if (golden) {
      beep(880, 0.09, 'triangle', 0.08);
      setTimeout(() => beep(1320, 0.14, 'triangle', 0.07), 70);
    } else {
      beep(660 + Math.min(state.eaten, 12) * 22, 0.09, 'sine', 0.07);
    }
  }

  /* ------------------------------------------------------------------
     6. 走一步
     ------------------------------------------------------------------ */
  function isFree(x, z, ignoreTail) {
    if (x < 0 || z < 0 || x >= N || z >= N) return false;
    const cells = state.cells;
    const len = ignoreTail ? cells.length - 1 : cells.length;
    for (let i = 0; i < len; i++) {
      if (cells[i].x === x && cells[i].z === z) return false;
    }
    return true;
  }

  function spawnFood() {
    let x = 0, z = 0, guard = 0;
    do {
      x = Math.floor(Math.random() * N);
      z = Math.floor(Math.random() * N);
      guard++;
    } while (!isFree(x, z, false) && guard < 400);

    state.food = {
      x, z,
      golden: Math.random() < 0.18,
      born: state.time,
      spin: rand(0, Math.PI * 2)
    };
  }

  function burst(wx, wy, wz, color, count, power) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 1.15;
      const sp = rand(1.8, 6.5) * (power || 1);
      state.particles.push({
        x: wx, y: wy + rand(-0.1, 0.25), z: wz,
        vx: Math.cos(a) * Math.cos(e) * sp,
        vy: Math.sin(e) * sp + 2.2,
        vz: Math.sin(a) * Math.cos(e) * sp,
        life: rand(0.35, 0.85),
        age: 0,
        size: rand(0.07, 0.17),
        color: color
      });
    }
    if (state.particles.length > 320) {
      state.particles.splice(0, state.particles.length - 320);
    }
  }

  function die() {
    state.screen = 'over';
    state.deathAt = state.time;
    state.shake = 0.55;
    const head = state.cells[0];
    burst(cellX(head.x), 0.5, cellZ(head.z), [1, 0.35, 0.5], 34, 1.5);
    beep(220, 0.28, 'sawtooth', 0.06);
    setTimeout(() => beep(150, 0.42, 'sawtooth', 0.05), 110);
    if (state.score > state.best) {
      state.best = state.score;
      saveBest(state.best);
      $('best').textContent = state.best;
    }
    setTimeout(() => {
      if (state.screen === 'over') showOverlay('over');
    }, 620);
  }

  function step() {
    state.steps++;
    const cells = state.cells;
    if (state.queue.length) {
      const nd = state.queue.shift();
      if (!(nd.x === -state.dir.x && nd.z === -state.dir.z)) state.dir = nd;
    }

    const head = cells[0];
    const nx = head.x + state.dir.x;
    const nz = head.z + state.dir.z;

    if (nx < 0 || nz < 0 || nx >= N || nz >= N) {
      state.t = 1;
      die();
      return;
    }

    const willEat = state.food && nx === state.food.x && nz === state.food.z;

    if (!isFree(nx, nz, !willEat)) {
      state.t = 1;
      die();
      return;
    }

    cells.unshift({ x: nx, z: nz });

    if (willEat) {
      const golden = state.food.golden;
      const gain = golden ? 30 : 10;
      state.score += gain;
      state.eaten++;
      state.stepMs = Math.max(78, 200 - state.eaten * 4.2);
      burst(cellX(nx), 0.55, cellZ(nz), golden ? [1, 0.83, 0.36] : [1, 0.36, 0.56], golden ? 30 : 18, golden ? 1.35 : 1);
      state.shake = Math.max(state.shake, golden ? 0.34 : 0.16);
      eatSound(golden);
      toast(golden ? '+30 金球!' : '+' + gain, golden);
      spawnFood();
      updateScore();
    } else {
      cells.pop();
    }
  }

  function resetGame() {
    const mid = Math.floor(N / 2);
    state.cells = [
      { x: mid, z: mid },
      { x: mid - 1, z: mid },
      { x: mid - 2, z: mid },
      { x: mid - 3, z: mid }
    ];
    state.dir = { x: 1, z: 0 };
    state.queue = [];
    state.eaten = 0;
    state.score = 0;
    state.stepMs = 200;
    state.acc = 0;
    state.t = 1;
    state.particles.length = 0;
    state.shake = 0;
    state.deathAt = 0;
    state.steps = 0;
    state.grace = 0;
    spawnFood();
    updateScore();
  }

  /* ------------------------------------------------------------------
     7. 相机
     ------------------------------------------------------------------ */
  const cam = {
    mode: 0,                       // 0 跟随 1 全景 2 追尾
    pos: [0, 17, 14],
    target: [0, 0, 0],
    names: ['跟随视角', '全景视角', '追尾视角']
  };

  function headRenderPos() {
    const head = state.cells[0];
    if (!head) return [0, 0, 0];
    const off = state.steps === 0 ? 0 : (1 - state.t) * CELL;
    return [
      cellX(head.x) - state.dir.x * off,
      0,
      cellZ(head.z) - state.dir.z * off
    ];
  }

  function camZoom() {
    const aspect = (canvas.clientWidth || 1) / Math.max(1, canvas.clientHeight || 1);
    const fit = 1.15 / clamp(aspect, 0.32, 1.15);
    return clamp(Math.pow(fit, 0.88), 1, 2.9);
  }

  function desiredCamera() {
    const hp = headRenderPos();
    const z = camZoom();
    let wantPos;
    let wantTarget;

    if (state.screen === 'start' || state.screen === 'over') {
      const a = state.time * 0.16;
      wantPos = [Math.sin(a) * 5.5 * z, 18.4 * z, Math.cos(a) * 14.4 * z + 1.2];
      wantTarget = [0, -0.8, 0];
    } else if (cam.mode === 2) {
      const d = state.dir;
      wantPos = [hp[0] - d.x * 7.4 * z, 6.4 * z, hp[2] - d.z * 7.4 * z];
      wantTarget = [hp[0] + d.x * 4.2, 0.4, hp[2] + d.z * 4.2];
    } else if (cam.mode === 1) {
      wantPos = [0, 22.0 * z, 17.2 * z];
      wantTarget = [0, -1.0 - (z - 1) * 1.6, 0.8];
    } else {
      const range = z > 1.35 ? 0 : 3.2;
      const fx = clamp(hp[0], -range, range);
      const fz = clamp(hp[2], -range, range);
      wantPos = [fx, 18.6 * z, fz + 14.6 * z];
      wantTarget = [fx, -1.0 - (z - 1) * 1.6, fz];
    }

    return { pos: wantPos, target: wantTarget };
  }

  function updateCamera(dt) {
    const want = desiredCamera();
    const speed = state.screen === 'start' || state.screen === 'over' ? 2.2 : (cam.mode === 2 ? 7.0 : 5.0);
    const k = 1 - Math.exp(-dt * speed);
    for (let i = 0; i < 3; i++) {
      cam.pos[i] += (want.pos[i] - cam.pos[i]) * k;
      cam.target[i] += (want.target[i] - cam.target[i]) * k;
    }
  }

  /* ------------------------------------------------------------------
     8. 渲染
     ------------------------------------------------------------------ */
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let viewW = 0, viewH = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w !== viewW || h !== viewH) {
      viewW = w; viewH = h;
      canvas.width = w;
      canvas.height = h;
    }
  }

  function drawSnake() {
    const cells = state.cells;
    const len = cells.length;
    const off = state.steps === 0 ? 0 : (1 - state.t) * CELL;
    const headColor = [0.24, 1.0, 0.74];
    const tailColor = [0.035, 0.36, 0.42];

    for (let i = len - 1; i >= 0; i--) {
      const c = cells[i];
      const x = cellX(c.x) - state.dir.x * off;
      const z = cellZ(c.z) - state.dir.z * off;
      const ratio = len > 1 ? i / (len - 1) : 0;
      const size = lerp(0.94, 0.66, Math.pow(ratio, 1.25));
      const y = size * 0.5 + 0.015 + (i === 0 ? Math.sin(state.time * 7) * 0.012 : 0);
      const band = i % 2 === 0 ? 1.0 : 0.88;
      const col = [
        lerp(headColor[0], tailColor[0], ratio) * band,
        lerp(headColor[1], tailColor[1], ratio) * band,
        lerp(headColor[2], tailColor[2], ratio) * band
      ];
      const emit = i === 0 ? 0.30 : lerp(0.18, 0.04, ratio);
      const m = modelMat(x, y, z, 0, 0, 0, size);
      drawMesh(CUBE, m, col, 1, emit);

      // 头顶高光块，增加层次
      if (i === 0) {
        const d = state.dir;
        const px = -d.z, pz = d.x;
        for (let s = -1; s <= 1; s += 2) {
          const ex = x + d.x * 0.40 + px * 0.18 * s;
          const ez = z + d.z * 0.40 + pz * 0.18 * s;
          drawMesh(SPHERE, modelMat(ex, y + 0.17, ez, 0, 0, 0, 0.22), [0.015, 0.05, 0.06], 1, 0.0);
        }
      }
    }
  }

  function drawFood() {
    const f = state.food;
    if (!f) return;
    const bob = Math.sin(state.time * 2.6 + f.spin) * 0.075;
    const x = cellX(f.x);
    const z = cellZ(f.z);
    const y = 0.44 + bob;
    const gold = f.golden;
    const pulse = 1 + Math.sin(state.time * 4.2 + f.spin) * 0.07;
    const size = (gold ? 0.86 : 0.74) * pulse;
    const color = gold ? [1.0, 0.80, 0.28] : [1.0, 0.34, 0.55];

    drawMesh(SPHERE, modelMat(x, y, z, state.time * 0.9, f.spin + state.time * 1.1, 0, size), color, 1, 0.55);

    // 地面光环，远处也能一眼看到目标
    const ringR = (gold ? 0.62 : 0.56) * (1 + Math.sin(state.time * 3.4 + f.spin) * 0.06);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + state.time * 0.55;
      drawMesh(
        CUBE,
        modelMat(x + Math.cos(a) * ringR, 0.018, z + Math.sin(a) * ringR, 0, -a, 0, 0.085),
        color,
        0.55,
        0.35
      );
    }

    // 环绕的小碎片
    const orbit = gold ? 1.05 : 0.92;
    for (let i = 0; i < 3; i++) {
      const a = state.time * (gold ? 2.4 : 1.7) + f.spin + (i * Math.PI * 2) / 3;
      const ox = Math.cos(a) * orbit;
      const oz = Math.sin(a) * orbit;
      const oy = y + Math.sin(a * 2 + i) * 0.18;
      drawMesh(CUBE, modelMat(x + ox, oy, z + oz, a, a * 1.3, 0, 0.12), color, 1, 0.75);
    }
  }

  function drawParticles() {
    if (!state.particles.length) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const life = 1 - p.age / p.life;
      if (life <= 0) continue;
      const s = p.size * (0.35 + life * 0.85);
      drawMesh(CUBE, modelMat(p.x, p.y, p.z, p.age * 6, p.age * 7, 0, s), p.color, life * 0.95, 0.55);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  function render() {
    resize();
    const aspect = viewW / Math.max(1, viewH);
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 140);

    let eye = cam.pos;
    if (state.shake > 0.001) {
      const s = state.shake * 0.5;
      eye = [
        cam.pos[0] + (Math.random() - 0.5) * s,
        cam.pos[1] + (Math.random() - 0.5) * s,
        cam.pos[2] + (Math.random() - 0.5) * s
      ];
    }
    const view = lookAt(eye, cam.target, UP);

    gl.viewport(0, 0, viewW, viewH);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(U.uProj, false, proj);
    gl.uniformMatrix4fv(U.uView, false, view);
    gl.uniform3fv(U.uCamPos, eye);

    const camDist = Math.hypot(eye[0] - cam.target[0], eye[1] - cam.target[1], eye[2] - cam.target[2]);
    gl.uniform1f(U.uFogNear, camDist * 1.10);
    gl.uniform1f(U.uFogFar, camDist * 2.35);

    drawMesh(BOARD, IDENT, WHITE, 1, 0.03);
    if (state.cells.length) drawSnake();
    drawFood();
    drawParticles();
  }

  /* ------------------------------------------------------------------
     9. 主循环
     ------------------------------------------------------------------ */
  function update(dt) {
    state.time += dt;
    state.shake *= Math.exp(-dt * 4.2);

    if (state.screen === 'playing') {
      if (state.grace > 0) {
        state.grace -= dt;
        state.acc = 0;
        state.t = 1;
      } else {
        state.acc += dt * 1000;
      }
      let guard = 0;
      while (state.grace <= 0 && state.acc >= state.stepMs && state.screen === 'playing' && guard++ < 4) {
        state.acc -= state.stepMs;
        step();
      }
      if (state.screen === 'playing') {
        state.t = clamp(state.acc / state.stepMs, 0, 1);
      }
    }

    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.age += dt;
      if (p.age >= p.life) { state.particles.splice(i, 1); continue; }
      p.vy -= 13 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.06) { p.y = 0.06; p.vy *= -0.36; p.vx *= 0.72; p.vz *= 0.72; }
    }

    updateCamera(dt);
  }

  let lastFrame = 0;
  function frame(now) {
    if (!lastFrame) lastFrame = now;
    const dt = Math.min(0.05, Math.max(0.0005, (now - lastFrame) / 1000));
    lastFrame = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------
     10. 界面
     ------------------------------------------------------------------ */
  const overlay = $('overlay');
  const ovTitle = $('ovTitle');
  const ovSub = $('ovSub');
  const ovStats = $('ovStats');
  const btnPlay = $('btnPlay');
  const scoreEl = $('score');
  const bestEl = $('best');
  const toastEl = $('toast');
  let toastTimer = 0;

  function updateScore() {
    scoreEl.textContent = state.score;
    scoreEl.classList.remove('pop');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('pop');
    setTimeout(() => scoreEl.classList.remove('pop'), 190);
  }

  function toast(text, golden) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.toggle('gold', !!golden);
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 760);
  }

  function showOverlay(kind) {
    overlay.classList.remove('hidden');
    if (kind === 'start') {
      ovTitle.textContent = '3D 贪吃蛇';
      ovSub.textContent = '吃掉能量球，别撞墙，也别咬到自己的尾巴';
      ovStats.textContent = '';
      btnPlay.textContent = '开始游戏';
    } else if (kind === 'paused') {
      ovTitle.textContent = '已暂停';
      ovSub.textContent = '按空格或点击下方按钮继续';
      ovStats.textContent = '当前得分 ' + state.score + ' · 长度 ' + state.cells.length;
      btnPlay.textContent = '继续游戏';
    } else if (kind === 'over') {
      const record = state.score > 0 && state.score >= state.best;
      ovTitle.textContent = record ? '新纪录！' : '游戏结束';
      ovSub.textContent = record ? '这局刷新了你的最高分' : '再来一局，突破 ' + state.best + ' 分';
      ovStats.textContent = '得分 ' + state.score + ' · 长度 ' + state.cells.length + ' · 最高 ' + state.best;
      btnPlay.textContent = '再来一局';
    }
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function startGame() {
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    resetGame();
    state.screen = 'playing';
    state.acc = 0;
    state.t = 0;
    state.grace = 0.45;
    hideOverlay();
    beep(520, 0.08, 'sine', 0.05);
    setTimeout(() => beep(780, 0.1, 'sine', 0.05), 90);
  }

  function togglePause() {
    if (state.screen === 'playing') {
      state.screen = 'paused';
      showOverlay('paused');
    } else if (state.screen === 'paused') {
      state.screen = 'playing';
      state.acc = 0;
      state.t = 0;
      hideOverlay();
    }
  }

  function restart() {
    startGame();
  }

  function cycleCamera() {
    cam.mode = (cam.mode + 1) % 3;
    toast(cam.names[cam.mode]);
  }

  /* ------------------------------------------------------------------
     11. 输入
     ------------------------------------------------------------------ */
  function pushDir(name) {
    const d = DIRS[name];
    if (!d) return;
    if (state.screen === 'start') { startGame(); return; }
    if (state.screen !== 'playing') return;
    if (state.queue.length >= 2) return;
    const last = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
    if (last.x === d.x && last.z === d.z) return;
    if (last.x === -d.x && last.z === -d.z) return;
    state.queue.push(d);
  }

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
    k: 'up', j: 'down', h: 'left', l: 'right'
  };

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = KEYMAP[e.key];
    if (dir) {
      e.preventDefault();
      pushDir(dir);
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (state.screen === 'start' || state.screen === 'over') startGame();
      else togglePause();
    } else if (e.key === 'r' || e.key === 'R') {
      restart();
    } else if (e.key === 'c' || e.key === 'C') {
      cycleCamera();
    } else if (e.key === 'Escape') {
      if (state.screen === 'playing') togglePause();
    }
  }, { passive: false });

  // 滑动
  let touchStart = null;
  window.addEventListener('touchstart', function (e) {
    initAudio();
    if (e.touches.length !== 1) return;
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() };
  }, { passive: true });

  window.addEventListener('touchend', function (e) {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - touchStart.t;
    touchStart = null;
    if (dist < 26) {
      if (dt < 260 && state.screen === 'start') startGame();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) pushDir(dx > 0 ? 'right' : 'left');
    else pushDir(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  // 虚拟方向键
  const dpad = $('dpad');
  dpad.querySelectorAll('[data-dir]').forEach(function (btn) {
    const handler = function (e) {
      e.preventDefault();
      initAudio();
      pushDir(btn.getAttribute('data-dir'));
    };
    btn.addEventListener('touchstart', handler, { passive: false });
    btn.addEventListener('mousedown', handler);
  });

  if ('ontouchstart' in window || window.matchMedia('(pointer: coarse)').matches) {
    dpad.classList.add('show');
  }

  window.addEventListener('blur', function () {
    if (state.screen === 'playing') togglePause();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.screen === 'playing') togglePause();
  });

  /* ------------------------------------------------------------------
     12. 按钮
     ------------------------------------------------------------------ */
  btnPlay.addEventListener('click', function () {
    if (state.screen === 'paused') togglePause();
    else startGame();
  });

  $('btnPause').addEventListener('click', function () {
    if (state.screen === 'start' || state.screen === 'over') return;
    togglePause();
  });

  $('btnSound').addEventListener('click', function () {
    soundOn = !soundOn;
    this.classList.toggle('off', !soundOn);
    this.textContent = soundOn ? '🔊' : '🔇';
    if (soundOn) { initAudio(); beep(740, 0.07, 'sine', 0.05); }
  });

  $('btnCamera').addEventListener('click', function () {
    initAudio();
    cycleCamera();
  });

  /* ------------------------------------------------------------------
     13. 启动
     ------------------------------------------------------------------ */
  state.best = loadBest();
  bestEl.textContent = state.best;
  resetGame();
  state.t = 1;
  cam.pos = [0, 17, 14];
  cam.target = [0, 0, 0];
  requestAnimationFrame(frame);

  window.addEventListener('resize', resize);

  window.__snake = {
    state, cam, N, CELL, DIRS,
    step, update, render, resetGame, startGame, togglePause, restart,
    cycleCamera, pushDir, spawnFood, camZoom, desiredCamera,
    math: { perspective, lookAt, matMul }
  };
})();
