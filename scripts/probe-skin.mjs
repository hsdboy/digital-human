/** 诊断：UV 归一化是否生效、贴图覆盖率、采样是否落在有效像素上 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?v=diag', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig, null, { timeout: 60000 });
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const rig = window.__rig;
  const g = rig.head.geometry;
  const uv = g.attributes.uv;

  let uMin = 9, uMax = -9, vMin = 9, vMax = -9;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }

  // albedo 非零像素比例
  const alb = rig.skin.albedo;
  const n = rig.skin.size * rig.skin.size;
  let nonZero = 0;
  for (let i = 0; i < n; i++) {
    if (alb[i * 3] > 0.0005 || alb[i * 3 + 1] > 0.0005) nonZero++;
  }

  // 头顶 UV 覆盖的像素矩形
  const size = rig.skin.size;
  let pxMinX = 1e9, pxMaxX = -1e9, pxMinY = 1e9, pxMaxY = -1e9;
  for (let i = 0; i < uv.count; i++) {
    const x = uv.getX(i) * size, y = uv.getY(i) * size;
    if (x < pxMinX) pxMinX = x; if (x > pxMaxX) pxMaxX = x;
    if (y < pxMinY) pxMinY = y; if (y > pxMaxY) pxMaxY = y;
  }

  // 抽查：每个三角形的重心 UV 处，albedo 是否有内容
  const idx = g.index;
  const alb2 = rig.skin.albedo;
  const S = rig.skin.size;
  let empty = 0;
  let total = 0;
  const samples = [];
  for (let t = 0; t < idx.count / 3; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
    const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
    const v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
    const px = Math.min(S - 1, Math.max(0, Math.round(u * S)));
    const py = Math.min(S - 1, Math.max(0, Math.round(v * S)));
    const o = (py * S + px) * 3;
    total++;
    if (alb2[o] < 0.0005 && alb2[o + 1] < 0.0005) {
      empty++;
      if (samples.length < 6) samples.push({ t, u: +u.toFixed(3), v: +v.toFixed(3), px, py });
    }
  }

  const mat = rig.head.material;
  return {
    triEmptyPct: +((100 * empty) / total).toFixed(1),
    emptySamples: samples,
    uvRange: [+uMin.toFixed(4), +uMax.toFixed(4), +vMin.toFixed(4), +vMax.toFixed(4)],
    coverPct: +((100 * nonZero) / n).toFixed(1),
    uvPixelBoxV: [Math.round(pxMinX), Math.round(pxMaxX), Math.round(pxMinY), Math.round(pxMaxY)],
    mapExists: !!mat.map,
    mapFlipY: mat.map ? mat.map.flipY : null,
    mapSize: mat.map && mat.map.image ? [mat.map.image.width, mat.map.image.height] : null,
    hasColorAttr: !!g.attributes.color,
    colorSample: g.attributes.color ? [g.attributes.color.getX(0), g.attributes.color.getX(100), g.attributes.color.getX(2000)] : null,
    roughness: mat.roughness,
    clearcoat: mat.clearcoat,
    metalness: mat.metalness,
    vertexColors: mat.vertexColors,
    colorHex: mat.color.getHexString(),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
