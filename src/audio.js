/**
 * 音频驱动层：把「声音」变成主时钟。
 *
 * P2 的时间源是「按字数估算的语速」，只能保证表情与文本同步；
 * 接上 TTS 后，真正该对齐的是音频。这里做三件事：
 *
 *  1. 用 TTS 返回的字符级时间戳，把每个字符映射到它在音频里的真实时刻；
 *  2. 把文本解析成音素级口型轨道（viseme.js），按同一组时间戳排布，
 *     于是「嘴型」与「声音」共用一条时钟，永远不会错位；
 *  3. 用 AnalyserNode 读实时 RMS，作为口型幅度的轻度调制（重音）。
 *
 * 时钟始终是 audioContext.currentTime：它由声卡驱动，不随主线程卡顿漂移。
 */

import { buildVisemes, buildSegments, sampleViseme } from './viseme.js';

/**
 * 一段极短的静音 WAV，用 Blob 现场拼。
 *
 * 用途只有一个：在用户手势里让 <audio> 元素真的播一次。Safari 和部分内嵌
 * webview 的自动播放许可不是页面级的，而是**元素级**的——只有在手势调用栈里
 * 成功 play() 过，之后异步 new Audio().play() 才不会被拒。用 data URI 也行，
 * 但现场拼 Blob 是同步的，能保住手势上下文。
 */
let _silentUrl = null;
function silentUrl() {
  if (_silentUrl) return _silentUrl;
  const rate = 8000;
  const n = 400; // 0.05s
  const size = 44 + n * 2;
  const ab = new ArrayBuffer(size);
  const v = new DataView(ab);
  const tag = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, size - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, n * 2, true);
  _silentUrl = URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
  return _silentUrl;
}

/** 把稀疏的字符标记插值成「每个字符的起始时刻」 */
export function buildCharTimes(len, marks, duration) {
  const out = new Float32Array(len);
  if (!len) return out;
  const pts = (marks || []).slice().sort((a, b) => a.at - b.at);

  if (!pts.length) {
    const step = duration / Math.max(1, len);
    for (let i = 0; i < len; i++) out[i] = i * step;
    return out;
  }

  let mi = 0;
  let prevAt = -1;
  let prevT = 0;
  for (let i = 0; i < len; i++) {
    while (mi < pts.length && pts[mi].at <= i) {
      prevAt = pts[mi].at;
      prevT = pts[mi].t;
      mi++;
    }
    const next = pts[mi];
    if (!next) {
      out[i] = Math.min(prevT, duration);
      continue;
    }
    const span = Math.max(1, next.at - prevAt);
    const frac = (i - prevAt) / span;
    out[i] = prevT + (next.t - prevT) * frac;
  }
  return out;
}

