const assert = require('assert');
const { boot } = require('./harness');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

function fresh() {
  return boot({ width: 1280, height: 720 });
}

function clearTimers() {
  // die()/toast() 里的 setTimeout 不影响断言，这里不做处理
}

console.log('初始化与渲染');
test('冷启动进入 start 界面，蛇长 4 且居中', () => {
  const { api } = fresh();
  assert.strictEqual(api.state.screen, 'start');
  assert.strictEqual(api.state.cells.length, 4);
  assert.strictEqual(api.state.cells[0].x, 8);
  assert.strictEqual(api.state.cells[0].z, 8);
  assert.ok(api.state.food, '食物应已生成');
});

test('帧循环能正常绘制（含棋盘/蛇/食物）', () => {
  const h = fresh();
  h.stepFrames(2);
  assert.ok(h.counters.draws > 15, 'draw calls = ' + h.counters.draws);
  assert.strictEqual(h.counters.buffers, 9, '静态 buffer 不应重复创建');
});

test('竖屏时相机会自动拉远', () => {
  const wide = boot({ width: 1280, height: 720 }).api.camZoom();
  const tall = boot({ width: 390, height: 844 }).api.camZoom();
  assert.ok(tall > wide * 1.8, `portrait zoom ${tall} 应明显大于 ${wide}`);
});

console.log('玩法');
test('开始游戏后进入 playing', () => {
  const h = fresh();
  h.api.startGame();
  assert.strictEqual(h.api.state.screen, 'playing');
  assert.ok(h.els.overlay.classList.contains('hidden'));
  h.stepFrames(2);
});

test('吃到食物：得分 +10、长度 +1、刷新食物', () => {
  const { api } = fresh();
  api.startGame();
  const head = api.state.cells[0];
  const oldFood = api.state.food;
  api.state.food = { x: head.x + 1, z: head.z, golden: false, born: 0, spin: 0 };
  api.step();
  assert.strictEqual(api.state.score, 10);
  assert.strictEqual(api.state.cells.length, 5);
  assert.strictEqual(api.state.eaten, 1);
  assert.notStrictEqual(api.state.food, oldFood);
  assert.ok(api.state.particles.length > 0, '应有粒子特效');
});

test('金球 +30 且粒子更多', () => {
  const { api } = fresh();
  api.startGame();
  const head = api.state.cells[0];
  api.state.food = { x: head.x + 1, z: head.z, golden: true, born: 0, spin: 0 };
  api.step();
  assert.strictEqual(api.state.score, 30);
});

test('每吃一个食物速度递增且有下限', () => {
  const { api } = fresh();
  api.startGame();
  const first = api.state.stepMs;
  for (let i = 0; i < 60; i++) {
    const head = api.state.cells[0];
    api.state.food = { x: head.x + 1, z: head.z, golden: false, born: 0, spin: 0 };
    if (api.state.cells[0].x + 1 >= api.N) break;
    api.step();
  }
  assert.ok(api.state.stepMs < first, 'stepMs 应随得分下降');
  assert.ok(api.state.stepMs >= 78, 'stepMs 不应低于下限');
});

test('不能 180 度掉头', () => {
  const { api } = fresh();
  api.startGame();
  assert.deepStrictEqual(api.state.dir, { x: 1, z: 0 });
  api.pushDir('left');
  assert.strictEqual(api.state.queue.length, 0);
  api.pushDir('up');
  assert.strictEqual(api.state.queue.length, 1);
});

test('撞墙判定为游戏结束', () => {
  const { api } = fresh();
  api.startGame();
  api.state.cells = [{ x: api.N - 1, z: 8 }, { x: api.N - 2, z: 8 }];
  api.state.dir = { x: 1, z: 0 };
  api.state.food = { x: 0, z: 0, golden: false, born: 0, spin: 0 };
  api.step();
  assert.strictEqual(api.state.screen, 'over');
});

