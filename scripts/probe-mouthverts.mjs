import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig, { timeout: 20000 });
await page.waitForTimeout(1500);
const d = await page.evaluate(() => {
  const { THREE } = window.__three;
  const head = window.__rig.head;
  const pos = head.geometry.attributes.position;
  const v = new THREE.Vector3();
  const rows = [];
  let inRegion = 0;
  const zs = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(head.matrixWorld);
    if (Math.abs(v.x) < 0.10 && v.y > -0.28 && v.y < -0.11) {
      inRegion++;
      zs.push(+v.z.toFixed(3));
    }
  }
  zs.sort((a,b)=>a-b);
  return { total: pos.count, inRegion, zMin: zs[0], zP10: zs[Math.floor(zs.length*0.1)], zP50: zs[Math.floor(zs.length*0.5)], zP90: zs[Math.floor(zs.length*0.9)], zMax: zs[zs.length-1] };
});
console.log(JSON.stringify(d));
await browser.close();
