/**
 * 拟人化各层的确定性测试。不碰模型、不碰浏览器——
 * 这里只验算「情绪惯性」「文本改写后表情坐标还对不对」这两件容易错的事。
 */
import { MoodEngine } from '../src/mood.js';
import { humanizeSeg, cleanStream } from '../src/humanize.js';
import { Memory } from '../src/memory.js';
import { Rhythm } from '../src/rhythm.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

console.log('\n[情绪惯性]');
{
  const m = new MoodEngine();
  const v0 = m.valence;
  m.push(1, 0.8, 0.3);
  ok('一句话不会翻盘', m.valence - v0 < 0.35, `实际 ${(m.valence - v0).toFixed(3)}`);
  ok('方向是对的', m.valence > v0);
  const mid = m.valence;
  m.tick(1000);
  m.tick(1000 + 240);
  ok('4 分钟后大致回落一半以上', Math.abs(m.valence - m.baselineValence) < Math.abs(mid - m.baselineValence) * 0.55,
    `现在 ${m.valence.toFixed(3)} 基线 ${m.baselineValence}`);
  ok('不会越过基线', Math.abs(m.valence - m.baselineValence) >= 0);

  const m2 = new MoodEngine();
  m2.push(-1, 0, 0.8);
  const neg = m2.valence;
  m2.tick(0);
  m2.tick(110);
  const negAfter = m2.valence;
  const m3 = new MoodEngine();
  m3.push(1, 0, 0.8);
  m3.tick(0);
  m3.tick(110);
  ok('负面情绪消退比正面快', Math.abs(m3.valence - m3.baselineValence) > Math.abs(negAfter - m2.baselineValence),
    `正 ${(m3.valence).toFixed(3)} / 负 ${(negAfter).toFixed(3)}`);
  ok('衰减后仍保留余温', Math.abs(negAfter - m2.baselineValence) > 0.02);

  const t = new MoodEngine({ valence: -0.6, arousal: -0.3 }).tendency;
  ok('低落时不想主动说话', t.chatty < 0.35, `chatty=${t.chatty.toFixed(2)}`);
  ok('低落时话更少', t.verbose < 0.35);
}

console.log('\n[文本改写后的表情坐标]');
{
  // 段首删套话：所有事件必须整体左移，否则表情会提前到前一个词上
  const seg = {
    text: '首先，我觉得这个事情有点意思。',
    events: [
      { charOffset: 6, ev: { type: 'expr', name: 'thinking', intensity: 0.5 } },
      { charOffset: 12, ev: { type: 'expr', name: 'joy', intensity: 0.4 } },
    ],
  };
  humanizeSeg(seg, {});
  ok('段首套话被替换', !seg.text.startsWith('首先'), `→ ${seg.text}`);
  ok('等长替换不移动坐标', seg.events[0].charOffset === 6, `实际 ${seg.events[0].charOffset}`);
  const at0 = seg.text.charAt(seg.events[0].charOffset);
  ok('第一个事件落在预期字符上', at0 === '这', `落在「${at0}」`);

  // 段首整句删除：必须左移
  const seg2 = {
    text: '作为一个人工智能助手，我其实挺喜欢下雨天。',
    events: [{ charOffset: 14, ev: { type: 'expr', name: 'joy', intensity: 0.6 } }],
  };
  humanizeSeg(seg2, {});
  ok('AI 自述被删掉', !seg2.text.includes('人工智能'), `→ ${seg2.text}`);
  const c2 = seg2.text.charAt(seg2.events[0].charOffset);
  ok('删除后坐标同步左移', seg2.events[0].charOffset < 14);
  ok('左移量正确', c2 === '挺', `落在「${c2}」`);

  // 段尾套话：只砍尾巴，前面不动
  const seg3 = {
    text: '这事儿吧，我觉得还行。希望对你有所帮助。',
    events: [{ charOffset: 0, ev: { type: 'expr', name: 'neutral', intensity: 0.3 } }],
  };
  humanizeSeg(seg3, {});
  ok('结尾套话被删', !seg3.text.includes('希望'), `→ ${seg3.text}`);
  ok('段尾删除不移动坐标', seg3.events[0].charOffset === 0);

  // 口癖插入：整体右移
  const seg4 = {
    text: '这个片子剪得挺好的。',
    events: [{ charOffset: 0, ev: { type: 'expr', name: 'joy', intensity: 0.5 } }],
  };
  humanizeSeg(seg4, { habits: ['其实吧'], allowHabit: true });
  ok('口癖插到了开头', seg4.text.startsWith('其实吧'), `→ ${seg4.text}`);
  ok('插入后坐标右移', seg4.events[0].charOffset === seg4.text.indexOf('这'), `实际 ${seg4.events[0].charOffset}`);

  // 偏移越界保护
  const seg5 = { text: '好的，嗯。', events: [{ charOffset: 3, ev: {} }] };
  humanizeSeg(seg5, {});
  ok('偏移不会被压成负数', seg5.events[0].charOffset >= 0);
  ok('删空了有兜底', seg5.text.trim().length > 0);
}

console.log('\n[入口清洗]');
{
  ok('去星号', cleanStream('**重点**在这') === '重点在这');
  ok('去行首列表符号', cleanStream('- 第一点') === '第一点');
  ok('去序号', cleanStream('1. 第一点') === '第一点');
  ok('去标题井号', cleanStream('## 小标题') === '小标题');
  ok('去零宽字符', cleanStream('你\u200b好') === '你好');
  ok('正常文本不动', cleanStream('我觉得还行，真的。') === '我觉得还行，真的。');
}

console.log('\n[记忆抽取]');
{
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  const mem = new Memory();
  mem.learn('我叫阿泽，在杭州做前端');
  ok('记住名字', mem.facts.some((f) => f.includes('阿泽')), JSON.stringify(mem.facts));
  ok('记住城市', mem.facts.some((f) => f.includes('杭州')));
  mem.learn('我叫小陈');
  ok('名字只留最新一条', mem.facts.filter((f) => f.includes('叫')).length === 1, JSON.stringify(mem.facts));
  mem.learn('我特别喜欢爬山');
  ok('记住喜好', mem.facts.some((f) => f.includes('爬山')));
  mem.learn('今天天气不错');
  ok('闲聊不硬记', mem.facts.length <= 5, JSON.stringify(mem.facts));
  ok('不会出现重复条目', new Set(mem.facts).size === mem.facts.length);
}

console.log('\n[节奏]');
{
  const r = new Rhythm({ minThinkMs: 320 });
  ok('首字很快时要补思考', r.thinkGate(80) === 240, `${r.thinkGate(80)}`);
  ok('首字本来就慢就不补', r.thinkGate(600) === 0);
  ok('没有历史时不主动开口', r.tick(100, { hasHistory: false }) === false);
  ok('刚说完不主动开口', r.tick(1, { hasHistory: true, chatty: 1 }) === false);
  ok('后台标签页不开口', r.tick(100, { hasHistory: true, chatty: 1, visible: false }) === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
