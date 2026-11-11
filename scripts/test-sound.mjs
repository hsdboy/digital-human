/**
 * 声音链路验收。
 *
 * 之前所有测试都在 headless 里跑，用的还是 `--autoplay-policy=no-user-gesture-required`，
 * 等于把浏览器最容易被卡住的那一环（自动播放授权）整个绕过去了。
 * 这个脚本专门测三件事：
 *
 *   1. 正常路径：真点击发送 → ctx running → 有电平 → 有 source
 *   2. 兜底路径：decodeAudioData 抛错时，能不能退回 <audio> 播放
 *   3. 自检：页内「试听」按钮能否读出电平，并在被拦时给出可读的原因
 *
 * 不传 autoplay 放行参数，尽量贴近用户真实环境。
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5173';
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
page.on('pageerror', (e) => console.log('  ! pageerror', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await page.waitForTimeout(700);

// ---------------------------------------------------------------- 1 正常路径
console.log('\n[1] 正常路径（真点击发送）');

const before = await page.evaluate(() => ({
  ctx: window.__dialogue.voice.ctx,
  mode: window.__dialogue.voice.mode,
}));
ok(before.ctx === null, '未交互前不建 AudioContext（不浪费授权机会）', `mode=${before.mode}`);

await page.fill('#ask', '你好');
await page.click('#send');
await page.waitForTimeout(300);

const afterClick = await page.evaluate(() => {
  const v = window.__dialogue.voice;
  return { state: v.ctx ? v.ctx.state : null, mode: v.mode, diag: v.diag.state };
});
ok(!!afterClick.state, '点击后 AudioContext 已创建', `state=${afterClick.state}`);
ok(afterClick.mode !== 'none', '播放通道已判定', `mode=${afterClick.mode}`);

// 等到真的开口
const spoke = await page
  .waitForFunction(
    () => {
      const pl = window.__dialogue.player();
      return pl && pl.cur && pl.cur.started;
    },
    { timeout: 30000 }
  )
  .then(() => true)
  .catch(() => false);
ok(spoke, '有 segment 真的开播');

if (spoke) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => {
    const v = window.__dialogue.voice;
    const pl = window.__dialogue.player();
    const c = pl.cur;
    return {
      mode: v.mode,
      state: v.ctx ? v.ctx.state : null,
      level: v.level,
      hasSource: !!(c && c.source),
      silent: !!(c && c.silent),
      buffer: !!(c && c.audio && c.audio.buffer),
      url: !!(c && c.audio && c.audio.url),
      ctxNow: v.ctx ? v.ctx.currentTime : null,
      voiceNow: v.now,
      startAt: c ? c.startAt : null,
      decodeErr: v.diag.decodeErr,
    };
  });
  ok(s.state === 'running', 'AudioContext 处于 running', `state=${s.state}`);
  ok(s.hasSource, '已创建音源节点');
  ok(s.buffer, 'WAV 被成功解码成 AudioBuffer');
  ok(!s.decodeErr, '解码没有报错', s.decodeErr || '');
  ok(s.level > 0.05, '实时电平非零（声音确实在流）', `level=${s.level.toFixed(3)}`);
  ok(Math.abs(s.voiceNow - s.ctxNow) < 0.05, '时钟取自声卡（不随主循环漂移）', `ctx=${s.ctxNow?.toFixed(2)} voice=${s.voiceNow.toFixed(2)}`);
}

// ---------------------------------------------------------------- 2 自检按钮
console.log('\n[2] 试听自检');

await page.waitForFunction(() => window.__dialogue.stats().state === 'idle', { timeout: 40000 }).catch(() => {});
await page.click('#sndtest');
await page.waitForTimeout(900);
const ping = await page.evaluate(() => ({
  label: document.getElementById('sndtest').textContent,
  lat: document.getElementById('lat').textContent,
}));
ok(/有声|无声/.test(ping.label), '试听按钮给出结论', `按钮=${ping.label}`);
ok(/声音：/.test(ping.lat), '延时栏显示可读的诊断', ping.lat);

// ---------------------------------------------------------------- 3 兜底路径
console.log('\n[3] decodeAudioData 失败时的兜底');

const page2 = await browser.newPage({ viewport: { width: 1100, height: 780 } });
// 在页面脚本运行前就把解码打成失败，模拟内嵌 webview 挑食 WAV
await page2.addInitScript(() => {
  const orig = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function (...a) {
    return Promise.reject(new Error('mock: 不支持的 WAV 头'));
  };
  window.__decodePatched = true;
  return orig;
});
await page2.goto(URL, { waitUntil: 'load' });
await page2.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await page2.waitForTimeout(600);

await page2.fill('#ask', '你好');
await page2.click('#send');

const started2 = await page2
  .waitForFunction(
    () => {
      const pl = window.__dialogue.player();
      return pl && pl.cur && pl.cur.started;
    },
    { timeout: 30000 }
  )
  .then(() => true)
  .catch(() => false);

ok(started2, '解码失败时链路没有中断（仍能开播）');
if (started2) {
  await page2.waitForTimeout(400);
  const s2 = await page2.evaluate(() => {
    const v = window.__dialogue.voice;
    const pl = window.__dialogue.player();
    const c = pl.cur;
    return {
      mode: v.mode,
      decodeErr: v.diag.decodeErr,
      buffer: !!(c && c.audio && c.audio.buffer),
      url: !!(c && c.audio && c.audio.url),
      hasSource: !!(c && c.source),
      silent: !!(c && c.silent),
    };
  });
  ok(!!s2.decodeErr, '记录了解码失败原因', s2.decodeErr || '');
  ok(s2.mode === 'element', '自动切到 <audio> 兜底通道', `mode=${s2.mode}`);
  ok(s2.url, '保留了 WAV 的 URL（兜底要用）');
  ok(s2.hasSource, '兜底通道也创建了播放句柄');
  ok(!s2.silent, '没有误判成静音片段（那样才是真的没声音）');
}

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
