/**
 * 把烘焙出来的贴图和渲染结果都导出来，肉眼比对。
 * 贴图要看：唇在哪、有没有偏、接缝有没有裂。
 * 渲染要看：皮肤是不是还是塑料。
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = '/tmp/skin';
const query = process.argv[2] || 'v=skin&marks=1';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[err]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:5173/?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig, null, { timeout: 60000 });
await page.waitForTimeout(1500);
console.log('加载完成', Date.now() - t0, 'ms');

const info = await page.evaluate(() => {
  const r = window.__rig;
  return {
    bakeMs: r.skin ? Math.round(r.skin.elapsed) : null,
    stats: r.skin ? r.skin.stats : null,
    anchors: {
      eyeL: r.anchors.eyeL.toArray().map((v) => +v.toFixed(3)),
      eyeR: r.anchors.eyeR.toArray().map((v) => +v.toFixed(3)),
      mouth: r.anchors.mouth.toArray().map((v) => +v.toFixed(3)),
    },
    fps: document.getElementById('fps').textContent,
    error: document.getElementById('error').textContent,
  };
});
console.log(JSON.stringify(info, null, 2));

// 导出三张烘焙图
for (const [name, tex] of [
  ['albedo', 'skinMap'],
  ['rough', 'roughMap'],
  ['normal', 'normalMap'],
  ['marked', 'marked'],
  ['eye', 'eyeCanvas'],
]) {
  const dataUrl = await page.evaluate((key) => {
    const t = window.__rig.debug[key];
    if (!t) return null;
    if (t.toDataURL) return t.toDataURL('image/png'); // 直接是 canvas
    return t.image && t.image.toDataURL ? t.image.toDataURL('image/png') : null;
  }, tex);
  if (dataUrl) {
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('导出', name);
  }
}

// 正面
await page.screenshot({ path: `${OUT}/front.png` });

// 拉近
await page.evaluate(() => {
  const { camera, controls } = window.__three;
  camera.position.set(0.28, 0.06, 1.55);
  controls.target.set(0.02, 0.0, 0.1);
  controls.update();
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/closeup.png` });

// 侧面，看轮廓和透光
await page.evaluate(() => {
  const { camera, controls } = window.__three;
  camera.position.set(1.15, 0.14, 0.85);
  controls.target.set(0.0, 0.0, 0.0);
  controls.update();
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/side.png` });

// 表情：笑
await page.evaluate(() => {
  const { camera, controls } = window.__three;
  camera.position.set(0, 0.02, 2.1);
  controls.target.set(0, 0.02, 0);
  controls.update();
  window.__mixer.setPreset('joy');
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/joy.png` });

await browser.close();
console.log('done →', OUT);
