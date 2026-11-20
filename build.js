/* 把 src/index.html 与 src/game.js 合并成单文件产物，方便直接分享或在沙箱预览 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/game.js'), 'utf8');

if (js.includes('</script')) {
  throw new Error('game.js 中包含 </script，无法内联');
}

const marker = '<script src="game.js"></script>';
if (!html.includes(marker)) {
  throw new Error('index.html 中找不到脚本占位');
}

const out = html.replace(marker, () => '<script>\n' + js + '\n</script>');
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const file = path.join(distDir, 'snake-3d.html');
fs.writeFileSync(file, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`built ${file} (${kb} KB)`);
