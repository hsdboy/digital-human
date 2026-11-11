/** 把刚才解出的 PNG 拆通道，判断信息到底在 RGB 还是 A 里 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(fs.readFileSync('assets/face_skin.png'));
const { width: w, height: h, data } = png;
const n = w * h;

const ch = [
  { name: 'R', out: 'assets/tex-r.png' },
  { name: 'G', out: 'assets/tex-g.png' },
  { name: 'B', out: 'assets/tex-b.png' },
  { name: 'A', out: 'assets/tex-a.png' },
];

for (let c = 0; c < 4; c++) {
  const p = new PNG({ width: w, height: h });
  const hist = new Array(16).fill(0);
  for (let i = 0; i < n; i++) {
    const v = data[i * 4 + c];
    hist[v >> 4]++;
    p.data[i * 4] = v;
    p.data[i * 4 + 1] = v;
    p.data[i * 4 + 2] = v;
    p.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(ch[c].out, PNG.sync.write(p));
  console.log(ch[c].name, '直方图(16 桶)', hist.map((x) => Math.round((100 * x) / n)).join(','));
}

// UV 岛覆盖比例：alpha>8 的像素占比
let cover = 0;
for (let i = 0; i < n; i++) if (data[i * 4 + 3] > 8) cover++;
console.log('alpha>8 覆盖', ((100 * cover) / n).toFixed(1) + '%');

// 在覆盖区内看 RGB 是否有变化
let sum = [0, 0, 0];
let cnt = 0;
const mn = [255, 255, 255];
const mx = [0, 0, 0];
for (let i = 0; i < n; i++) {
  if (data[i * 4 + 3] <= 8) continue;
  cnt++;
  for (let c = 0; c < 3; c++) {
    const v = data[i * 4 + c];
    sum[c] += v;
    if (v < mn[c]) mn[c] = v;
    if (v > mx[c]) mx[c] = v;
  }
}
console.log('覆盖区内 RGB 均值', sum.map((x) => Math.round(x / Math.max(cnt, 1))), 'min', mn, 'max', mx, '像素', cnt);
