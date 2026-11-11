/** 量世界坐标与 UV 的相关性：判断贴图是否需要上下翻转/左右镜像 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?v=uv', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig, null, { timeout: 60000 });
await page.waitForTimeout(800);

const r = await page.evaluate(() => {
  const rig = window.__rig;
  const THREE = window.__three.THREE;
  const g = rig.head.geometry;
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const mw = rig.head.matrixWorld;
  const v = new THREE.Vector3();

  const xs = [];
  const ys = [];
  const us = [];
  const vs = [];
  let uMin = 1e9, uMax = -1e9, vMin = 1e9, vMax = -1e9;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    const u = uv.getX(i) / 4096;
    const vv = uv.getY(i) / 4096;
    xs.push(v.x); ys.push(v.y); us.push(u); vs.push(vv);
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
  }

  const corr = (a, b) => {
    const ma = a.reduce((s, x) => s + x, 0) / a.length;
    const mb = b.reduce((s, x) => s + x, 0) / b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db);
  };

  // 分组：靠近嘴、靠近眼
  const mouth = rig.anchors.mouth;
  const eyeC = rig.anchors.eyeL.clone().add(rig.anchors.eyeR).multiplyScalar(0.5);
  const groups = { mouthUV: [], eyeUV: [], lowUV: [], highUV: [] };
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(xs[i], ys[i], 0);
    const dM = Math.hypot(xs[i] - mouth.x, ys[i] - mouth.y);
    const dE = Math.hypot(xs[i] - eyeC.x, ys[i] - eyeC.y);
    if (dM < 0.02) groups.mouthUV.push([us[i], vs[i]]);
    if (dE < 0.02) groups.eyeUV.push([us[i], vs[i]]);
  }
  const avg = (arr) => (arr.length ? [arr.reduce((s, p) => s + p[0], 0) / arr.length, arr.reduce((s, p) => s + p[1], 0) / arr.length] : null);

  return {
    corrXU: +corr(xs, us).toFixed(3),
    corrYV: +corr(ys, vs).toFixed(3),
    corrYU: +corr(ys, us).toFixed(3),
    uvRange: [+uMin.toFixed(3), +uMax.toFixed(3), +vMin.toFixed(3), +vMax.toFixed(3)],
    mouthUV: avg(groups.mouthUV),
    eyeUV: avg(groups.eyeUV),
    nMouth: groups.mouthUV.length,
    nEye: groups.eyeUV.length,
    anchors: {
      eyeL: rig.anchors.eyeL.toArray().map((x) => +x.toFixed(3)),
      eyeR: rig.anchors.eyeR.toArray().map((x) => +x.toFixed(3)),
      mouth: rig.anchors.mouth.toArray().map((x) => +x.toFixed(3)),
    },
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
