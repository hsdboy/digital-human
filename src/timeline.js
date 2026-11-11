/**
 * 话语时间轴。
 *
 * 为什么不能"文本一到就动脸"：
 * 模型吐 token 的速度是 20~60 token/s 且抖动极大，还经常在句末憋一下。
 * 如果表情跟着 token 走，脸会变成抽搐的随机闪烁器——这是数字人最典型的失败。
 *
 * 所以这里引入一个「话语时钟」：
 *   文本不是到达即显示，而是按接近真人的语速逐字揭示；
 *   表情事件按它在句子里的字符偏移，挂在同一个时钟上。
 * 结果：表情永远落在那个词被"说出来"的瞬间，跟模型生成快慢完全解耦。
 *
 * P3 接 TTS 时，把 advance() 的时间源换成 audioContext.currentTime，
 * 把 reveal 的速率换成音素时间戳，下游调度逻辑一行都不用改。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SENTENCE_END = '。！？!?…\n';
const TRAILING = '”"’\')）】」》';

/**
 * 把流式文本切成"可说的片段"。
 * 切在句末标点；过长时退化到逗号；再长就硬切，避免第一句憋太久不出声。
 */
export class Segmenter {
  constructor(onSegment, { maxLen = 34, hardLen = 60 } = {}) {
    this.onSegment = onSegment;
    this.maxLen = maxLen;
    this.hardLen = hardLen;
    this.text = '';
    this.events = [];
    this.base = 0;
  }

  push(text, events) {
    if (text) this.text += text;
    if (events && events.length) this.events.push(...events);
    let cut;
    let guard = 0;
    while ((cut = this._cut()) > 0 && guard++ < 32) this._emit(cut);
  }

  _cut() {
    const t = this.text;
    if (!t) return -1;
    for (let i = 0; i < t.length; i++) {
      if (SENTENCE_END.includes(t[i])) {
        let j = i + 1;
        while (j < t.length && TRAILING.includes(t[j])) j++;
        return j;
      }
    }
    if (t.length >= this.maxLen) {
      const i = Math.max(t.lastIndexOf('，'), t.lastIndexOf('、'));
      if (i > 9) return i + 1;
      if (t.length >= this.hardLen) return this.hardLen;
    }
    return -1;
  }

  _emit(cut) {
    const segText = this.text.slice(0, cut);
    if (!segText.trim()) {
      this.text = this.text.slice(cut);
      this.base += cut;
      return;
    }
    const limit = this.base + cut;
    const local = [];
    const rest = [];
    for (const e of this.events) {
      if (e.charOffset < limit) local.push({ charOffset: e.charOffset - this.base, ev: e.ev });
      else rest.push(e);
    }
    local.sort((a, b) => a.charOffset - b.charOffset);
    this.text = this.text.slice(cut);
    this.base += cut;
    this.events = rest;
    this.onSegment({ text: segText, events: local });
  }

  flush() {
    if (this.text.trim()) this._emit(this.text.length);
    else {
      this.text = '';
      this.events = [];
    }
  }
}

/**
 * 话语播放器：持有唯一的时间轴，逐字揭示文本并按偏移触发事件。
 *
 * 语速不是固定的：队列积压越多，读得越快（最多 1.7 倍），
 * 这样模型短时间吐一大段也不会让脸落后十几秒。
 */
export class UtterancePlayer {
  constructor(opts = {}) {
    this.onReveal = opts.onReveal || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onIdle = opts.onIdle || (() => {});
    this.onSegmentStart = opts.onSegmentStart || (() => {});
    this.baseRate = opts.baseRate || 4.8; // 字/秒，接近中文口语 280 字/分

    this.queue = [];
    this.cur = null;
    this.revealed = 0;
    this.revealedInt = 0;
    this.lastNow = null;
    this.pauseUntil = 0;
    this.streamDone = false;
    this.idleNotified = true;
    this.segmentsPlayed = 0;
    this.eventCount = 0;
  }

  reset() {
    this.queue.length = 0;
    this.cur = null;
    this.revealed = 0;
    this.revealedInt = 0;
    this.lastNow = null;
    this.pauseUntil = 0;
    this.streamDone = false;
    this.idleNotified = true;
  }

  enqueue(seg) {
    if (!seg || !seg.text) return;
    this.queue.push(seg);
    this.idleNotified = false;
  }

  markStreamDone() {
    this.streamDone = true;
  }

  get backlog() {
    let n = this.cur ? Math.max(0, this.cur.text.length - this.revealedInt) : 0;
    for (const s of this.queue) n += s.text.length;
    return n;
  }

  /** 正在发字（嘴该动） */
  get articulating() {
    return !!this.cur && this.revealedInt < this.cur.text.length;
  }

  get busy() {
    return this.articulating || this.queue.length > 0;
  }

  update(now) {
    if (this.lastNow === null) this.lastNow = now;
    // now 单位是秒（调用方传 performance.now()/1000）
    let dt = now - this.lastNow;
    this.lastNow = now;
    dt = clamp(dt, 0, 0.1);

    if (now < this.pauseUntil) return;

    if (!this.cur) {
      if (this.queue.length) {
        this.cur = this.queue.shift();
        this.cur.evIdx = 0;
        this.revealed = 0;
        this.revealedInt = 0;
        this.segmentsPlayed++;
        this.onSegmentStart(this.cur);
      } else {
        if (this.streamDone && !this.idleNotified) {
          this.idleNotified = true;
          this.onIdle();
        }
        return;
      }
    }

    // 积压越多读越快，最多 1.7 倍
    const rate = this.baseRate * clamp(1 + this.backlog / 42, 0.85, 1.7);
    this.revealed = Math.min(this.revealed + rate * dt, this.cur.text.length);
    const upto = Math.floor(this.revealed);

    if (upto > this.revealedInt) {
      this.onReveal(this.cur.text.slice(this.revealedInt, upto), this.cur);
      this.revealedInt = upto;
    }

    // 触发到点的事件。hold 表示这个表情该维持多久（到下一个表情或句末）
    const evs = this.cur.events;
    while (this.cur.evIdx < evs.length && evs[this.cur.evIdx].charOffset <= this.revealedInt) {
      const item = evs[this.cur.evIdx++];
      const ev = item.ev;
      if (ev.type === 'expr') {
        let end = this.cur.text.length;
        for (let k = this.cur.evIdx; k < evs.length; k++) {
          if (evs[k].ev.type === 'expr') {
            end = evs[k].charOffset;
            break;
          }
        }
        const chars = Math.max(0, end - item.charOffset);
        ev.hold = clamp(chars / this.baseRate, 0.9, 6.5);
      }
      this.eventCount++;
      this.onEvent(ev, this.cur);
      if (ev.type === 'pause') this.pauseUntil = now + ev.seconds;
    }

    if (this.revealedInt >= this.cur.text.length) {
      this.cur = null;
      this.revealed = 0;
      this.revealedInt = 0;
    }
  }
}
