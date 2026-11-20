/* 校验单文件产物：无外链、脚本可运行、能正常出帧 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./harness');

const file = path.join(__dirname, '../dist/snake-3d.html');

assert.ok(fs.existsSync(file), '请先运行 node build.js 生成 dist/snake-3d.html');
const html = fs.readFileSync(file, 'utf8');

assert.ok(!/<script[^>]+src=/.test(html), '产物不应引用外部脚本');
assert.ok(!/<link[^>]+href=/.test(html), '产物不应引用外部样式');
assert.ok(html.includes('window.__snake'), '脚本未正确内联');

const h = boot({ artifact: file, width: 1280, height: 720 });
h.stepFrames(3);
assert.strictEqual(h.api.state.screen, 'start');
assert.ok(h.counters.draws > 20, 'draw calls = ' + h.counters.draws);

h.api.startGame();
for (let i = 0; i < 30; i++) h.api.update(0.016);
h.api.render();
assert.strictEqual(h.api.state.screen, 'playing');
assert.ok(fs.statSync(file).size < 1024 * 1024, '产物应小于 1MB');

console.log('产物校验通过：' + (fs.statSync(file).size / 1024).toFixed(1) + ' KB，无外链，可运行');
