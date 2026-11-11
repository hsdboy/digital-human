/**
 * 表情驱动层。
 *
 * 五个独立系统各写自己的一组通道，最后由混合器仲裁：
 *   L0 情绪底色  —— 慢（秒级惯性），只做低幅基线
 *   L1 语义表情  —— 预设 × 包络，中速
 *   L2 微表情    —— 80~250ms 瞬态，绕过平滑，直接叠加
 *   L3 眼神      —— 注视状态机 + 扫视 + 眨眼（眨眼优先级最高，走 max 覆盖）
 *   L4 唇形      —— 留给 TTS 接入，此处只暴露接口
 *
 * 慢通道走临界阻尼弹簧，快通道（眨眼/扫视/微表情）绕过低通，
 * 否则脸会显得困。
 */

import { MICRO_PARTS } from './tags.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rand = (a, b) => a + Math.random() * (b - a);


/**
 * 隐式欧拉积分的临界阻尼弹簧。
 * 显式欧拉在 w*dt > 2 时会发散（42Hz + 33ms 帧就会炸），这里用隐式解，
 * 无条件稳定，高帧率低帧率都不会爆。
 */
export class Spring {
  constructor(freq = 10, zeta = 0.9) {
    this.freq = freq;
    this.zeta = zeta;
    this.x = 0;
    this.v = 0;
  }
  step(target, dt) {
    const w = 2 * Math.PI * this.freq;
    const denom = 1 + 2 * this.zeta * w * dt + w * w * dt * dt;
    this.v = (this.v - dt * w * w * (this.x - target)) / denom;
    this.x += this.v * dt;
    if (!Number.isFinite(this.x)) {
      this.x = target;
      this.v = 0;
    }
    return this.x;
  }
}

/** 不同通道给不同响应速度：眨眼必须锐利，眉要软 */
function freqFor(id) {
  if (id.startsWith('eyeBlink')) return 30;
  if (id.startsWith('eyeLook')) return 18;
  if (id.startsWith('jaw') || id.startsWith('mouth')) return 14;
  if (id.startsWith('eye') || id.startsWith('cheek')) return 10;
  return 8;
}

// ---------------------------------------------------------------- 预设

/**
 * 常驻基调：叠在每一帧表情之上的固定偏移。
 *
 * 这个模型的中性表情是「面无表情」：眼裂本来就窄，嘴角平直，眉骨压得低，
 * 默认渲染出来就是一张板着的脸 —— 这是「丑」的一半来源，和贴图无关。
 *
 * 给一点点睁眼 + 嘴角上扬，同一张脸立刻从「凶」变「温和」。
 * 在所有美化手段里这一步的性价比最高，比磨皮、比调色都直接。
 */
const BASELINE = {
  eyeWideLeft: 0.42,
  eyeWideRight: 0.42,
  mouthSmileLeft: 0.08,
  mouthSmileRight: 0.08,
  browInnerUp: 0.08,
};