test('咬到自己判定为游戏结束', () => {
  const { api } = fresh();
  api.startGame();
  api.state.cells = [
    { x: 5, z: 5 }, { x: 5, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 5 },
    { x: 4, z: 6 }, { x: 5, z: 6 }, { x: 6, z: 6 }, { x: 6, z: 5 }
  ];
  api.state.dir = { x: 0, z: 1 };
  api.state.food = { x: 0, z: 0, golden: false, born: 0, spin: 0 };
  api.step();
  assert.strictEqual(api.state.screen, 'over');
});

test('追尾移动到尾部格子是合法的', () => {
  const { api } = fresh();
  api.startGame();
  api.state.cells = [
    { x: 5, z: 5 }, { x: 5, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 5 },
    { x: 4, z: 6 }, { x: 5, z: 6 }, { x: 6, z: 6 }, { x: 6, z: 5 }
  ];
  api.state.dir = { x: 1, z: 0 };   // 头去往尾部 (6,5)
  api.state.food = { x: 0, z: 0, golden: false, born: 0, spin: 0 };
  api.step();
  assert.strictEqual(api.state.screen, 'playing');
});

test('食物不会生成在蛇身上', () => {
  const { api } = fresh();
  api.startGame();
  api.state.cells = [];
  for (let x = 0; x < 10; x++) api.state.cells.push({ x, z: 8 });
  for (let i = 0; i < 300; i++) {
    api.spawnFood();
    const f = api.state.food;
    const hit = api.state.cells.some((c) => c.x === f.x && c.z === f.z);
    assert.ok(!hit, '食物与蛇重叠');
  }
});

test('粒子会随时间衰减干净', () => {
  const { api } = fresh();
  api.startGame();
  const head = api.state.cells[0];
  api.state.food = { x: head.x + 1, z: head.z, golden: true, born: 0, spin: 0 };
  api.step();
  assert.ok(api.state.particles.length > 0);
  api.state.screen = 'paused';
  const initial = api.state.particles.length;
  for (let i = 0; i < 70; i++) api.update(0.016);
  assert.ok(api.state.particles.length < initial, '粒子应逐渐消失');
  for (let i = 0; i < 80; i++) api.update(0.016);
  assert.strictEqual(api.state.particles.length, 0);
});

test('暂停/继续不会推进时间步', () => {
  const h = fresh();
  h.api.startGame();
  h.stepFrames(1);
  h.api.togglePause();
  assert.strictEqual(h.api.state.screen, 'paused');
  const before = h.api.state.acc;
  for (let i = 0; i < 30; i++) h.api.update(0.016);
  assert.strictEqual(h.api.state.acc, before, '暂停时不应累积步进时间');
  h.api.togglePause();
  assert.strictEqual(h.api.state.screen, 'playing');
});

test('三种视角渲染均不报错', () => {
  const h = fresh();
  h.api.startGame();
  for (let m = 0; m < 3; m++) {
    h.api.cam.mode = m;
    for (let i = 0; i < 4; i++) {
      h.api.update(0.016);
      h.api.render();
    }
  }
  assert.ok(h.counters.draws > 40);
});

test('最高分会写入 localStorage', () => {
  const h = fresh();
  h.api.startGame();
  const head = h.api.state.cells[0];
  h.api.state.food = { x: head.x + 1, z: head.z, golden: true, born: 0, spin: 0 };
  h.api.step();
  assert.strictEqual(h.api.state.score, 30);
  h.api.state.cells = [{ x: h.api.N - 1, z: 8 }, { x: h.api.N - 2, z: 8 }];
  h.api.state.dir = { x: 1, z: 0 };
  h.api.step();
  assert.strictEqual(h.api.state.best, 30);
  assert.strictEqual(h.win.localStorage.getItem('neon-snake-3d-best'), '30');
});

console.log('\n' + passed + ' 项通过' + (process.exitCode ? '，存在失败' : '，全部通过'));
setTimeout(() => process.exit(process.exitCode || 0), 50);
