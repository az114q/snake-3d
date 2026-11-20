/* 几何验证：相机构图是否把棋盘完整框进画面 */
const assert = require('assert');
const { boot } = require('./harness');

function project(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [cx / cw, cy / cw, cz / cw, cw];
}

function frameCheck(w, h, label) {
  const hh = boot({ width: w, height: h });
  const api = hh.api;
  api.startGame();
  api.state.cells = [{ x: 8, z: 8 }];
  api.state.t = 1;
  api.cam.mode = 0;
  const aspect = w / h;
  const desired = api.desiredCamera();
  const proj = api.math.perspective((50 * Math.PI) / 180, aspect, 0.1, 140);
  const view = api.math.lookAt(desired.pos, desired.target, [0, 1, 0]);
  const vp = api.math.matMul(proj, view);

  const half = api.N / 2 + 0.35;
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      corners.push([sx * half, 0, sz * half]);
      corners.push([sx * half, 1.0, sz * half]);
    }
  }
  let minX = 9, maxX = -9, minY = 9, maxY = -9;
  for (const c of corners) {
    const q = project(vp, c);
    assert.ok(q[3] > 0, label + ' 角点在相机背后');
    minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]);
    minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
  }
  console.log('  ' + label + ` NDC x[${minX.toFixed(2)}, ${maxX.toFixed(2)}] y[${minY.toFixed(2)}, ${maxY.toFixed(2)}]`);
  assert.ok(maxX <= 1 && minX >= -1, label + ' 棋盘横向超出画面');
  assert.ok(maxY <= 1 && minY >= -1, label + ' 棋盘纵向超出画面');
  // 至少占满短边 60%，避免拉得过远看不清
  const spanY = (maxY - minY) / 2;   // 垂直占比
  const spanX = (maxX - minX) / 2;
  assert.ok(Math.max(spanX, spanY) > 0.62, label + ` 棋盘太小 spanX=${spanX.toFixed(2)} spanY=${spanY.toFixed(2)}`);
}

console.log('相机构图');
frameCheck(1280, 720, '横屏 16:9');
frameCheck(1920, 1080, '桌面 1080p');
frameCheck(800, 800, '方屏');
frameCheck(390, 844, '手机竖屏');

console.log('跟随位置');
['横屏跟随', '竖屏跟随'].forEach((label, i) => {
  const w = i === 0 ? 1280 : 390;
  const h = i === 0 ? 720 : 844;
  const hh = boot({ width: w, height: h });
  const api = hh.api;
  api.startGame();
  // 把蛇头挪到角落，检查镜头跟随区域仍然框得住附近格子
  api.state.cells = [{ x: api.N - 2, z: api.N - 2 }];
  api.state.t = 1;
  const desired = api.desiredCamera();
  const proj = api.math.perspective((50 * Math.PI) / 180, w / h, 0.1, 140);
  const view = api.math.lookAt(desired.pos, desired.target, [0, 1, 0]);
  const vp = api.math.matMul(proj, view);
  const q = project(vp, [api.N / 2 - 1 - api.N / 2 + (api.N - 2 - (api.N - 1) / 2), 0.4, api.N - 2 - (api.N - 1) / 2]);
  console.log(`  ${label} 蛇头 NDC = (${q[0].toFixed(2)}, ${q[1].toFixed(2)})`);
  assert.ok(Math.abs(q[0]) < 0.85 && Math.abs(q[1]) < 0.85, label + ' 蛇头离画面边缘太近');
});

console.log('\n构图检查全部通过');
