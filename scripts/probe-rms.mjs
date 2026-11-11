import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__raw = [];
  const v = window.__dialogue.voice;
  const rec = () => {
    if (v.analyser) {
      v.analyser.getByteTimeDomainData(v.timeData);
      let s = 0;
      for (let i = 0; i < v.timeData.length; i++) { const x = (v.timeData[i]-128)/128; s += x*x; }
      window.__raw.push(Math.sqrt(s / v.timeData.length));
    }
    requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
});
await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.press('#ask', 'Enter');
for (let i = 0; i < 60; i++) { await page.waitForTimeout(120); const st = await page.evaluate(()=>window.__dialogue.stats()); if (st.state==='idle' && st.events>0 && i>8) break; }
const raw = await page.evaluate(() => window.__raw);
const active = raw.filter(v => v > 0.002);
active.sort((a,b)=>a-b);
const q = (p) => +active[Math.floor(active.length*p)].toFixed(4);
console.log(JSON.stringify({ n: raw.length, active: active.length, p05:q(0.05), p25:q(0.25), p50:q(0.5), p75:q(0.75), p90:q(0.9), p98:q(0.98), max:+Math.max(...active).toFixed(4) }, null, 1));
await browser.close();