export const PRESETS = {
  neutral: {},
  joy: {
    mouthSmileLeft: 0.62, mouthSmileRight: 0.62,
    // eyeSquint 0.3 + cheekSquint 0.42 在这个模型上会把眼睛挤到只剩一条缝，
    // 看起来像「闭眼假笑」。真实的笑眼是下睑上推、眼球仍露 2/3。
    cheekSquintLeft: 0.26, cheekSquintRight: 0.26,
    eyeSquintLeft: 0.12, eyeSquintRight: 0.12,
    browOuterUpLeft: 0.18, browOuterUpRight: 0.18,
    browInnerUp: 0.12,
    mouthDimpleLeft: 0.2, mouthDimpleRight: 0.2,
  },
  sadness: {
    browInnerUp: 0.78,
    browDownLeft: 0.22, browDownRight: 0.22,
    mouthFrownLeft: 0.55, mouthFrownRight: 0.55,
    mouthShrugLower: 0.25,
    eyeSquintLeft: 0.18, eyeSquintRight: 0.18,
    mouthLowerDownLeft: 0.15, mouthLowerDownRight: 0.15,
  },
  anger: {
    browDownLeft: 0.85, browDownRight: 0.85,
    eyeSquintLeft: 0.45, eyeSquintRight: 0.45,
    noseSneerLeft: 0.35, noseSneerRight: 0.35,
    mouthPressLeft: 0.6, mouthPressRight: 0.6,
    jawForward: 0.18,
    mouthShrugUpper: 0.2,
  },
  surprise: {
    browInnerUp: 1,
    browOuterUpLeft: 0.85, browOuterUpRight: 0.85,
    eyeWideLeft: 0.8, eyeWideRight: 0.8,
    jawOpen: 0.42,
    mouthFunnel: 0.22,
  },
  fear: {
    browInnerUp: 1,
    browDownLeft: 0.2, browDownRight: 0.2,
    eyeWideLeft: 1, eyeWideRight: 1,
    mouthStretchLeft: 0.5, mouthStretchRight: 0.5,
    jawOpen: 0.2,
    mouthPressLeft: 0.15, mouthPressRight: 0.15,
  },
  disgust: {
    noseSneerLeft: 0.85, noseSneerRight: 0.85,
    browDownLeft: 0.45, browDownRight: 0.45,
    mouthUpperUpLeft: 0.55, mouthUpperUpRight: 0.55,
    mouthFrownLeft: 0.28, mouthFrownRight: 0.28,
  },
  thinking: {
    browDownLeft: 0.25, browDownRight: 0.12,
    eyeSquintLeft: 0.3, eyeSquintRight: 0.3,
    mouthPressLeft: 0.18, mouthPressRight: 0.18,
    mouthLeft: 0.1,
  },
};

// ---------------------------------------------------------------- 微表情

const MICRO_EVENTS = [
  { name: '内眉一挑', dur: 0.17, parts: [['browInnerUp', 0.14], ['browOuterUpLeft', 0.1], ['browOuterUpRight', 0.09]] },
  { name: '左嘴角抽动', dur: 0.13, parts: [['mouthSmileLeft', 0.12], ['mouthDimpleLeft', 0.1]] },
  { name: '右嘴角抽动', dur: 0.13, parts: [['mouthSmileRight', 0.11], ['mouthDimpleRight', 0.09]] },
  { name: '鼻翼轻张', dur: 0.21, parts: [['noseSneerLeft', 0.1], ['noseSneerRight', 0.07]] },
  { name: '左眼睑轻跳', dur: 0.1, parts: [['eyeSquintLeft', 0.16]] },
  { name: '双唇轻压', dur: 0.26, parts: [['mouthPressLeft', 0.1], ['mouthPressRight', 0.09]] },
];

// ---------------------------------------------------------------- 眨眼

class Blink {
  constructor() {
    this.phase = 'idle';
    this.t = 0;
    this.next = rand(2, 5);
    this.value = 0;
    this.strength = 1;
    this.hold = 0.07;
    this.pendingDouble = 0;
  }

  reset() {
    this.phase = 'idle';
    this.t = 0;
    this.value = 0;
    this.next = rand(2, 5);
  }

  update(dt, engaged) {
    this.t += dt;
    switch (this.phase) {
      case 'idle': {
        const span = engaged ? rand(2.0, 4.0) : rand(3.5, 7.0);
        if (this.t > this.next) {
          this.phase = 'closing';
          this.t = 0;
          this.next = span;
          this.strength = Math.random() < 0.22 ? rand(0.68, 0.86) : 1;
          this.hold = rand(0.05, 0.1);
          this.pendingDouble = Math.random() < 0.125 ? rand(0.2, 0.4) : 0;
        }
        this.value = 0;
        break;
      }
      case 'closing': {
        const k = Math.min(1, this.t / 0.08);
        this.value = this.strength * (k * k * (3 - 2 * k));
        if (k >= 1) {
          this.phase = 'hold';
          this.t = 0;
        }
        break;
      }
      case 'hold': {
        this.value = this.strength;
        if (this.t > this.hold) {
          this.phase = 'opening';
          this.t = 0;
        }
        break;
      }
      case 'opening': {
        const k = Math.min(1, this.t / 0.15);
        const e = 1 - (1 - k) * (1 - k);
        this.value = this.strength * (1 - e);
        if (k >= 1) {
          this.phase = 'idle';
          this.value = 0;
          this.t = 0;
          this.next = this.pendingDouble || rand(2, 5);
        }
        break;
      }
    }
    return this.value;
  }
}

