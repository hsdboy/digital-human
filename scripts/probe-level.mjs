import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__lv = []; window.__jw = [];
  const loop = () => { const d = window.__dialogue.stats(); if (d.state==='speaking') { window.__lv.push(d.level); window.__jw.push(window.__rig.get('jawOpen')); } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
await page.fill('#ask', '我今天被老板当着所有人骂了一顿，真的挺难受的。');
await page.press('#ask', 'Enter');
for (let i = 0; i < 70; i++) { await page.waitForTimeout(120); const st = await page.evaluate(()=>window.__dialogue.stats()); if (st.state==='idle' && st.events>0 && i>8) break; }
const r = await page.evaluate(() => {
  const q = (a, p) => { const s=[...a].sort((x,y)=>x-y); return +(s[Math.floor(s.length*p)]??0).toFixed(3); };
  return { lv: [q(window.__lv,0.1), q(window.__lv,0.5), q(window.__lv,0.9), q(window.__lv,0.99)], jw: [q(window.__jw,0.1), q(window.__jw,0.5), q(window.__jw,0.9), q(window.__jw,0.99)], n: window.__lv.length };
});
console.log('level p10/p50/p90/p99 =', r.lv, ' jaw =', r.jw, ' n =', r.n);
await browser.close();
