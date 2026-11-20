/* 无浏览器环境下的桩测试：假 DOM + 假 WebGL，用来跑通初始化、帧循环与玩法逻辑。
   record: true 时会记录每次 drawArrays 的网格/模型矩阵/材质，供 CPU 光栅化预览使用。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(id) {
  const el = {
    id,
    textContent: '',
    offsetWidth: 100,
    hidden: false,
    style: {},
    _classes: new Set(),
    _listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !el._classes.has(c) : !!force;
        if (on) el._classes.add(c); else el._classes.delete(c);
        return on;
      },
      contains: (c) => el._classes.has(c)
    },
    addEventListener: (type, fn) => { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    getAttribute: (n) => el._attrs && el._attrs[n],
    querySelectorAll: () => []
  };
  return el;
}

function boot(opts) {
  const options = opts || {};
  const width = options.width || 1280;
  const height = options.height || 720;
  const counters = { draws: 0, buffers: 0 };
  const rec = [];
  const st = { bound: null, attrib: {}, uniforms: {} };

  const glStub = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) return 1;
      switch (key) {
        case 'createBuffer': return () => ({ data: null });
        case 'bindBuffer': return (t, buf) => { st.bound = buf; };
        case 'bufferData': return (t, data) => {
          counters.buffers++;
          if (st.bound) st.bound.data = data;
        };
        case 'getAttribLocation': return (p, name) => name;
        case 'getUniformLocation': return (p, name) => name;
        case 'vertexAttribPointer': return (name) => { st.attrib[name] = st.bound; };
        case 'uniformMatrix4fv': return (name, trans, v) => { st.uniforms[name] = v; };
        case 'uniformMatrix3fv': return (name, trans, v) => { st.uniforms[name] = v; };
        case 'uniform3fv': return (name, v) => { st.uniforms[name] = v; };
        case 'uniform1f': return (name, v) => { st.uniforms[name] = v; };
        case 'drawArrays': return (mode, first, count) => {
          counters.draws++;
          if (!options.record) return;
          const ub = st.uniforms;
          rec.push({
            pos: st.attrib.aPos && st.attrib.aPos.data,
            nrm: st.attrib.aNormal && st.attrib.aNormal.data,
            col: st.attrib.aColor && st.attrib.aColor.data,
            count,
            model: ub.uModel,
            color: ub.uColor,
            alpha: ub.uAlpha === undefined ? 1 : ub.uAlpha,
            emit: ub.uEmit || 0,
            view: ub.uView,
            proj: ub.uProj,
            camPos: ub.uCamPos
          });
        };
        default: return () => ({});
      }
    }
  });

  const canvas = makeEl('gl');
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  canvas.width = 300;
  canvas.height = 150;
  canvas.getContext = () => glStub;

  const dirBtns = ['up', 'left', 'right', 'down'].map((d) => {
    const b = makeEl('dir-' + d);
    b._attrs = { 'data-dir': d };
    return b;
  });

  const els = {};
  ['score', 'best', 'toast', 'overlay', 'ovTitle', 'ovSub', 'ovStats', 'btnPlay',
   'dpad', 'btnPause', 'btnSound', 'btnCamera'].forEach((id) => { els[id] = makeEl(id); });
  els.gl = canvas;
  els.dpad.querySelectorAll = () => dirBtns;

  const win = {
    devicePixelRatio: 2,
    innerWidth: width,
    innerHeight: height,
    _listeners: {},
    addEventListener(type, fn) { (win._listeners[type] = win._listeners[type] || []).push(fn); },
    matchMedia: () => ({ matches: false }),
    localStorage: {
      _data: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
      setItem(k, v) { this._data[k] = String(v); }
    }
  };

  const doc = {
    hidden: false,
    _listeners: {},
    getElementById: (id) => els[id] || makeEl(id),
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    body: { innerHTML: '' }
  };

  const rafQueue = [];
  global.window = win;
  global.document = doc;
  global.performance = { now: () => Date.now() };
  global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

  let code;
  if (options.artifact) {
    const html = fs.readFileSync(options.artifact, 'utf8');
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('产物中没有内联脚本');
    code = m[1];
  } else {
    code = fs.readFileSync(path.join(__dirname, '../src/game.js'), 'utf8');
  }
  vm.runInThisContext(code, { filename: 'game.js' });

  const api = global.window.__snake;
  return {
    api,
    counters,
    rec,
    els,
    win,
    doc,
    canvas,
    rafQueue,
    stepFrames(n, dtMs) {
      for (let i = 0; i < n; i++) {
        const fn = rafQueue.shift();
        if (!fn) throw new Error('no queued frame');
        fn(Date.now() + i * (dtMs || 16));
      }
    }
  };
}

module.exports = { boot };