// ---------------------------------------------------------------- 注视

class Gaze {
  constructor() {
    this.baseYaw = 0;
    this.basePitch = 0;
    this.yaw = new Spring(26, 0.85);
    this.pitch = new Spring(26, 0.85);
    this.sacTimer = 0;
    this.sacYaw = 0;
    this.sacPitch = 0;
    this.lookAwayTimer = 0;
    this.lookAwayYaw = 0;
    this.lookAwayPitch = 0;
    this.mode = 'listen';
  }

  setMode(mode) {
    this.mode = mode;
    const base = {
      listen: [0, 0],
      speak: [0.02, 0.02],
      think: [0.34, 0.26],
      idle: [0.06, -0.04],
    }[mode] || [0, 0];
    this.baseYaw = base[0];
    this.basePitch = base[1];
  }

  update(dt) {
    // 微扫视：200~600ms 一次，1~3°
    this.sacTimer -= dt;
    if (this.sacTimer <= 0) {
      this.sacTimer = rand(0.2, 0.6);
      this.sacYaw = rand(-0.055, 0.055);
      this.sacPitch = rand(-0.04, 0.04);
    }

    // 偶尔短暂移开视线
    this.lookAwayTimer -= dt;
    if (this.lookAwayTimer <= 0) {
      this.lookAwayTimer = rand(3, 8);
      const away = Math.random() < 0.5;
      this.lookAwayYaw = away ? rand(-0.22, -0.12) : rand(0.12, 0.22);
      this.lookAwayPitch = rand(-0.06, 0.12);
    }

    const ty = this.baseYaw + this.sacYaw + this.lookAwayYaw * 0.35;
    const tp = this.basePitch + this.sacPitch + this.lookAwayPitch * 0.3;
    return {
      yaw: this.yaw.step(ty, dt),
      pitch: this.pitch.step(tp, dt),
    };
  }
}

// ---------------------------------------------------------------- 说话口型

/**
 * L4 唇形。
 *
 * 有两套驱动源，优先级从高到低：
 *
 *  1. **音素轨道**（`setViseme`）：viseme.js 按拼音查表得到的口型，
 *     每个字带声母段/韵母段，随音频时钟推进。这是默认路径。
 *  2. **音量包络**（内部兜底）：没有音素轨道时（面板手动测试、TTS 无
 *     时间戳），用「音节脉冲 + 指数衰减」造一个可信的开合节奏。
 *
 * 音量不参与决定口型，只做轻度幅度调制：口型该多大由音素决定，
 * 真人也是发「啊」时嘴张得最大、和说话响不响没关系。
 */
class SpeechMouth {
  constructor() {
    this.t = 0;
    this.next = 0.14;
    this.amp = 0;
    this.round = false;
    this.shape = 0;
    /** >=0 时由外部音量驱动（接了 TTS）；-1 表示用内部包络 */
    this.ext = -1;
    /** 音素级口型采样结果；null 表示退回包络 */
    this.vis = null;
    /** 硬通道（闭唇/齿音）的平滑状态 */
    this.closeSm = 0;
    this.rollSm = 0;
  }

  setExternal(level) {
    this.ext = Number.isFinite(level) ? Math.max(-1, Math.min(1, level)) : -1;
  }

