import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig, { timeout: 20000 });
await page.waitForTimeout(1500);
const d = await page.evaluate(() => {
  const { THREE } = window.__three;
  const out = [];
  window.__rig.root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const c = bb.getCenter(new THREE.Vector3());
    const s = bb.getSize(new THREE.Vector3());
    out.push({
      name: o.parent?.name || o.name || '?',
      verts: o.geometry.attributes.position.count,
      morphs: o.morphTargetInfluences ? o.morphTargetInfluences.length : 0,
      center: [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)],
      size: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)],
      mat: o.material.type,
      color: o.material.color ? o.material.color.getHexString() : null,
    });
  });
  return out;
});
console.log(JSON.stringify(d, null, 1));
await browser.close();
