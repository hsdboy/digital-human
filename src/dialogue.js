/**
 * 对话驱动层：把「模型输出」变成「脸在动」。
 *
 * 三条输入汇到同一张脸上：
 *   ① 模型打的内联标签（精确，但依赖模型听话）
 *   ② 文本语义推断（不依赖标签，读句子本身算情绪）—— 见 semantics.js
 *   ③ 用户说的话（听者反应：对方说"我升职了"，先挑眉再回答）
 * 后两者保证"模型不打标签，脸也不会是木头"。
 *
 * 时间源是音频时钟：
 *   POST /api/chat (SSE) → TagParser（剥标签、记偏移）+ SemanticAnalyzer（算情绪、记偏移）
 *   → Segmenter（切句，同一坐标系里排队）→ POST /api/tts（WAV + 字符时间戳）
 *   → AudioUtterancePlayer（以 audioContext.currentTime 为准推进）
 *   → onEvent → FaceMixer
 *
 * 冲突仲裁：同一句里，标签优先，语义让位（否则模型说了"悲伤"却被句子里某个
 * "还行"带成中性，标签就白打了）。
 */

import { TagParser, stripTags } from './tags.js';
import { Segmenter, UtterancePlayer } from './timeline.js';
import { Voice, AudioUtterancePlayer } from './audio.js';
import { SemanticAnalyzer, analyzeText } from './semantics.js';
import { humanizeSeg, cleanStream } from './humanize.js';
import { MoodEngine } from './mood.js';
import { Memory } from './memory.js';
import { Rhythm } from './rhythm.js';
import { PERSONA } from './persona.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAZE_TO_MODE = {
  camera: 'speak',
  away: 'idle',
  down: 'listen',
  think: 'think',
};

const HALF_TO_FULL = { '?': '？', '!': '！', ',': '，', ';': '；', ':': '：' };

/**
 * 中文后面的半角标点换成全角。
 *
 * 真模型经常写成「那也太尴尬了吧?。发生了什么情况?」——半角问号 TTS 不认，
 * 会一路连读过去，整句话就没了语气。这里只做 1:1 替换，**不合并重复标点**：
 * 长度一变，挂在上面的表情事件偏移就全错位了。
 */
function normalizePunct(s) {
  return s.replace(/([\u4e00-\u9fff])([?!,;:])/g, (m, c, p) => c + HALF_TO_FULL[p]);
}

/**
 * 段内事件卫生 + 冲突仲裁。
 *
 * 小模型（0.5B~3B）经常一口气刷一串表情标签：
 *   「真是让人心疼啊… <e:anger:0.6> <e:sadness:0.7> <e:thinking:0.5> <e:thinking:0.5>」
 * 全放行就是一张每秒抽三次的脸——它不是在表达，是在刷指令。
 * 这里做三件事：
 *
 *   1. 段内有标签表情 → 语义表情让位（否则两套情绪在同一句里互相覆盖）
 *   2. 标签表情每段只留**强度最高的一个**。复合情绪交给语义层的 mix，
 *      那是按通道取 max 算出来的，比让模型连打标签可靠得多
 *   3. 视线、停顿每段各留一个：同一个方向说三遍没有意义
 */
/** 上一次加口癖的时刻。口癖是调味料，一场对话里出现太多次就成了口吃 */
let habitAt = 0;

const MOOD_KEY = 'xiaoman.mood.v1';