  /** 传入 viseme.js 的采样结果；传 null 退回包络驱动 */
  setViseme(v) {
    this.vis = v || null;
  }

  reset() {
    this.amp = 0;
    this.t = 0;
    this.ext = -1;
    this.vis = null;
    this.closeSm = 0;
    this.rollSm = 0;
  }

  update(dt, articulating) {
    // ---- 音素驱动 ----
    if (this.vis) {
      const v = this.vis;
      // 音量只做幅度调制：把重音体现出来，但不夺走口型的决定权。
      // 上界留在 0.72 而不是 0.6，是因为中文 TTS 的响度差异本来就窄，
      // 再压就听不出「重音的字嘴张得更大」这层信息了。
      const rms = this.ext >= 0 ? Math.min(1, this.ext) : 0.55;
      const m = 0.72 + 0.28 * rms;

      // 闭唇和齿音是硬切换，用 15ms 一阶平滑吸收边界毛刺。
      // 时间常数再大一点闭唇就软了，b/p 会听成半个 m。
      const a = 1 - Math.exp(-dt / 0.015);
      this.closeSm += (v.close - this.closeSm) * a;
      this.rollSm += (v.roll - this.rollSm) * a;

      const jaw = v.jaw * m;
      return {
        amp: jaw,
        jaw,
        close: this.closeSm,
        roll: this.rollSm,
        funnel: v.funnel * m,
        pucker: v.pucker * m,
        stretch: v.stretch * m,
        upper: v.upper * m,
        lower: v.lower * m,
      };
    }

    // ---- 音量驱动（无音素时的兜底）----
    if (this.ext >= 0) {
      this.t += dt;
      if (this.t >= this.next) {
        this.t = 0;
        this.next = 0.16 + Math.random() * 0.1;
        this.round = Math.random() < 0.42;
      }
      const k = this.ext;
      return {
        amp: k,
        jaw: k * 0.36,
        close: 0,
        roll: 0,
        stretch: 0,
        funnel: k * (this.round ? 0.05 : 0.12),
        pucker: k * (this.round ? 0.16 : 0.02),
        upper: k * 0.06,
        lower: k * 0.09,
      };
    }

    if (articulating) {
      this.t += dt;
      if (this.t >= this.next) {
        // 新音节：重取幅度与口型（圆唇 / 扁唇交替，口型才有变化）
        this.t = 0;
        this.next = 0.105 + Math.random() * 0.085;
        // 多数音节只是轻启，偶尔才张到明显——全都大张会像在呐喊
        this.amp = Math.random() < 0.62 ? 0.22 + Math.random() * 0.33 : 0.55 + Math.random() * 0.45;
        this.round = Math.random() < 0.4;
      }
    } else {
      this.t += dt;
      this.amp *= Math.exp(-dt * 14);
    }

    const env = this.amp * Math.exp(-this.t * 8.5);
    const k = Math.min(1, env);
    return {
      amp: env,
      jaw: k * 0.34,
      close: 0,
      roll: 0,
      stretch: 0,
      funnel: k * (this.round ? 0.04 : 0.11),
      pucker: k * (this.round ? 0.15 : 0.02),
      upper: k * 0.05,
      lower: k * 0.07,
    };
  }
}

// ---------------------------------------------------------------- 主混合器

