/**
 * 管线自测：不依赖浏览器，直接验证「标签解析 → 切句 → 话语时钟」。
 *
 * 重点验证三件事：
 *  1. 标签被任意切断时，可见文本不受污染、事件偏移不漂移
 *  2. 畸形标签不会显示给用户
 *  3. 事件在正确的字符位置触发（这是"表情对上话"的唯一判据）
 */

import { TagParser, stripTags } from '../src/tags.js';
import { Segmenter, UtterancePlayer } from '../src/timeline.js';
import { buildCharTimes, indexAt } from '../src/audio.js';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function eq(name, a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  ok(name, sa === sb, `${sa} ≠ ${sb}`);
}

/** 按固定步长切块喂入，模拟 token 流 */
function feed(str, step) {
  const p = new TagParser();
  const evs = [];
  let text = '';
  for (let i = 0; i < str.length; i += step) {
    const r = p.push(str.slice(i, i + step));
    text += r.text;
    evs.push(...r.events);
  }
  const tail = p.flush();
  text += tail.text;
  return { text, evs, parser: p };
}

// ---------- 1. 基本解析 + 偏移 ----------
{
  const src = '今天天气真不错<e:joy:0.8><g:camera>，要不要出去走走<m:brow:0.3>？';
  const want = '今天天气真不错，要不要出去走走？';
  for (const step of [1, 2, 3, 5, 7, 100]) {
    const { text, evs } = feed(src, step);
    ok(`可见文本干净（步长${step}）`, text === want, text);
    eq(
      `事件偏移（步长${step}）`,
      evs.map((e) => [e.ev.type, e.charOffset]),
      [
        ['expr', 7],
        ['gaze', 7],
        ['micro', 15],
      ]
    );
  }
  const { evs } = feed(src, 3);
  eq(
    '事件参数',
    evs.map((e) => [e.ev.name, e.ev.intensity, e.ev.target, e.ev.part]),
    [
      ['joy', 0.8, null, null],
      [null, null, 'camera', null],
      [null, 0.3, null, 'brow'],
    ]
  );
}

// ---------- 2. 偏移必须指向正确的字 ----------
{
  const src = '我很开心<e:joy:0.9>真的';
  const { text, evs } = feed(src, 2);
  eq('偏移落在标签位置', evs[0].charOffset, text.indexOf('真'));
}

// ---------- 3. 畸形标签 ----------
{
  // 全角冒号
  let r = feed('好啊<e：joy：0.7>', 2);
  eq('全角冒号', [r.text, r.evs.length, r.evs[0]?.ev.name], ['好啊', 1, 'joy']);

  // 强度写在前面
  r = feed('算了<e:0.7:sadness>', 1);
  eq('强度在前', [r.text, r.evs[0]?.ev.name, r.evs[0]?.ev.intensity], ['算了', 'sadness', 0.7]);

  // 自创名字：丢弃且不可见
  r = feed('我饿了<e:hungry:0.5>你知道吗', 2);
  eq('未知表情被丢弃', r.text, '我饿了你知道吗');

  // 缺强度：用默认值
  r = feed('哈<e:joy>', 1);
  eq('缺强度取默认', [r.text, r.evs[0]?.ev.intensity], ['哈', 0.6]);

  // 不闭合：流结束时丢弃残片
  r = feed('说到一半<e:joy', 1);
  eq('未闭合标签不入正文', r.text, '说到一半');

  // 真的不像标签的内容要保留
  r = feed('3 < 5 且 7 > 2', 2);
  ok('非标签的尖括号保留', r.text.includes('< 5 且 7 >'), r.text);

  // 表情强度钳制
  r = feed('<e:joy:5>', 1);
  eq('强度钳制到 1', r.evs[0]?.ev.intensity, 1);
}

// ---------- 4. 切句 + 偏移重定基 ----------
{
  const src = '你好<e:joy:0.6>，今天怎么样<e:thinking:0.4>？明天呢<e:joy:0.5>。';
  const p = new TagParser();
  const segs = [];
  const seg = new Segmenter((s) => segs.push(s));
  const r = p.push(src);
  seg.push(r.text, r.events);
  const t = p.flush();
  seg.push(t.text, t.events);
  seg.flush();

  eq('切出 2 句', segs.length, 2);
  eq('第 1 句文本', segs[0]?.text, '你好，今天怎么样？');
  eq(
    '第 1 句事件本地偏移',
    segs[0]?.events.map((e) => [e.ev.type, e.charOffset]),
    [
      ['expr', 2],
      ['expr', 8],
    ]
  );
  eq('第 2 句文本', segs[1]?.text, '明天呢。');
  eq('第 2 句偏移已重定基', segs[1]?.events.map((e) => e.charOffset), [3]);
}

