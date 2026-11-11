import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForTimeout(4500);
const d = await page.evaluate(() => {
  const { THREE } = window.__three;
  const r = window.__rig;
  const head = r.head;
  const eyes = [];
  r.root.traverse(o => { if (o.isMesh && o !== head && o.material && o.material.vertexColors && o.geometry.attributes.color) eyes.push(o); });
  const centers = eyes.map(e => {
    e.geometry.computeBoundingBox();
    const c = e.geometry.boundingBox.getCenter(new THREE.Vector3());
    return c.applyMatrix4(e.matrixWorld);
  });
  const pos = head.geometry.attributes.position;
  const v = new THREE.Vector3();
  const box = new THREE.Box3().setFromObject(head);
  const browY = centers.length ? centers[0].y + 0.078 : 0;
  let hits = 0, hitsLoose = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(head.matrixWorld);
    for (const c of centers) {
      const dx = (v.x - c.x) / 0.082, dy = (v.y - (c.y + 0.078)) / 0.019, dz = (v.z - (c.z + 0.012)) / 0.075;
      const dd = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dd < 1) hits++;
      if (Math.abs(v.y - (c.y + 0.078)) < 0.03 && Math.abs(v.x - c.x) < 0.1 && v.z > c.z - 0.05) hitsLoose++;
    }
  }
  const browColored = (() => {
    const col = head.geometry.attributes.color;
    if (!col) return 'none';
    let dark = 0;
    for (let i = 0; i < col.count; i++) if (col.getX(i) < 0.2) dark++;
    return dark;
  })();
  return {
    eyeMeshes: eyes.length,
    eyeCenters: centers.map(c => [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)]),
    browY: +browY.toFixed(3),
    headBoxY: [+box.min.y.toFixed(3), +box.max.y.toFixed(3)],
    headVerts: pos.count,
    ellipseHits: hits,
    looseHits: hitsLoose,
    darkVertexColors: browColored,
  };
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