export class FaceMixer {
  constructor(rig) {
    this.rig = rig;
    this.presets = Object.keys(PRESETS);
    this.preset = 'neutral';
    /**
     * 表情混合：单表情是 [(name, 1)]，混合表情最多两项。
     * 真实的脸很少只表达一种情绪——"惊喜"是喜悦+惊讶，"苦笑"是喜悦+悲伤。
     * 只做单选的话，情绪一变就是整张脸跳一下，这是数字人最假的地方。
     */
    this.presetMix = [{ name: 'neutral', w: 1 }];

    this.springs = new Map();
    for (const id of rig.channelIndex.keys()) {
      this.springs.set(id, new Spring(freqFor(id), 0.88));
    }

    this.emotion = { valence: 0, arousal: 0 };
    this.emotionTarget = { valence: 0, arousal: 0 };
    this.emotionSpring = new Spring(0.35, 1);
    this.arousalSpring = new Spring(0.35, 1);

    this.blink = new Blink();
    this.gaze = new Gaze();
    this.microTimer = rand(2, 5);
    this.micro = null;

    this.enabled = {
      blink: true,
      gaze: true,
      idle: true,
      micro: true,
      emotion: true,
      preset: true,
      /** 文本情绪推断（与模型标签互补，可单独关掉） */
      semantic: true,
    };

    this.activeCount = 0;
    /** 预设整体幅度：LLM 给的表情强度，1 = 预设原值 */
    this.presetGain = 1;
    /** 说话口型（L4 占位） */
    this.speech = new SpeechMouth();
    this.articulating = false;
    /** 用户手动接管的通道，提交时直接覆盖 */
    this.manual = new Map();
  }

  setPreset(name) {
    if (!PRESETS[name]) return;
    this.preset = name;
    this.presetMix = [{ name, w: 1 }];
  }

  /** 混合表情：[{name:'joy',w:0.68},{name:'surprise',w:0.32}] */
  setPresetMix(list) {
    const clean = (list || []).filter((x) => x && PRESETS[x.name] && x.w > 0);
    if (!clean.length) return;
    const sum = clean.reduce((s, x) => s + x.w, 0) || 1;
    for (const x of clean) x.w /= sum;
    this.presetMix = clean.slice(0, 2);
    this.preset = clean[0].name;
  }

  /**
   * 某个通道在当前表情混合下的目标值。
   *
   * 不能用加权平均：嘴角上扬和嘴角下拉会互相抵消，"苦笑"被平均成一张平脸。
   * 真实面部是肌肉动作单元叠加（FACS），所以取逐通道的最大值，权重开方软化，
   * 副表情既不会被吃掉，也不会盖过主表情。"嘴上在笑、眉在悲"才出得来。
   */
  presetValue(id) {
    const mix = this.presetMix;
    if (mix.length === 1) return PRESETS[mix[0].name][id] || 0;
    let v = 0;
    for (const m of mix) {
      const p = PRESETS[m.name][id];
      if (!p) continue;
      const k = Math.sqrt(m.w);
      if (p * k > v) v = p * k;
    }
    return v;
  }

  setEmotion(valence, arousal) {
    this.emotionTarget.valence = Math.max(-1, Math.min(1, valence));
    this.emotionTarget.arousal = Math.max(-1, Math.min(1, arousal));
  }

  setMode(mode) {
    this.gaze.setMode(mode);
  }

  /** L0：情绪底色，只取低幅，避免"一句一变脸" */
  emotionBase() {
    const v = this.emotion.valence;
    const a = this.emotion.arousal;
    const out = {};
    if (v > 0) {
      out.mouthSmileLeft = 0.26 * v;
      out.mouthSmileRight = 0.26 * v;
      out.cheekSquintLeft = 0.16 * v;
      out.cheekSquintRight = 0.16 * v;
      out.eyeSquintLeft = 0.1 * v;
      out.eyeSquintRight = 0.1 * v;
    } else {
      const n = -v;
      out.mouthFrownLeft = 0.3 * n;
      out.mouthFrownRight = 0.3 * n;
      out.browInnerUp = 0.22 * n;
      out.browDownLeft = 0.08 * n;
      out.browDownRight = 0.08 * n;
    }
    if (a > 0) {
      out.eyeWideLeft = 0.18 * a;
      out.eyeWideRight = 0.18 * a;
      out.browOuterUpLeft = 0.13 * a;
      out.browOuterUpRight = 0.13 * a;
      out.jawOpen = 0.05 * a;
    } else {
      const n = -a;
      out.eyeSquintLeft = (out.eyeSquintLeft || 0) + 0.16 * n;
      out.eyeSquintRight = (out.eyeSquintRight || 0) + 0.16 * n;
      out.browDownLeft = (out.browDownLeft || 0) + 0.1 * n;
      out.browDownRight = (out.browDownRight || 0) + 0.1 * n;
    }
    return out;
  }

