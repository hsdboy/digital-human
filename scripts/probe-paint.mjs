import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 820, height: 720 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig && window.__three, { timeout: 20000 });
await page.waitForTimeout(1500);
const n = await page.evaluate(() => {
  const { THREE, controls } = window.__three;
  controls.target.set(0, -0.22, 0.12);
  controls.object.position.set(0, -0.2, 0.72);
  controls.update();
  document.querySelector('.chat').style.display = 'none';
  document.querySelector('.hud').style.display = 'none';
  document.querySelector('.panel').style.display = 'none';
  window.dispatchEvent(new Event('resize'));
  window.__mixer.manual.set('jawOpen', 0.55);

  const head = window.__rig.head;
  const pos = head.geometry.attributes.position;
  const col = head.geometry.attributes.color;
  const v = new THREE.Vector3();
  let hits = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(head.matrixWorld);
    if (Math.abs(v.x) < 0.09 && v.y > -0.26 && v.y < -0.12 && v.z < 0.245 && v.z > 0.05) {
      col.setXYZ(i, 1, 0, 0);
      hits++;
    }
  }
  col.needsUpdate = true;
  return hits;
});
console.log('painted', n);
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/paint-test.png' });
await browser.close();