/** 已揭示的字符数（第一个起始时刻 > pos 的位置） */
export function indexAt(times, pos) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** TTS 客户端 + 播放器 + 音量分析 */
export class Voice {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.timeData = null;
    this.muted = false;
    this.enabled = true;
    this.level = 0;
    /** 自适应峰值，用于把 RMS 归一化 */
    this.peak = 0;
    /**
     * 播放通道：
     *   webaudio —— 正常路径，时钟是 audioContext.currentTime
     *   element  —— 兜底路径。<audio> 元素播放，时钟退到墙钟。
     *               两种情况会掉到这里：浏览器不给 AudioContext 授权、
     *               decodeAudioData 解不开这段 WAV 头。
     *   none     —— 还没初始化
     */
    this.mode = 'none';
    /** element 模式的墙钟基准 */
    this._t0 = 0;
    /**
     * 元素播放优先。
     *
     * 这台机器上的实测是：WebAudio 的 analyser 能读到满电平（信号确实进了
     * AudioDestinationNode），但声音出不来；同一段 WAV 用 <audio> 元素却能
     * 正常播。差别在后端——WebAudio 用 AudioUnit 直接向默认设备申请固定
     * 格式的流，蓝牙耳机处于 HFP 模式时这个流会被静默丢弃；<audio> 走
     * AVAudioEngine，会和设备协商格式。所以默认走元素，WebAudio 只留作
     * 备选，并在元素完全不推进时自动接管。
     */
    this.preferElement = true;
    /** 已经被元素打开过的音频，避免每次播放重新解码 */
    this._cache = new Map();
    this._silentEl = null;
    /** 给用户看的诊断，界面上直接显示 */
    this.diag = {
      state: '未初始化',
      decodeErr: null,
      blocked: false,
      plays: 0,
      drop: null,
      via: null,
      stalled: 0,
    };
  }

  /** 必须在用户手势里调用（浏览器自动播放策略） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        this.mode = 'element';
        this.diag.state = '浏览器不支持 WebAudio';
        this._kick();
        return null;
      }
      try {
        this.ctx = new AC();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.35;
        this.analyser.connect(this.ctx.destination);
        this.timeData = new Uint8Array(this.analyser.fftSize);
      } catch (e) {
        this.ctx = null;
        this.mode = 'element';
        this.diag.state = `AudioContext 创建失败：${e.message}`;
        this._kick();
        return null;
      }
    }

    // 有些实现（含内嵌 webview）创建出来就是 suspended，必须显式 resume。
    // resume 是异步的：先按兜底准备好，成功后再切回 webaudio，
    // 这样即使授权迟迟不给，也不至于哑掉。
    if (this.ctx.state === 'running') {
      this.mode = 'webaudio';
      this.diag.state = '运行中';
    } else {
      if (this.mode !== 'webaudio') this.mode = 'element';
      const p = this.ctx.resume();
      if (p && p.then) {
        p.then(() => {
          if (this.ctx && this.ctx.state === 'running') {
            this.mode = 'webaudio';
            this.diag.state = '运行中';
            this.diag.blocked = false;
          } else {
            this.diag.state = '被浏览器阻止播放';
            this.diag.blocked = true;
          }
        }).catch((e) => {
          this.diag.state = `resume 失败：${e.message}`;
          this.diag.blocked = true;
        });
      }
    }
    this._kick();
    return this.ctx;
  }

  /**
   * 手势内的双路解锁。
   *
   * 只用 resume() 不够：Safari 认可的「已解锁」是**真的播过一个 buffer**，
   * 元素路径认可的是**真的播过一个 <audio>**。两件都在手势里做掉，
   * 之后的异步播放才不会被静默拦下。
   */
  _kick() {
    if (this.ctx) {
      try {
        const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.ctx.destination);
        s.start(0);
      } catch {
        /* 已解锁 */
      }
    }
    if (!this._silentEl) {
      try {
        const el = new Audio(silentUrl());
        const p = el.play();
        this._silentEl = el;
        if (p && p.then) {
          p.then(() => {
            try {
              el.pause();
              el.currentTime = 0;
            } catch {
              /* ignore */
            }
          }).catch((e) => {
            this.diag.blocked = true;
            this.diag.state = `元素解锁被拒：${e.name}`;
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 当前时间。
   *
   * 正常情况下就是声卡时钟（不随主线程漂移）。但 AudioContext 被挂起时
   * （标签切后台、授权被撤回）currentTime 会冻住，整条时间线停摆——
   * 那比「不同步」更糟，脸会僵在半句话上。所以挂起时改用墙钟，
   * 并从最后一次观察到的 ctx 时间接续，避免回来时跳变。
   */
  get now() {
    const c = this.ctx;
    if (c && c.state === 'running') {
      this._lastCtx = c.currentTime;
      this._lastWall = performance.now() / 1000;
      return c.currentTime;
    }
    const base = this._lastCtx || 0;
    const w = this._lastWall || performance.now() / 1000;
    return base + (performance.now() / 1000 - w);
  }

  async load(text, tone) {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(tone && Number.isFinite(tone.rate) ? { rate: tone.rate } : {}),
        ...(tone && Number.isFinite(tone.pitch) ? { pitch: tone.pitch } : {}),
      }),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    const meta = await r.json();

    // 默认走元素播放，AudioBuffer 根本用不上。之前每句都要「下载一遍 +
    // decodeAudioData 一遍」，白付 20~80ms 首字延迟，还会在 Safari 挑食
    // 时报一个「解不开」的假警报。只有真的要退回 WebAudio 时才解码。
    let buffer = null;
    if (!this.preferElement && this.ctx) {
      try {
        const ab = await (await fetch(meta.url)).arrayBuffer();
        buffer = await this.ctx.decodeAudioData(ab);
      } catch (e) {
        this.diag.decodeErr = e.message;
        this.mode = 'element';
      }
    }

    this.warm(meta.url);

    return {
      buffer,
      url: meta.url,
      duration: meta.duration || (buffer ? buffer.duration : 0),
      marks: meta.marks || [],
      chars: meta.chars || text.length,
    };
  }

  /** 预热：把 URL 交给一个 <audio> 元素先缓冲好，播放时才不用等 */
  warm(url) {
    if (!url || this._cache.has(url) || typeof Audio === 'undefined') return;
    try {
      const el = new Audio(url);
      el.preload = 'auto';
      el.load();
      this._cache.set(url, el);
      if (this._cache.size > 6) this._cache.delete(this._cache.keys().next().value);
    } catch {
      /* ignore */
    }
  }

  /**
   * 播放一段音频。返回句柄：{ kind, pos, ended, stop() }。
   *
   * pos 是「音频已经播到的秒数」，元素路径直接读 el.currentTime。
   * 这一点很关键：它既是口型时钟（声音播到哪、嘴动到哪），
   * 也是唯一能证明「浏览器真的在播」的证据——currentTime 不前进，
   * 就说明这段根本没出声，可以立刻换路径或报告，而不是干等。
   */
  playAudio(audio, at) {
    const canWebAudio =
      !this.preferElement && audio.buffer && this.ctx && this.ctx.state === 'running';

    if (canWebAudio) {
      const src = this.ctx.createBufferSource();
      src.buffer = audio.buffer;
      src.connect(this.analyser);
      src.start(at);
      const t0 = at;
      this.diag.via = 'webaudio';
      return {
        kind: 'webaudio',
        get pos() {
          return Math.max(0, this._ctxNow() - t0);
        },
        _ctxNow: () => (this.ctx ? this.ctx.currentTime : 0),
        stop: () => {
          try {
            src.stop();
          } catch {
            /* 已停 */
          }
        },
      };
    }

    if (audio.url) return this._playElement(audio);
    return null;
  }

  _playElement(audio) {
    // 同一时刻只允许一路在播。对话是顺序的、试听是插队的，两者撞上就是
    // 两个人叠着说话；连点「试听」也一样。开播前把上一路掐掉。
    this.stopAll();
    let el = this._cache.get(audio.url);
    if (el) {
      this._cache.delete(audio.url);
      // 缓存里的元素可能停在末尾，不复位就会「一开口就结束」
      try {
        el.currentTime = 0;
      } catch {
        /* 还没加载好，无所谓 */
      }
    } else {
      el = new Audio(audio.url);
      el.preload = 'auto';
    }
    el.volume = 1;

    const h = {
      kind: 'element',
      el,
      get pos() {
        return el.currentTime || 0;
      },
      get ended() {
        return el.ended;
      },
      stop: () => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch {
          /* ignore */
        }
      },
    };

    const p = el.play();
    if (p && p.catch) {
      p.catch((e) => {
        h.failed = e.name;
        this.diag.drop = `${e.name}: ${e.message}`;
        this.diag.blocked = true;
      });
    }

    this._els = this._els || [];
    this._els.push(el);
    if (this._els.length > 4) {
      const old = this._els.shift();
      if (old !== el) {
        try {
          old.pause();
        } catch {
          /* ignore */
        }
      }
    }
    this.diag.via = 'element';
    this.diag.plays++;
    return h;
  }

  /**
   * 自检：走一遍真实语音路径（合成 → 元素播放 → 读推进量）。
   *
   * 旧的 660Hz 正弦自检没有诊断力：analyser 在 destination **之前**，
   * 它读到电平只证明图内部有信号，设备那头是不是真的响，它一无所知。
   * 换成真实 TTS + el.currentTime，才能回答「浏览器到底有没有在播」。
   */
  async ping() {
    this.unlock();
    // 试听要独占：正在播的对话、上一次试听都先停掉，否则两路人声叠在一起，
    // 用户听到的不是「有没有声音」，而是「一团糊住的声音」。
    this.stopAll();
    await new Promise((r) => setTimeout(r, 100));

    const out = {
      mode: this.mode,
      state: this.ctx ? this.ctx.state : 'none',
      peak: 0,
      elPos: 0,
      elOk: false,
      elErr: null,
      msg: '',
    };

    // ① 元素路径：和对话实际播放走同一条
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '声音测试，一二三四五' }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const meta = await r.json();
      const el = new Audio(meta.url);
      el.preload = 'auto';
      this._pingEl = el;
      out.elErr = await el.play().then(() => null).catch((e) => `${e.name}: ${e.message}`);
      await new Promise((r2) => setTimeout(r2, 700));
      out.elPos = +el.currentTime.toFixed(2);
      out.elOk = !out.elErr && el.currentTime > 0.05;
    } catch (e) {
      out.elErr = e.message;
    }

    // 不要再叠一个 WebAudio 正弦做「对照」。
    // analyser 连着 destination，那声 660Hz 是真的会响的——它和正在播的
    // 语音叠在一起，听起来就是一阵刺耳的嗡嗡声，用户会以为链路炸了。
    // 判据已经是 el.currentTime，不需要第二个声源。

    // 判定：只有元素真的推进了，才算「浏览器在播」
    if (out.elOk) {
      out.ok = true;
      out.msg = '已在播放';
    } else if (out.elErr) {
      out.ok = false;
      out.msg = `播放被拒（${out.elErr}）`;
    } else {
      out.ok = false;
      out.msg = `音频没有推进（${out.elPos}s）`;
    }
    if (this._pingEl) {
      // 让它把整句播完：点「试听」就是为了听声音，掐掉半句等于什么都没测到
      this._pingEl.addEventListener('ended', () => {
        this._pingEl = null;
      });
    }
    return out;
  }

  /**
   * 实时音量，0~1。
   *
   * 不能直接用固定阈值：不同语音、不同系统音量下 RMS 的绝对水平差好几倍，
   * 固定映射不是全程贴顶就是全程不动。这里用「自适应峰值」归一化——
   * 峰值只缓慢衰减（约 3%/秒），于是同一句话内的轻重音关系被保留，
   * 换声音、改音量又能自动适配。最后再加一个伽马，把轻重差别拉开，
   * 否则中文 TTS 的 RMS 分布太窄（p05 0.26 / p50 0.45 / max 0.54），
   * 嘴型会几乎没有变化。
   */
  readLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);

    this.peak = Math.max(rms, this.peak * 0.9995);
    if (this.peak < 0.03) this.peak = 0.03;

    const gate = this.peak * 0.25;
    let v = (rms - gate) / Math.max(1e-6, this.peak - gate);
    if (v < 0) v = 0;
    else if (v > 1) v = 1;

    this.level = Math.pow(v, 1.5);
    return this.level;
  }

  resetLevel() {
    this.level = 0;
    this.peak = 0;
  }

  stopAll() {
    if (this.ctx && this.ctx.state === 'running') {
      // 断开分析器的输入，防止残留尾音驱动嘴型
      try {
        this.analyser.disconnect();
      } catch {
        /* ignore */
      }
      this.analyser.connect(this.ctx.destination);
    }
    if (this._els) {
      for (const el of this._els) {
        try {
          el.pause();
          el.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
      this._els.length = 0;
    }
    // 试听用的元素不在 _els 里：不掐掉的话，点两次「试听」就是同一句话
    // 错开几十毫秒叠着播，相位打架，听起来像呼噜声。
    if (this._pingEl) {
      try {
        this._pingEl.pause();
        this._pingEl.currentTime = 0;
      } catch {
        /* ignore */
      }
      this._pingEl = null;
    }
    this.level = 0;
    this.peak = 0;
  }
}

/**
 * 音频版播放器：接口与 timeline.js 的 UtterancePlayer 一致，
 * 但位置来自音频时钟，事件按字符的**真实发声时刻**触发。
 */
export class AudioUtterancePlayer {
  constructor(opts = {}) {
    this.voice = opts.voice;
    this.onReveal = opts.onReveal || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onIdle = opts.onIdle || (() => {});
    this.onSegmentStart = opts.onSegmentStart || (() => {});
    /** 取当前情绪对应的语音参数（语速/音高）。null = 用 TTS 默认值 */
    this.tone = opts.tone || null;

    this.queue = [];
    this.cur = null;
    this.lastEnd = 0;
    this.streamDone = false;
    this.idleNotified = true;
    this.segmentsPlayed = 0;
    this.eventCount = 0;
    this.degraded = false;
    this.sources = [];
  }

  reset() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 已经停了 */
      }
    }
    this.sources.length = 0;
    this.queue.length = 0;
    this.cur = null;
    this.lastEnd = 0;
    this.streamDone = false;
    this.idleNotified = true;
    this.voice.stopAll();
    this.voice.resetLevel();
  }

  _wrap(seg) {
    return {
      text: seg.text,
      events: seg.events || [],
      evIdx: 0,
      revealedInt: 0,
      audio: null,
      loading: false,
      started: false,
      startAt: 0,
      source: null,
      charTimes: null,
      /** 音素口型段（按 charTimes 排布） */
      segs: null,
      silent: false,
      /** 元素播放卡死时改回墙钟推进，脸不会僵在第一个字上 */
      useWall: false,
      _maxPos: 0,
      _stallT: 0,
    };
  }

  /**
   * 句内已播秒数。
   *
   * 元素路径直接读 el.currentTime——这是浏览器 media pipeline 的**真实**
   * 播放位置，不是估算。它同时充当两件事：口型的时钟，以及「到底有没有
   * 在播」的判据。元素迟迟不推进（被拦、设备不可用）时退回墙钟，
   * 保证表情链永远不会卡死。
   */
  _pos(seg, now) {
    if (seg.useWall) return now - seg.startAt;
    const src = seg.source;
    if (!src || src.pos == null) return now - seg.startAt;

    const p = src.pos;
    if (p > seg._maxPos + 0.002) {
      seg._maxPos = p;
      seg._stallT = 0;
      return p;
    }
    if (seg._maxPos < 0.12) {
      if (!seg._stallT) seg._stallT = performance.now();
      else if (performance.now() - seg._stallT > 900) {
        seg.useWall = true;
        this.voice.diag.stalled++;
        return now - seg.startAt;
      }
    }
    return p;
  }

  enqueue(seg) {
    if (!seg || !seg.text) return;
    this.queue.push(this._wrap(seg));
    this.idleNotified = false;
  }

  markStreamDone() {
    this.streamDone = true;
  }

  get backlog() {
    let n = this.cur ? Math.max(0, this.cur.text.length - this.cur.revealedInt) : 0;
    for (const s of this.queue) n += s.text.length;
    return n;
  }

  get articulating() {
    const s = this.cur;
    if (!s || !s.started || !s.audio) return false;
    return this._pos(s, this.voice.now) < s.audio.duration;
  }

  get busy() {
    return !!this.cur || this.queue.length > 0;
  }

  /**
   * 当前实时音量，供口型层读取。
   *
   * 元素播放时拿不到 analyser 电平（那条链路不经过 WebAudio），返回 -1
   * 让口型层改用音素自带的幅度——比传一个假的 0 好得多，传 0 会让
   * 嘴张开的幅度掉到 72% 且全程没有重音变化。
   */
  readLevel() {
    const s = this.cur;
    if (s && s.source && s.source.kind === 'element') return -1;
    return this.voice.readLevel();
  }

  /**
   * 当前时刻的音素口型。
   *
   * 返回 null 表示「这一刻没有发音信息」（还没开播 / 没有音素轨道），
   * 口型层据此退回包络驱动；返回一条全零的姿态表示「此刻应当是闭嘴」，
   * 两者语义不同，不能混。
   */
  readViseme() {
    const s = this.cur;
    if (!s || !s.started || !s.segs) return null;
    return sampleViseme(s.segs, this._pos(s, this.voice.now));
  }

  /** 当前句的音素轨道（供调试面板 / 测试断言） */
  get currentSegs() {
    return this.cur ? this.cur.segs : null;
  }

  async _load(seg) {
    if (seg.loading || seg.audio) return;
    seg.loading = true;
    try {
      // 语音参数（语速/音高）在**加载这一句时**取一次，整句固定。
      // 一句话中途变调会很怪，但两句话之间变是自然的。
      const tone = this.tone ? this.tone() : null;
      const a = await this.voice.load(seg.text, tone);
      if (tone) seg.tone = tone;
      seg.audio = a;
      seg.charTimes = buildCharTimes(seg.text.length, a.marks, a.duration);
      seg.segs = buildSegments(buildVisemes(seg.text), seg.charTimes, a.duration);
      // 预缓冲：把 URL 交给元素提前载好，句间才不会有一段空等
      if (a.url) this.voice.warm(a.url);
    } catch (e) {
      // TTS 不可用：退化成按时长估算的静音片段，链路不中断。
      // 口型照样用音素轨道跑——此时它反而成了唯一的发音依据，
      // 比坐着不动强得多。
      this.degraded = true;
      const duration = Math.max(0.6, seg.text.length / 4.6);
      seg.audio = { buffer: null, duration, marks: [], chars: seg.text.length };
      seg.charTimes = buildCharTimes(seg.text.length, [], duration);
      seg.segs = buildSegments(buildVisemes(seg.text), seg.charTimes, duration);
      seg.silent = true;
      seg.error = e.message;
    } finally {
      seg.loading = false;
    }
  }

  update() {
    const voice = this.voice;
    const now = voice.now;

    if (!this.cur) {
      if (!this.queue.length) {
        this.lastEnd = 0;
        if (this.streamDone && !this.idleNotified) {
          this.idleNotified = true;
          this.onIdle();
        }
        return;
      }
      this.cur = this.queue.shift();
      this.segmentsPlayed++;
      if (!this.cur.audio) this._load(this.cur);
      if (this.queue[0] && !this.queue[0].audio) this._load(this.queue[0]);
      return;
    }

    const seg = this.cur;
    if (!seg.audio) return; // 等合成

    if (!seg.started) {
      seg.startAt = Math.max(now + 0.04, this.lastEnd);
      seg.started = true;
      if (!seg.silent && !voice.muted) {
        seg.source = voice.playAudio(seg.audio, seg.startAt);
        if (seg.source) {
          this.sources.push(seg.source);
          if (this.sources.length > 4) this.sources.shift();
          // 元素是「调用即开播」，时钟基准必须落在当前时刻。
          // 沿用 WebAudio 的 now+0.04 会让墙钟兜底凭空慢一帧。
          if (seg.source.kind === 'element') seg.startAt = now;
        }
      }
      this.onSegmentStart(seg);
      // 预取下一句，避免句间停顿
      if (this.queue[0] && !this.queue[0].audio) this._load(this.queue[0]);
    }

    const pos = this._pos(seg, now);
    if (pos < 0) return;

    const dur = seg.audio.duration;
    const idx = seg.charTimes ? indexAt(seg.charTimes, Math.min(pos, dur)) : 0;

    if (idx > seg.revealedInt) {
      this.onReveal(seg.text.slice(seg.revealedInt, idx), seg);
      seg.revealedInt = idx;
    }

    const times = seg.charTimes;
    while (seg.evIdx < seg.events.length) {
      const item = seg.events[seg.evIdx];
      const t = item.charOffset < times.length ? times[item.charOffset] : dur;
      if (t > pos) break;
      seg.evIdx++;
      const ev = item.ev;
      if (ev.type === 'expr') {
        let end = dur;
        for (let k = seg.evIdx; k < seg.events.length; k++) {
          if (seg.events[k].ev.type === 'expr') {
            const off = seg.events[k].charOffset;
            end = off < times.length ? times[off] : dur;
            break;
          }
        }
        ev.hold = Math.max(0.7, Math.min(6.5, end - t + 0.4));
      }
      this.eventCount++;
      this.onEvent(ev, seg);
    }

    // 元素播放的 currentTime 顶多走到 duration，用 dur - 0.03 收尾；
    // 墙钟那条超时是兜底：无论音频卡在哪，这一句都不能拖住整轮对话。
    if (pos >= dur - 0.03 || now - seg.startAt > dur + 1.5) {
      this.lastEnd = seg.startAt + dur;
      this.cur = null;
    }
  }
}
