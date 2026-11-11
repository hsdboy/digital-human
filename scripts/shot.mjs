import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 1 });

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => ({
  loaded: document.getElementById('loading').classList.contains('done'),
  channels: document.getElementById('channels').textContent,
  missing: document.getElementById('missing').textContent,
  fps: document.getElementById('fps').textContent,
  active: document.getElementById('active').textContent,
  error: document.getElementById('error').textContent,
  hasRig: !!window.__rig,
  morphCount: window.__rig ? window.__rig.head.morphTargetInfluences.length : 0,
  mapped: window.__rig ? window.__rig.channelIndex.size : 0,
}));
console.log(JSON.stringify(info, null, 2));

await page.screenshot({ path: '/tmp/shot-01-neutral.png' });

await page.evaluate(() => window.__mixer.setPreset('joy'));
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/shot-02-joy.png' });

await page.evaluate(() => {
  window.__mixer.setPreset('anger');
  window.__mixer.setEmotion(-0.6, 0.5);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-03-anger.png' });

await page.evaluate(() => {
  window.__mixer.setPreset('surprise');
  window.__mixer.setEmotion(0.1, 0.8);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-04-surprise.png' });

await browser.close();
console.log('done');
