/**
 * 记忆层：让她记得你。
 *
 * 现在每轮对话都是"初次见面"——history 只带最近 9 条，刷新就归零。
 * 真人感的很大一块来自「不用每次重新介绍自己」。
 *
 * 分两层，成本完全不同：
 *   ① 短期：最近几轮原文（已有，由 dialogue 的 history 负责）
 *   ② 长期：关于用户的事实（名字、职业、住哪、喜欢什么、最近发生的事）
 *
 * 长期层用规则抽取而不是让模型总结：模型抽取要多一次请求、多几百毫秒，
 * 而且 7B 会编。规则覆盖不了的部分宁可不记，也别记错——
 * 记错比不记伤人得多（"你不是说你做设计吗"）。
 */

const MAX = 14;
const KEY = 'xiaoman.facts.v1';

/** 类别 -> 抽取规则。同一类别只保留最新一条。 */
const RULES = [
  { k: 'name', re: /我(?:的名字)?叫([\u4e00-\u9fffA-Za-z]{1,6})/, fmt: (m) => `用户叫${m[1]}` },
  { k: 'job', re: /我(?:是|在做|在干)(?:一)?(?:个)?(做|干|搞)?([^\s，。！？、]{2,12})(?:的|工作|这一行)/, fmt: (m) => `用户是做${m[2]}的` },
  { k: 'company', re: /我在([^\s，。！？、]{2,12})(?:工作|上班|实习|干活)/, fmt: (m) => `用户在「${m[1]}」` },
  // 中文经常省主语（"我叫阿泽，在杭州做前端"），所以允许句首/逗号后直接接地点，
  // 但必须带方位动词，否则"在北京做"和"他吃在北京"分不开
  { k: 'city', re: /(?:^|[，,。；;]|我)(?:住在|搬到|在)([\u4e00-\u9fff]{2,6})(?:住|生活|做|干|上班|工作)/, fmt: (m) => `用户常驻${m[1]}` },
  { k: 'job', re: /我(?:在[\u4e00-\u9fff]{2,6})?(?:做|干|搞)([\u4e00-\u9fffA-Za-z+#]{2,10}?)(?:的|，|。|$|这一行|工作)/, fmt: (m) => `用户是做${m[1]}的` },
  { k: 'job', re: /我(?:是|当)([\u4e00-\u9fff]{2,6}?)(?:工程师|设计师|老师|医生|程序员|运营|销售)/, fmt: (m) => `用户是做${m[1]}的` },
  { k: 'age', re: /我(?:今年)?(\d{2})岁/, fmt: (m) => `用户${m[1]}岁` },
  { k: 'like', re: /我(?:特别|很|挺)?(?:喜欢|爱|迷上)(?:了)?([^\s，。！？、]{1,10})/, fmt: (m) => `用户喜欢${m[1]}` },
  { k: 'hate', re: /我(?:特别|很|挺)?(?:讨厌|不喜欢|受不了|烦)([^\s，。！？、]{1,10})/, fmt: (m) => `用户不喜欢${m[1]}` },
  { k: 'pet', re: /我(?:养|有)(?:了)?(?:一只|一个|只)?([^\s，。！？、]{1,8})(?:猫|狗)/, fmt: (m) => `用户养了${m[1]}` },
  {
    k: 'event',
    re: /我(?:今天|昨天|最近|刚刚|上周)?(升职|辞职|离职|分手|结婚|订婚|考试|面试|搬家|被裁|毕业|拿到offer)/,
    fmt: (m) => `${new Date().getMonth() + 1}月${new Date().getDate()}日：用户${m[1]}`,
    keep: true,
  },
];

/** 这些类别只留最新一条（"我叫什么"不会有两个答案） */
const SINGLE = new Set(['name', 'job', 'company', 'city', 'age']);

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* 隐私模式 / 配额满：记忆是增强项，不该让对话崩掉 */
  }
}

export class Memory {
  constructor() {
    this.items = read();
    /** 本回合新学到的，界面可以拿去做个"记下了"的提示 */
    this.learnedNow = [];
  }

  get facts() {
    return this.items.map((i) => i.text);
  }

  /**
   * 从用户的话里抽事实。
   * 返回本次新增的条目（供 UI 提示）。
   */
  learn(text) {
    const s = String(text || '');
    const got = [];
    for (const r of RULES) {
      const m = s.match(r.re);
      if (!m) continue;
      const entry = { k: r.k, text: r.fmt(m), t: Date.now() };
      const same = this.items.findIndex((i) => i.k === r.k && (SINGLE.has(r.k) || i.text === entry.text));
      if (same >= 0) {
        // 单值类别更新；多值类别重复则不重复记
        if (SINGLE.has(r.k)) this.items[same] = entry;
        else continue;
      } else {
        this.items.push(entry);
      }
      got.push(entry.text);
    }
    if (got.length) {
      // 事件类不设上限地塞会挤掉基本信息，这里只保最近 5 条事件
      const events = this.items.filter((i) => i.k === 'event');
      if (events.length > 5) {
        const drop = new Set(events.slice(0, events.length - 5));
        this.items = this.items.filter((i) => !drop.has(i));
      }
      write(this.items);
      this.learnedNow = got;
    }
    return got;
  }

  clear() {
    this.items = [];
    write(this.items);
  }
}
