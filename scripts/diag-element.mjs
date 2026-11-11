/** 验证元素播放路径：pos 是否推进、口型是否跟着走、句子是否正常收尾 */
import { chromium } from 'playwright';

const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1240, height: 820 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text());
});

await p.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await p.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await p.click('#stage');
await p.waitForTimeout(400);

const ping = await p.evaluate(() => window.__dialogue.voice.ping());
console.log('ping:', JSON.stringify(ping));

await p.fill('#ask', '你好，今天过得怎么样');
await p.click('#send');

// 先等第一句真的开播，LLM 首字有时候要两三秒，别提前放弃
await p
  .waitForFunction(
    () => {
      const pl = window.__dialogue.player();
      return pl && pl.cur && pl.cur.started && pl.cur.source;
    },
    { timeout: 30000 }
  )
  .catch(() => {});

const rows = [];
for (let i = 0; i < 80; i++) {
  await p.waitForTimeout(100);
  const r = await p.evaluate(() => {
    const d = window.__dialogue;
    const pl = d.player();
    const s = pl && pl.cur;
    return {
      via: d.voice.diag.via,
      pos: s && s.source ? +s.source.pos.toFixed(2) : null,
      kind: s && s.source ? s.source.kind : null,
      dur: s && s.audio ? +s.audio.duration.toFixed(2) : null,
      wall: s ? !!s.useWall : null,
      vis: window.__mixer.speech.vis ? +window.__mixer.speech.vis.jaw.toFixed(2) : null,
      txt: s ? s.text.slice(0, 8) : null,
      ext: +window.__mixer.speech.ext.toFixed(2),
    };
  });
  rows.push(r);
  if (i > 30 && !r.txt) break;
}

const played = rows.filter((r) => r.kind === 'element' && r.pos > 0);
console.log('帧数', rows.length, '| 元素播放帧', played.length, '| useWall 帧', rows.filter((r) => r.wall).length);
console.log('pos 轨迹:', rows.filter((_, i) => i % 5 === 0).map((r) => `${r.pos}/${r.dur} jaw=${r.vis}`).join(' '));
const last = await p.evaluate(() => {
  const d = window.__dialogue;
  return { stalled: d.voice.diag.stalled, drop: d.voice.diag.drop, via: d.voice.diag.via, stats: d.stats().audio };
});
console.log('final:', JSON.stringify(last));
if (errs.length) console.log('errors:', errs.slice(0, 5));
await b.close();
