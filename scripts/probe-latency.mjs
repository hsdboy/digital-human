import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue, { timeout: 20000 });
await page.waitForTimeout(1200);

await page.evaluate(() => {
  const d = window.__dialogue;
  const v = d.voice;
  window.__t = {};
  const origLoad = v.load.bind(v);
  window.__t.loads = [];
  v.load = async (text) => {
    const s = performance.now();
    const r = await origLoad(text);
    window.__t.loads.push([Math.round(s - window.__t0), Math.round(performance.now() - s), text.slice(0, 6)]);
    return r;
  };
  const of = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0].url;
    const res = await of(...args);
    if (String(url).includes('/api/chat') && !window.__t.chatResp) window.__t.chatResp = performance.now();
    return res;
  };
  window.__t0 = performance.now();
  const loop = () => {
    const st = d.stats();
    if (st.state === 'speaking' && !window.__t.speaking) window.__t.speaking = performance.now();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.press('#ask', 'Enter');
await page.waitForTimeout(3000);
const t = await page.evaluate(() => window.__t);
const t0 = await page.evaluate(() => window.__t0);
const rel = (x) => (x ? Math.round(x - t0) : null);
console.log(JSON.stringify({ chatResp: rel(t.chatResp), speaking: rel(t.speaking), loads: t.loads }));
await browser.close();