  spawnMicro() {
    const ev = MICRO_EVENTS[(Math.random() * MICRO_EVENTS.length) | 0];
    const strength = rand(0.7, 1.15);
    // 左右不对称：整体再叠加一个 5~15% 的随机偏置
    this.micro = {
      ev,
      t: 0,
      dur: ev.dur * rand(0.85, 1.2),
      strength,
      asym: rand(-0.15, 0.15),
    };
  }

  /** 由 LLM 的 <m:...> 事件触发的指定微表情 */
  spawnMicroNamed(part, intensity = 0.75) {
    const parts = MICRO_PARTS[part];
    if (!parts) return false;
    this.micro = {
      ev: { name: part, dur: rand(0.11, 0.24), parts },
      t: 0,
      dur: rand(0.11, 0.24),
      strength: clamp01(intensity),
      asym: rand(-0.12, 0.12),
    };
    return true;
  }

  /** 打断：清空瞬态，300ms 内回中性 */
  panic() {
    this.preset = 'neutral';
    this.presetMix = [{ name: 'neutral', w: 1 }];
    this.presetGain = 1;
    this.micro = null;
    this.speech.reset();
    this.articulating = false;
    this.gaze.setMode('listen');
  }

  update(dt, time) {
    dt = Math.min(dt, 1 / 30);
    const rig = this.rig;
    const targets = new Map();

    // ---- L0 情绪惯性 ----
    this.emotion.valence = this.emotionSpring.step(this.emotionTarget.valence, dt);
    this.emotion.arousal = this.arousalSpring.step(this.emotionTarget.arousal, dt);
    const base = this.enabled.emotion ? this.emotionBase() : {};

    // ---- L1 预设（强度由事件给） ----
    const gain = this.enabled.preset ? this.presetGain : 0;

    for (const [id] of rig.channelIndex) {
      const slow = (base[id] || 0) + this.presetValue(id) * gain;
      targets.set(id, slow);
    }

    // ---- 慢通道过弹簧 ----
    const out = new Map();
    for (const [id, sp] of this.springs) {
      out.set(id, clamp01(sp.step(targets.get(id) || 0, dt)));
    }

    // ---- L2 微表情（瞬态，绕过低通） ----
    const engage = !!this.enabled.preset && this.preset !== 'neutral';
    if (this.enabled.micro) {
      this.microTimer -= dt;
      if (this.microTimer <= 0 && !this.micro) {
        this.spawnMicro();
        this.microTimer = rand(3.2, 9.5) * (engage ? 0.7 : 1);
      }
      if (this.micro) {
        this.micro.t += dt;
        const k = this.micro.t / this.micro.dur;
        if (k >= 1) {
          this.micro = null;
        } else {
          const env = Math.sin(Math.PI * k) * this.micro.strength;
          for (const [ch, amp] of this.micro.ev.parts) {
            const sideBias = ch.endsWith('Left') ? 1 + this.micro.asym : ch.endsWith('Right') ? 1 - this.micro.asym : 1;
            out.set(ch, clamp01((out.get(ch) || 0) + amp * env * sideBias));
          }
        }
      }
    }

    // ---- L3 眼神 ----
    let gz = { yaw: 0, pitch: 0 };
    if (this.enabled.gaze) {
      gz = this.gaze.update(dt);
      const yawR = Math.max(0, gz.yaw);
      const yawL = Math.max(0, -gz.yaw);
      const up = Math.max(0, gz.pitch);
      const down = Math.max(0, -gz.pitch);
      const add = (ch, v) => out.set(ch, clamp01((out.get(ch) || 0) + v));
      if (yawR > 0) { add('eyeLookInLeft', yawR); add('eyeLookOutRight', yawR); }
      if (yawL > 0) { add('eyeLookOutLeft', yawL); add('eyeLookInRight', yawL); }
      if (up > 0) { add('eyeLookUpLeft', up); add('eyeLookUpRight', up); }
      if (down > 0) { add('eyeLookDownLeft', down); add('eyeLookDownRight', down); }
    }

    // 眨眼覆盖（优先级最高）
    if (this.enabled.blink) {
      const v = this.blink.update(dt, engage);
      // 左右 12ms 相位差，避免完全同步
      const left = v;
      const right = Math.max(0, this.blink.phase === 'closing' || this.blink.phase === 'opening'
        ? v * 0.96
        : v);
      out.set('eyeBlinkLeft', Math.max(out.get('eyeBlinkLeft') || 0, left));
      out.set('eyeBlinkRight', Math.max(out.get('eyeBlinkRight') || 0, right));
    }

    // ---- L4 说话口型（音素驱动）----
    const mouth = this.speech.update(dt, this.articulating);
    const mouthOn = mouth.amp > 0.004 || mouth.close > 0.01 || mouth.stretch > 0.01;
    if (mouthOn) {
      const add = (ch, v) => out.set(ch, clamp01((out.get(ch) || 0) + v));
      // 说话时下颌交给口型，表情只保留 35% 的张口。否则「一边惊讶一边
      // 说话」会让嘴一直大张，音素的开合全被表情吞掉，又回到木偶。
      // 嘴角通道仍然归表情——笑起来说话的语义本来就是叠加的。
      out.set('jawOpen', Math.max((out.get('jawOpen') || 0) * 0.35, mouth.jaw));
      add('mouthClose', mouth.close);
      add('mouthFunnel', mouth.funnel);
      add('mouthPucker', mouth.pucker);
      add('mouthStretchLeft', mouth.stretch);
      add('mouthStretchRight', mouth.stretch);
      add('mouthUpperUpLeft', mouth.upper);
      add('mouthUpperUpRight', mouth.upper);
      add('mouthLowerDownLeft', mouth.lower);
      add('mouthLowerDownRight', mouth.lower);
      add('mouthRollLower', mouth.roll);
    }

    // ---- 手动接管（最高优先，绕过弹簧） ----
    for (const [id, v] of this.manual) out.set(id, clamp01(v));

    // ---- 常驻基调（见 BASELINE 的说明）----
    // 眨眼通道用 max 取值，所以这里只加不减，不会把闭眼压成半睁
    for (const id in BASELINE) {
      out.set(id, clamp01((out.get(id) || 0) + BASELINE[id]));
    }

    // ---- 提交 ----
    let active = 0;
    for (const [id, v] of out) {
      rig.set(id, v);
      if (v > 0.01) active++;
    }
    this.activeCount = active;

    // ---- 头颈：呼吸 + 头摆 + 视线跟随 + 说话点头 ----
    if (this.enabled.idle) {
      const breath = Math.sin(time * 1.15);
      const nod = this.articulating ? Math.sin(time * 6.1) * 0.0032 + mouth.amp * 0.004 : 0;
      const yaw = Math.sin(time * 0.31) * 0.014 + Math.sin(time * 0.73 + 1.2) * 0.007 + gz.yaw * 0.16;
      const pitch = Math.sin(time * 0.47 + 0.4) * 0.013 + breath * 0.004 - gz.pitch * 0.1 + nod;
      const roll = Math.sin(time * 0.23 + 2.1) * 0.009;
      rig.setHeadPose(yaw, pitch, roll, breath * 0.004);
    }
  }

  /** 重置所有慢通道到中性 */
  resetPose() {
    this.setPreset('neutral');
    this.presetGain = 1;
    this.emotionTarget.valence = 0;
    this.emotionTarget.arousal = 0;
    for (const sp of this.springs.values()) sp.v = 0;
    this.micro = null;
    this.speech.reset();
    this.articulating = false;
  }
}