// ---------- 5. 长句必须硬切，否则第一句憋不出声 ----------
{
  const long = '啊'.repeat(200);
  const segs = [];
  const seg = new Segmenter((s) => segs.push(s));
  seg.push(long, []);
  seg.flush();
  ok('长句被切分', segs.length >= 2, `段数 ${segs.length}`);
  ok('单段不超过硬上限', segs.every((s) => s.text.length <= 90), `最长 ${Math.max(...segs.map((s) => s.text.length))}`);
}

// ---------- 6. 话语时钟：事件必须在正确字符处触发 ----------
{
  const player = new UtterancePlayer({ baseRate: 30 });
  const fired = [];
  let revealed = '';
  player.onReveal = (c) => (revealed += c);
  player.onEvent = (ev) => fired.push({ ev, at: revealed.length });

  player.enqueue({
    text: '我很开心真的',
    events: [{ charOffset: 3, ev: { type: 'expr', name: 'joy', intensity: 0.9 } }],
  });
  player.enqueue({
    text: '但是也有点担心。',
    events: [{ charOffset: 6, ev: { type: 'micro', part: 'brow', intensity: 1 } }],
  });
  player.markStreamDone();

  let t = 0;
  for (let i = 0; i < 400 && (!player.idleNotified || player.busy); i++) {
    t += 1 / 60;
    player.update(t);
  }

  eq('全部文本揭示完', revealed, '我很开心真的但是也有点担心。');
  eq('触发 2 个事件', fired.length, 2);
  eq('表情落在第 3 字之后', fired[0]?.at, 3);
  eq('微表情落在第 6 字之后', fired[1]?.at, 12);
  ok('表情有维持时长', (fired[0]?.ev.hold || 0) > 0.5, `hold=${fired[0]?.ev.hold}`);
  ok('结束后进入 idle', player.idleNotified === true);
}

// ---------- 7. 打断 ----------
{
  const player = new UtterancePlayer({ baseRate: 20 });
  player.enqueue({ text: '一二三四五六七八九十', events: [] });
  let n = 0;
  player.onReveal = () => n++;
  for (let i = 0; i < 10; i++) player.update(i / 60);
  ok('打断前在推进', n > 0);
  player.reset();
  const before = n;
  for (let i = 10; i < 40; i++) player.update(i / 60);
  eq('打断后不再推进', n, before);
}

// ---------- 8. 字符时间映射（音频时钟的基础） ----------
{
  // 稀疏标记：只在部分字上有真实时刻，其余插值
  const t = buildCharTimes(6, [{ at: 0, t: 0 }, { at: 4, t: 1.0 }], 2.0);
  eq('插值：首字在 0', t[0], 0);
  eq('插值：中间线性', [+t[1].toFixed(3), +t[2].toFixed(3), +t[3].toFixed(3)], [0.25, 0.5, 0.75]);
  eq('插值：标记点命中', t[4], 1.0);
  eq('插值：标记之后保持', t[5], 1.0);

  // 没有标记时退化为均匀分布
  const u = buildCharTimes(5, [], 2.5);
  eq('无标记均匀分布', [+u[0].toFixed(2), +u[4].toFixed(2)], [0, 2]);

  // 乱序标记必须容忍
  const r = buildCharTimes(3, [{ at: 2, t: 1 }, { at: 0, t: 0 }], 1.5);
  eq('乱序标记自动排序', [+r[0].toFixed(2), +r[2].toFixed(2)], [0, 1]);

  // indexAt：pos 落在第几个字之后
  const times = Float32Array.from([0, 0.2, 0.4, 0.9]);
  eq('indexAt(0)', indexAt(times, 0), 1);
  eq('indexAt(0.19)', indexAt(times, 0.19), 1);
  eq('indexAt(0.21)', indexAt(times, 0.21), 2);
  eq('indexAt(5)', indexAt(times, 5), 4);
}

// ---------- 9. stripTags ----------
eq('stripTags', stripTags('你好<e:joy:0.5>啊<g:away>。'), '你好啊。');

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
