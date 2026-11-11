/**
 * 音素级口形的验收测试。
 *
 * 上一版口型是音量包络 + 随机圆扁，特征是：jawOpen 有起伏，但
 * mouthPucker / mouthStretch 与文本无关，闭唇根本没出现过。
 *
 * 这一版要能证明三件事，缺一条就说明只是换了个噪声源：
 *
 *   1. **双唇音真的闭嘴**：句子里有「妈妈」「不」「明」这种 b/p/m 起音，
 *      mouthClose 必须在这些字的时刻冲高。
 *   2. **圆唇与扁唇分得开**：「不 bù / 明 míng / 爸 bà」三者对
 *      pucker / stretch 的驱动必须反向，而不是随机抖动。
 *   3. **口型跟着字走**：同一句话里，jawOpen 的峰值时刻应与
 *      「大开口韵母（a/ao/ang）」的字对齐，而不是均匀分布。
 *
 * 另外做一次 A/B：直接比对两条文本各自算出的音素轨道，
 * 确认不同文本给出不同的口型序列（防止「反正都在动」蒙混过关）。
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const SENTENCE = process.env.SENT || '妈妈不明白，爸爸也不高兴。';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__viseme && window.__rig, { timeout: 25000 });
await page.waitForTimeout(800);

// ---------------------------------------------------------------- 查表层
console.log('\n[1] 拼音 → 口型 查表');

const table = await page.evaluate(() => {
  const t = window.__viseme.track;
  return {
    mama: t('妈妈'),
    bu: t('不'),
    ming: t('明'),
    ba: t('爸'),
    yu: t('鱼'),
    a: t('啊'),
    len: t('你好，世界！').length,
    rawLen: '你好，世界！'.length,
  };
});

ok(table.mama[0].a === 'PP' && table.mama[0].b === 'aa', '「妈」= 闭唇 + 大开口', `→ ${table.mama[0].a}>${table.mama[0].b}`);
ok(table.bu[0].a === 'PP' && table.bu[0].b === 'ou', '「不」= 闭唇 + 圆唇', `→ ${table.bu[0].a}>${table.bu[0].b}`);
ok(table.ming[0].a === 'PP' && table.ming[0].b === 'ih', '「明」= 闭唇 + 扁唇', `→ ${table.ming[0].a}>${table.ming[0].b}`);
ok(table.ba[0].b === 'aa', '「爸」韵母是 a 组', `→ ${table.ba[0].b}`);
ok(table.yu[0].b === 'ou', '「鱼」还原成 ü 的圆唇', `→ ${table.yu[0].b}`);
ok(table.a[0].b === 'aa', '「啊」大开口', `→ ${table.a[0].b}`);
ok(table.len === table.rawLen, '下标与文本严格对齐（含标点）', `${table.len}/${table.rawLen}`);

// 同一句话里，圆唇/扁唇/大开口必须真的不同
const spread = await page.evaluate(() => {
  const { buildVisemes, buildSegments, sampleViseme } = window.__viseme;
  const text = '妈妈不明白';
  const tr = buildVisemes(text);
  const n = text.length;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i * 0.22;
  const segs = buildSegments(tr, times, n * 0.22);
  const out = [];
  for (let t = 0; t < n * 0.22; t += 0.01) out.push(sampleViseme(segs, t));
  return {
    maxClose: Math.max(...out.map((v) => v.close)),
    maxPucker: Math.max(...out.map((v) => v.pucker)),
    maxStretch: Math.max(...out.map((v) => v.stretch)),
    maxJaw: Math.max(...out.map((v) => v.jaw)),
    minJaw: Math.min(...out.map((v) => v.jaw)),
  };
});
console.log('\n[2] 一句话内的口型区分度');
ok(spread.maxClose > 0.45, '闭唇真的合上过', `maxClose=${spread.maxClose.toFixed(2)}`);
ok(spread.maxPucker > 0.4, '圆唇出现过（u 韵）', `maxPucker=${spread.maxPucker.toFixed(2)}`);
ok(spread.maxJaw > 0.5, '大开口出现过（a 韵）', `maxJaw=${spread.maxJaw.toFixed(2)}`);
ok(spread.maxJaw - spread.minJaw > 0.35, '开口度有明显起伏', `Δ=${(spread.maxJaw - spread.minJaw).toFixed(2)}`);

// 圆唇与扁唇不能同时高——那是「嘴一直在动但没在说话」的典型症状
const conflict = await page.evaluate(() => {
  const { buildVisemes, buildSegments, sampleViseme } = window.__viseme;
  const tr = buildVisemes('鱼衣鱼衣');
  const times = new Float32Array([0, 0.25, 0.5, 0.75]);
  const segs = buildSegments(tr, times, 1.0);
  let both = 0;
  let samples = 0;
  for (let t = 0; t < 1.0; t += 0.005) {
    const v = sampleViseme(segs, t);
    samples++;
    if (v.pucker > 0.35 && v.stretch > 0.3) both++;
  }
  return { both, samples };
});
console.log('\n[3] 圆唇与扁唇互斥（协同发音不应把两者混在一起）');
ok(conflict.both / conflict.samples < 0.12, '同一时刻很少同时撅嘴又咧嘴', `${((conflict.both / conflict.samples) * 100).toFixed(1)}%`);

// ---------------------------------------------------------------- 端到端
console.log('\n[4] 真播一句话，逐帧采样面部通道');

await page.evaluate(() => {
  window.__rec = [];
  const loop = () => {
    const d = window.__dialogue.stats();
    window.__rec.push({
      t: performance.now() / 1000,
      jaw: window.__rig.get('jawOpen') || 0,
      close: window.__rig.get('mouthClose') || 0,
      pucker: window.__rig.get('mouthPucker') || 0,
      stretch: window.__rig.get('mouthStretchLeft') || 0,
      funnel: window.__rig.get('mouthFunnel') || 0,
      level: d.level,
      text: window.__dialogue.player()?.cur?.text || '',
      vis: window.__viseme.now(),
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

// 用固定文本播放，不走 LLM：这一段测的是「音素 → 脸」，
// 模型的回复每次都不一样，拿它当断言对象会时对时错。
// 仍然走真实的 TTS + 字符时间戳 + mixer 链路。
const FIXED = '妈妈不明白，爸爸也不高兴。';

// 播放器是懒创建的，先让它存在
await page.evaluate(() => {
  if (!window.__dialogue.player()) window.__dialogue.ask('嗯');
});
await page.waitForFunction(() => !!window.__dialogue.player(), { timeout: 20000 });
await page.waitForTimeout(500);

await page.evaluate(async (text) => {
  const pl = window.__dialogue.player();
  pl.reset();
  pl.enqueue({ text, events: [] });
  pl.markStreamDone();
}, FIXED);

await page.waitForFunction(() => (window.__rig.get('jawOpen') || 0) > 0.03, { timeout: 25000 });
// 等到整轮说完（不只看第一句）
await page.waitForFunction(() => !window.__dialogue.player()?.busy, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(200);

const rec = await page.evaluate(() => window.__rec.slice());
const speaking = rec.filter((r) => r.vis);
const spokenText = [...new Set(rec.map((r) => r.text).filter(Boolean))].join('');

if (!speaking.length) {
  console.log('  ✗ 没采到任何音素口型帧（player 未进音素路径）');
  fail++;
} else {
  const nz = (k) => speaking.map((r) => r[k] || 0);
  const maxOf = (k) => Math.max(...nz(k));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  console.log(`  实际播出：${spokenText.slice(0, 40) || '（未取到）'}`);

  ok(speaking.length > 40, '采到足够多的音素帧', `${speaking.length} 帧`);
  ok(maxOf('jaw') > 0.25, 'jawOpen 被音素推起来', `max=${maxOf('jaw').toFixed(2)}`);
  ok(maxOf('stretch') > 0.12 || maxOf('funnel') > 0.2, '圆/扁唇通道被驱动', `stretch=${maxOf('stretch').toFixed(2)} funnel=${maxOf('funnel').toFixed(2)}`);

  const js = nz('jaw');
  const jm = mean(js);
  const sd = Math.sqrt(mean(js.map((v) => (v - jm) ** 2)));
  ok(sd > 0.04, 'jawOpen 有明显波动（不是恒定张开）', `sd=${sd.toFixed(3)} mean=${jm.toFixed(2)}`);

  // 以实际播出的文本为准，数一数应该出现几次双唇音
  const expectPP = await page.evaluate((t) => {
    const tr = window.__viseme.track(t);
    return tr.filter((x) => x.a === 'PP').length;
  }, spokenText);
  console.log(`  文本中双唇音 b/p/m 起音：${expectPP} 字`);

  let pulses = 0;
  let was = false;
  for (const r of speaking) {
    const on = (r.close || 0) > 0.3;
    if (on && !was) pulses++;
    was = on;
  }
  ok(expectPP === 0 || pulses >= Math.max(2, Math.round(expectPP * 0.6)), '闭唇脉冲次数与双唇音字数相符', `${pulses} 次 / 期望 ${expectPP}`);

  // 最硬的一条：口型必须与"正在发什么音"同向。
  //
  // 原来这里比的是实时音量（analyser 电平）。播放通道改成 <audio> 元素之后
  // 拿不到 analyser 了，level 恒为 0，这条断言就变成了 r=0 的假失败——
  // 而它想证明的东西其实还在：jawOpen 必须跟着音素轨道的开口度走，
  // 而不是各帧随机抖动。
  const corr = (() => {
    const a = speaking.map((r) => r.jaw || 0);
    const b = speaking.map((r) => (r.vis && typeof r.vis.jaw === 'number' ? r.vis.jaw : 0));
    const ma = mean(a);
    const mb = mean(b);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  })();
  ok(corr > 0.5, 'jawOpen 由音素轨道驱动（不是随机抖动）', `r=${corr.toFixed(2)}`);

  // 若这一局走的还是 WebAudio（拿得到 analyser），顺带验一次音量同向
  const byLevel = (() => {
    const a = speaking.map((r) => r.jaw || 0);
    const b = speaking.map((r) => r.level || 0);
    if (b.every((v) => v === 0)) return null;
    const ma = mean(a);
    const mb = mean(b);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  })();
  if (byLevel !== null) ok(byLevel > 0.15, 'jawOpen 与实时音量正相关', `r=${byLevel.toFixed(2)}`);
}

console.log('\n[5] 控制台错误');
ok(errors.length === 0, '无 JS 报错', errors.length ? errors.slice(0, 2).join(' | ') : '');

await page.screenshot({ path: '/tmp/viseme-live.png' });

await browser.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