function readMoodSnap() {
  try {
    return JSON.parse(localStorage.getItem(MOOD_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeMoodSnap(mood) {
  try {
    localStorage.setItem(MOOD_KEY, JSON.stringify(mood.snapshot()));
  } catch {
    /* 隐私模式下写不了，不影响对话 */
  }
}

function reconcile(seg) {
  // 人化必须在表情仲裁之前：删客服套话、加口癖都会移动字符，
  // humanizeSeg 内部会同步修正 events 的 charOffset，之后再仲裁才不会错位。
  const nowMs = performance.now();
  const allowHabit = nowMs - habitAt > 7000 && Math.random() < 0.16;
  if (allowHabit) habitAt = nowMs;
  humanizeSeg(seg, { habits: PERSONA.habits, allowHabit });

  if (seg.text) seg.text = normalizePunct(seg.text);
  const evs = seg.events;
  if (!evs || evs.length < 2) return seg;

  const isTagExpr = (e) => e.ev.src === 'tag' && e.ev.type === 'expr' && e.ev.name !== 'neutral';
  const tagExprs = evs.filter(isTagExpr);
  const hasTag = tagExprs.length > 0;

  let out = hasTag ? evs.filter((e) => !(e.ev.src === 'sem' && e.ev.type === 'expr')) : evs.slice();

  if (hasTag) {
    let best = tagExprs[0];
    for (const e of tagExprs) if ((e.ev.intensity || 0) > (best.ev.intensity || 0)) best = e;
    out = out.filter((e) => !isTagExpr(e) || e === best);
  }

  let gazeKept = false;
  let pauseKept = false;
  out = out.filter((e) => {
    if (e.ev.type === 'gaze') {
      if (gazeKept) return false;
      gazeKept = true;
    } else if (e.ev.type === 'pause') {
      if (pauseKept) return false;
      pauseKept = true;
    }
    return true;
  });

  seg.events = out;
  return seg;
}

export function startDialogue(mixer, opts = {}) {
  const $ = (id) => document.getElementById(id);
  const sayEl = $('say-text');
  const askEl = $('ask');
  const stateEl = $('state');
  const provEl = $('prov');
  const latEl = $('lat');
  const muteBtn = $('mute');
  const sndEl = $('snd');
  let sndFrame = 0;

  const voice = new Voice();
  const history = [];
  /** 情绪有惯性：不是每轮从中性重开。刷新页面也接着上次的心情，按离线时长衰减 */
  const mood = MoodEngine.restore(readMoodSnap());
  /** 关于用户的长期事实，存本机 */
  const memory = new Memory();
  /** 停顿、主动开口、被打断的时机 */
  const rhythm = new Rhythm();
  let parser = null;
  let segmenter = null;
  let sem = new SemanticAnalyzer();
  let abort = null;
  let exprExpireAt = 0;
  /** 表情切换的最小驻留控制 */
  let lastExprAt = 0;
  let lastExprName = null;
  /** 听者反应的时刻：这段时间内语义表情不许覆盖 */
  let hearAt = 0;
  let turnT0 = 0;
  let ttft = 0;
  /** 用户真正等到第一个字的时间（含刻意的思考节拍） */
  let firstShown = 0;
  /** TTS 是否可用；null 表示还不知道 */
  let ttsOk = null;
  let player = null;
  /** 最近一次表情来自哪里：tag / sem / hear / null */
  let lastSrc = null;
  let thinkTimer = 0;
  /** 声音相关的两条异常只提示一次，不要每帧刷屏 */
  let decodeShown = false;
  let dropShown = false;
  /** 音频诊断只回传一次，够定位就不再打扰服务端 */
  let reported = false;
  /** 心情落盘的帧计数 */
  let moodSaveFrame = 0;

  /** 把音频链路的真实状态送回服务端，落进日志 */
  function reportAudio(reason, force = false) {
    if (reported && !force) return;
    reported = true;
    const d = {
      reason,
      mode: voice.mode,
      state: voice.ctx ? voice.ctx.state : null,
      ctx: !!voice.ctx,
      decodeErr: voice.diag.decodeErr,
      drop: voice.diag.drop,
      level: +voice.level.toFixed(3),
      muted: voice.muted,
      sampleRate: voice.ctx ? voice.ctx.sampleRate : null,
    };
    fetch('/api/client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(d),
    }).catch(() => {});
  }

  const hooks = {
    onEvent: (ev) => applyEvent(ev),
    onReveal(chunk) {
      sayEl.textContent += chunk;
      const box = sayEl.parentElement;
      box.scrollTop = box.scrollHeight;
    },
    onSegmentStart() {
      setState('speaking');
    },
    onIdle() {
      setState('idle');
      exprExpireAt = performance.now() / 1000 + 0.6;
    },
  };

  function ensurePlayer() {
    if (player) return player;
    if (ttsOk === false) {
      player = new UtterancePlayer({ baseRate: opts.baseRate || 4.8, ...hooks });
    } else {
      // 语速/音高跟着心情走：说到难处会自然慢下来、沉下去
      player = new AudioUtterancePlayer({ voice, ...hooks, tone: () => mood.tone });
    }
    return player;
  }

  function setState(s) {
    mixer.__state = s;
    stateEl.textContent = s === 'thinking' ? '思考中' : s === 'speaking' ? '说话中' : '待机';
    stateEl.dataset.s = s;
  }

  function applyEvent(ev) {
    switch (ev.type) {
      case 'expr': {
        // 语义推断可以单独关掉，标签仍然生效
        if (ev.src === 'sem' && !mixer.enabled.semantic) break;
        const name = ev.name || 'neutral';
        const now = performance.now();
        // 听者反应有 1.2 秒保护期。用户刚说完"被老板骂了"，脸该先难过；
        // 但模型开口第一句往往是"啊……"，省略号被语义层读成迟疑，
        // 会立刻把共情表情冲成思考——这一秒是"有人听见了"的全部价值，
        // 不能被句首语气词抹掉。标签仍然可以覆盖。
        if (ev.src === 'sem' && now - hearAt < 1200) break;
        // 最小驻留 350ms：事件挤在一起时（尤其小模型连打标签），
        // 脸还没过渡完就被下一道命令覆盖，看着是抽搐不是表情。
        // 回中性不受限制——该收的时候必须收得掉。
        if (name !== 'neutral' && name !== lastExprName && now - lastExprAt < 350) break;
        lastExprAt = now;
        lastExprName = name;
        mixer.enabled.preset = true;
        if (!ev.name || ev.name === 'neutral') {
          mixer.setPreset('neutral');
          mixer.presetGain = 1;
        } else if (ev.mix && ev.mix.length > 1) {
          mixer.setPresetMix(ev.mix.map((m) => ({ ...m })));
          mixer.presetGain = ev.intensity;
        } else {
          mixer.setPreset(ev.name);
          mixer.presetGain = ev.intensity;
        }
        lastSrc = ev.src || null;
        exprExpireAt = performance.now() / 1000 + (ev.hold || 2.2);
        break;
      }
      case 'micro':
        if (ev.src === 'sem' && !mixer.enabled.semantic) break;
        mixer.spawnMicroNamed(ev.part, ev.intensity);
        break;
      case 'gaze':
        mixer.setMode(GAZE_TO_MODE[ev.target] || 'speak');
        break;
      case 'emotion':
        // 模型自己说的情绪底色：会留在 mood 里，比一句话的表情活得久
        mood.push(ev.valence, ev.arousal, 0.45);
        // 用户手动拖过滑块就别抢
        if (mixer.autoEmotion !== false) mixer.setEmotion(ev.valence, ev.arousal);
        break;
      default:
        break;
    }
  }

  function beginTurn() {
    parser = new TagParser();
    // 语义分析器每轮清零字符坐标（与 Segmenter/TagParser 的 0 基准对齐），
    // 但保留 mood —— 上一句话的情绪底色不该在下一句开始时被抹掉
    sem.resetAll();
    segmenter = new Segmenter((seg) => player.enqueue(reconcile(seg)));
    player.reset();
    sayEl.textContent = '';
    exprExpireAt = 0;
    lastExprAt = 0;
    lastExprName = null;
    hearAt = 0;
    decodeShown = false;
    dropShown = false;
    turnT0 = performance.now();
    ttft = 0;
    firstShown = 0;
  }

  /**
   * 听者反应：用户的话已经说完，不必等话语时钟，立刻给一个表情回应。
   * 这是"对方在听你说话"最关键的一秒——只回"思考中"的脸是没有温度的。
   */
  function hear(text) {
    const r = analyzeText(text);
    // 心情被你这句推动一点。分量很轻——一句话不该定一整天
    mood.hear(r);
    if (!mixer.enabled.semantic) return r;
    if (r.score < 0.42 || r.name === 'neutral') return r;
    hearAt = performance.now();
    applyEvent({
      type: 'expr',
      name: r.name,
      mix: r.mix,
      intensity: Math.min(0.85, 0.36 + r.score * 0.55),
      hold: 1.6,
      src: 'hear',
    });
    mixer.setMode('camera');
    mixer.setEmotion(mixer.emotionTarget.valence * 0.5 + r.valence * 0.5, mixer.emotionTarget.arousal * 0.5 + r.arousal * 0.5);
    thinkTimer = performance.now() / 1000 + 1.1;
    return r;
  }

  async function ask(text, init = false) {
    text = init ? '' : String(text || '').trim();
    if (!init && !text) return;
    if (player && player.busy) stop();

    voice.unlock();
    // 声音起不来时界面必须有线索，否则用户只能看到一张会动但不出声的脸，
    // 分不清是系统静音、浏览器拦了自动播放、还是服务端 TTS 挂了。
    if (voice.ctx && voice.ctx.state !== 'running') {
      latEl.textContent = '正在请求音频权限…';
    }
    ensurePlayer();
    beginTurn();
    setState('thinking');
    rhythm.poke(performance.now() / 1000);
    // 她不是被问才活着的：主动开口时没有"上一句用户发言"可分析
    if (!init) {
      memory.learn(text);
      hear(text);
      history.push({ role: 'user', content: text });
    } else {
      // 主动开口时先看一眼当下心情，决定要不要抬眼看镜头
      mixer.setMode('think');
    }
    if (thinkTimer <= performance.now() / 1000) mixer.setMode('think');

    const ctrl = new AbortController();
    abort = ctrl;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          initiate: init || undefined,
          history: history.slice(-9),
          mood: mood.state,
          facts: memory.facts,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let rawAcc = '';

      let firstPending = true;
      const handle = async (msg) => {
        if (msg.type === 'meta') {
          if (msg.provider) provEl.textContent = `${msg.provider}${msg.model ? ' · ' + msg.model : ''}`;
        } else if (msg.type === 'delta') {
          if (firstPending) {
            firstPending = false;
            ttft = performance.now() - turnT0;
            // 拟人化里最反直觉的一环：回得太快反而不像人。
            // 真人听到问题会愣一下——这段空白不是卡顿，是"在想"，
            // 由 think 的眼神和微蹙的眉填满。
            const wait = rhythm.thinkGate(ttft);
            if (wait) await sleep(wait);
            // 界面报的是「用户真正等到第一个字」的时间，含这段刻意留白。
            // 只报模型 ttft 会让人误以为已经很快了，而体感不是那样。
            firstShown = performance.now() - turnT0;
            latEl.textContent = `首字 ${Math.round(firstShown)}ms`;
          }
          // 去掉 markdown 星号、零宽字符：它们会被 TTS 念出来，也会让
          // 后续所有字符偏移算错。放在 parser 之前是安全的——
          // parser 的字符计数基于清洗后的文本。
          const cleaned = cleanStream(msg.text);
          if (!cleaned) return;
          rawAcc += cleaned;
          const r = parser.push(cleaned);
          // 标签事件排后面：同一偏移上后执行，标签覆盖推断
          for (const e of r.events) e.ev.src = 'tag';
          const semEv = sem.feed(r.text);
          segmenter.push(r.text, semEv.concat(r.events));
        } else if (msg.type === 'error') {
          sayEl.textContent += `〔出错：${msg.message}〕`;
        } else if (msg.type === 'done') {
          const tail = parser.flush();
          for (const e of tail.events) e.ev.src = 'tag';
          const semTail = sem.feed(tail.text);
          segmenter.push(tail.text, semTail.concat(tail.events));
          const fin = sem.end();
          if (fin.length) segmenter.push('', fin);
          segmenter.flush();
          player.markStreamDone();
          history.push({ role: 'assistant', content: stripTags(rawAcc) });
          mood.endTurn();
          const total = performance.now() - turnT0;
          latEl.textContent = `首字 ${Math.round(firstShown || ttft)}ms · 全量 ${(total / 1000).toFixed(2)}s`;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            await handle(JSON.parse(line.slice(6)));
          } catch {
            /* 半个 JSON，忽略 */
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      sayEl.textContent += `〔连接失败：${e.message}〕`;
      setState('idle');
    } finally {
      if (abort === ctrl) abort = null;
    }
  }

  function stop() {
    const wasSpeaking = !!(player && player.busy);
    if (abort) {
      abort.abort();
      abort = null;
    }
    if (player) player.reset();
    mixer.panic();
    // 被打断不是"归零"，而是一个情绪事件：人会停住、抬眼看你一下，
    // 心里多少有点被截断的不爽。这一下比任何表情都更像活人。
    if (wasSpeaking) {
      applyEvent({ type: 'expr', name: 'surprise', intensity: 0.48, hold: 0.9, src: 'hear' });
      mixer.setMode('camera');
      exprExpireAt = performance.now() / 1000 + 1.0;
      mood.push(mood.valence - 0.06, 0.3, 0.35);
    }
    thinkTimer = 0;
    lastSrc = null;
    setState('idle');
    latEl.textContent = '已打断';
  }

  /** 每帧调用：推进话语时钟，处理表情过期 */
  function tick(nowSec) {
    // 心情按真实时间回归基线。正面余温 tau≈4 分钟，负面 tau≈1.8 分钟——
    // 人对坏心情的自我修复其实比好心情的消退快一些。
    mood.tick(nowSec);
    // 每 10 秒落一次盘。只靠 beforeunload 不保险——切标签页、进程被杀都不会触发，
    // 而心情恰恰是最该跨刷新活下去的东西。
    if (++moodSaveFrame > 600) {
      moodSaveFrame = 0;
      writeMoodSnap(mood);
    }

    if (player) {
      player.update(nowSec);
      mixer.articulating = player.articulating;
      // 口型形状来自音素轨道，幅度调制来自真实音量——两者缺一不可：
      // 只有音量时长什么样都像；只有音素时听不出轻重音。
      mixer.speech.setViseme(player.readViseme ? player.readViseme() : null);
      mixer.speech.setExternal(player.readLevel ? player.readLevel() : -1);
      if (player.degraded && !player.degradedShown) {
        player.degradedShown = true;
        latEl.textContent = 'TTS 不可用，已退回文本时钟';
      }
      // 解码失败原本是静默的：脸照动、字照出、就是没声音，界面上一点线索都没有。
      // 这条提示是唯一能把它和「系统静音」区分开的东西。
      if (voice.diag.decodeErr && !decodeShown) {
        decodeShown = true;
        latEl.textContent = `浏览器解不开这段音频，已改用元素播放（${voice.diag.decodeErr}）`;
      }
      if (voice.diag.drop && !dropShown) {
        dropShown = true;
        latEl.textContent = `浏览器拒绝播放：${voice.diag.drop}（点一下页面再试）`;
      }
    }

    // 听完之后的"思考"姿态：先让表情反应停留一秒，再切到想事情的眼神
    if (thinkTimer && nowSec > thinkTimer) {
      thinkTimer = 0;
      if (mixer.__state === 'thinking') mixer.setMode('think');
    }

    if (exprExpireAt && nowSec > exprExpireAt) {
      exprExpireAt = 0;
      if (!player || !player.busy) {
        mixer.setPreset('neutral');
        mixer.presetGain = 1;
        mixer.setMode('listen');
        lastSrc = null;
      }
    }

    // 安静下来之后，脸色的底色交给 mood——这是"她今天状态怎么样"的延续，
    // 而不是每一轮都从绝对中性重开。说话期间让位给当句的即时情绪，
    // 否则一句玩笑话留下的余温会把下一句的严肃表情冲淡。
    if ((!player || !player.busy) && !exprExpireAt && mixer.autoEmotion !== false) {
      mixer.setEmotion(mood.valence, mood.arousal);
    }

    // 主动开口。这个判断必须放在最后：要确认她没有在说话、没有在请求、
    // 页面还开着（切到后台标签页时说话是没有意义的）。
    if (
      rhythm.tick(nowSec, {
        busy: (player && player.busy) || !!abort,
        chatty: mood.tendency.chatty,
        hasHistory: history.length > 0,
        visible: !document.hidden,
      })
    ) {
      ask('', true);
    }

    // 音频状态灯：每 12 帧刷一次，够看又不费事。
    // 「有声」和「就绪」要分开显示——链路通了但音量是 0，
    // 和链路断了是两件完全不同的事，用户该查的地方也不一样。
    if (player && !reported) {
      if (voice.diag.drop) reportAudio('blocked');
      else if (voice.diag.decodeErr) reportAudio('decode-fail');
      else if (player.articulating && voice.level > 0.05) reportAudio('ok');
      else if (voice.ctx && voice.ctx.state !== 'running' && turnT0 && performance.now() - turnT0 > 3000) {
        reportAudio('suspended');
      }
    }

    if (sndEl && ++sndFrame % 12 === 0) {
      let s = 'ok';
      let txt = '音频 就绪';
      const via = voice.diag.via;
      if (voice.muted) {
        s = 'bad';
        txt = '音频 已静音';
      } else if (!voice.ctx && !voice._silentEl) {
        s = 'wait';
        txt = '音频 待激活';
      } else if (voice.diag.stalled > 0) {
        s = 'bad';
        txt = '音频 卡片未播';
      } else if (voice.diag.drop) {
        s = 'bad';
        txt = '音频 被拒绝';
      } else if (player && player.articulating && via === 'element') {
        txt = '音频 播放中';
      } else if (voice.level > 0.02) {
        txt = `音频 ${voice.level.toFixed(2)}`;
      }
      sndEl.dataset.s = s;
      sndEl.textContent = txt;
    }
  }

  // ---- 交互绑定 ----
  const sendBtn = $('send');
  const submit = () => {
    const v = askEl.value;
    askEl.value = '';
    ask(v);
  };
  sendBtn.onclick = submit;
  $('stop').onclick = () => stop();
  askEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  if (muteBtn) {
    // 初始状态就要和真实值一致，否则按钮写着"声音"、实际却已经静音
    muteBtn.textContent = voice.muted ? '🔇 已静音' : '🔊 声音';
    muteBtn.onclick = () => {
      voice.muted = !voice.muted;
      // 文案要能看出来"现在是什么状态"，而不是"点了会发生什么"——
      // 之前显示"静音"时用户以为是待播状态，其实是已经静音了。
      muteBtn.textContent = voice.muted ? '🔇 已静音' : '🔊 声音';
      muteBtn.classList.toggle('off', voice.muted);
      if (!voice.muted) voice.unlock();
    };
  }

  // 试听：走一遍真实语音路径（合成 → 元素播放 → 读推进量），
  // 而不是放个 660Hz 正弦。正弦只能证明 WebAudio 图内有信号，
  // 图有信号、设备没声，恰恰就是之前那个「显示正常但听不见」的坑。
  const sndBtn = $('sndtest');
  if (sndBtn) {
    sndBtn.onclick = async () => {
      sndBtn.disabled = true;
      sndBtn.textContent = '检测中';
      try {
        const r = await voice.ping();
        const tag = r.elOk ? '元素播放' : r.mode === 'webaudio' ? 'WebAudio' : '未激活';
        latEl.textContent = `声音：${r.msg}（${tag} · 推进 ${r.elPos}s${
          r.peak != null ? ' · 电平 ' + r.peak : ''
        }）${r.ok ? '' : '｜检查系统输出设备'}`;
        sndBtn.textContent = r.ok ? '在播' : '无声';
        sndBtn.classList.toggle('off', !r.ok);
        reportAudio(`ping:${r.msg}`, true);
      } catch (e) {
        latEl.textContent = `声音检测失败：${e.message}`;
        sndBtn.textContent = '试听';
      } finally {
        setTimeout(() => {
          sndBtn.disabled = false;
        }, 400);
      }
    };
  }

  // 兜底：任何一次点击/按键都试着把音频上下文唤醒。
  // 内嵌 webview 里首次授权有时不认按钮的 click，多给几次机会。
  const kick = () => {
    if (!voice.ctx) return voice.unlock();
    if (voice.ctx.state !== 'running') voice.unlock();
  };
  window.addEventListener('pointerdown', kick, { passive: true });
  window.addEventListener('keydown', kick, { passive: true });

  fetch('/api/status')
    .then((r) => r.json())
    .then((s) => {
      ttsOk = !!s.tts;
      provEl.textContent = `${s.provider}${s.model ? ' · ' + s.model : ''}${s.tts ? ' · 🔊' : ''}`;
      if (s.hint) provEl.title = s.hint;
      if (s.provider === 'mock') provEl.classList.add('muted');
      if (!s.tts && muteBtn) {
        muteBtn.textContent = '无声';
        muteBtn.classList.add('off');
        muteBtn.disabled = true;
      }
    })
    .catch(() => {
      provEl.textContent = '离线';
    });

  setState('idle');

  window.addEventListener('beforeunload', () => writeMoodSnap(mood));

  return {
    tick,
    ask,
    stop,
    /** 调试用：直接摸到播放器内部（音素轨道、当前句、时钟） */
    player: () => player,
    /** 调试用：情绪 / 记忆 / 节奏这三层的实时状态 */
    mood,
    memory,
    rhythm,
    clearExpiry() {
      exprExpireAt = 0;
    },
    voice,
    stats: () => ({
      state: mixer.__state,
      segments: player ? player.segmentsPlayed : 0,
      events: player ? player.eventCount : 0,
      backlog: player ? player.backlog : 0,
      articulating: player ? player.articulating : false,
      preset: mixer.preset,
      mix: mixer.presetMix.map((m) => `${m.name}:${m.w.toFixed(2)}`),
      exprSrc: lastSrc,
      gain: mixer.presetGain,
      mood: { v: +sem.mood.v.toFixed(3), a: +sem.mood.a.toFixed(3) },
      /** 跨越整场对话的情绪状态（带惯性），和上面那个"当前句"的 mood 不同 */
      longMood: mood.state,
      tendency: mood.tendency,
      facts: memory.facts,
      initiated: rhythm.initiated,
      clauses: sem.clauses,
      tts: ttsOk,
      degraded: player ? !!player.degraded : false,
      clock: voice.ctx ? +voice.ctx.currentTime.toFixed(3) : null,
      level: +voice.level.toFixed(3),
      audio: {
        mode: voice.mode,
        state: voice.ctx ? voice.ctx.state : null,
        muted: voice.muted,
        decodeErr: voice.diag.decodeErr,
        drop: voice.diag.drop,
        via: voice.diag.via,
        stalled: voice.diag.stalled,
        elPos: player && player.cur && player.cur.source ? +player.cur.source.pos.toFixed(2) : null,
      },
      expression: Object.fromEntries(
        [...mixer.rig.channelIndex.keys()]
          .map((id) => [id, mixer.rig.get(id)])
          .filter(([, v]) => v > 0.05)
      ),
    }),
  };
}
