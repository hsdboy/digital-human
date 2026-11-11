import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 820, height: 720 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__rig && window.__three, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const { controls } = window.__three;
  controls.target.set(0, -0.22, 0.12);
  controls.object.position.set(0, -0.2, 0.72);
  controls.update();
  document.querySelector('.chat').style.display = 'none';
  document.querySelector('.hud').style.display = 'none';
  document.querySelector('.panel').style.display = 'none';
  document.querySelector('#stage').style.width = '100%';
  window.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(500);
for (const [jaw, file] of [[0.16,'/tmp/m-16.png'],[0.3,'/tmp/m-30.png'],[0.55,'/tmp/m-55.png']]) {
  await page.evaluate((j) => { window.__mixer.manual.set('jawOpen', j); window.__mixer.manual.set('mouthFunnel', 0.05); }, jaw);
  await page.waitForTimeout(350);
  await page.screenshot({ path: file });
}
await browser.close();
console.log('ok');
