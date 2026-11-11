import { CHANNEL_GROUPS } from './channels.js';

const PRESET_LABELS = {
  neutral: '中性',
  joy: '喜悦',
  sadness: '悲伤',
  anger: '愤怒',
  surprise: '惊讶',
  fear: '恐惧',
  disgust: '厌恶',
  thinking: '思考',
};

/**
 * 右侧控制面板。滑块同时承担「手动调试」和「实时监视」两个作用：
 * 用户拖动后该通道被手动接管，松开其他通道仍由混合器驱动。
 */
export function buildPanel(mixer, rig, hooks) {
  const panel = document.getElementById('panel');

  const presetWrap = document.createElement('div');
  presetWrap.className = 'presets';
  for (const key of Object.keys(PRESET_LABELS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = PRESET_LABELS[key];
    b.dataset.preset = key;
    b.onclick = () => {
      mixer.setPreset(key);
      mixer.presetGain = 1;
      mixer.enabled.preset = true;
      syncPresetButtons();
      hooks.onMode?.(key);
    };
    presetWrap.append(b);
  }

  function syncPresetButtons() {
    const active = new Set(mixer.presetMix.map((m) => m.name));
    presetWrap.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('on', active.has(c.dataset.preset));
    });
  }
  syncPresetButtons();

  // 实时状态：眼睛看不出"这表情是标签给的还是推断出来的"，面板要能看
  const liveEl = document.createElement('div');
  liveEl.className = 'live';
  function renderLive() {
    const src = { tag: '模型标签', sem: '文本推断', hear: '听者反应' }[hooks.exprSrc?.()] || '—';
    const mix = mixer.presetMix;
    const main = PRESET_LABELS[mix[0].name] || mix[0].name;
    const second = mix[1] ? ` ＋${PRESET_LABELS[mix[1].name] || mix[1].name}` : '';
    const emo = mixer.emotion;
    liveEl.innerHTML =
      `<b>${main}${second}</b>` +
      `<span>强度 ${mixer.presetGain.toFixed(2)}</span>` +
      `<span>来源 ${src}</span>` +
      `<span>底色 ${emo.valence >= 0 ? '+' : ''}${emo.valence.toFixed(2)} / ${emo.arousal >= 0 ? '+' : ''}${emo.arousal.toFixed(2)}</span>`;
    const badge = document.getElementById('expr');
    if (badge) badge.textContent = `表情 ${main}${second}`;
  }
  renderLive();

  const emotionRows = [
    { key: 'valence', label: '愉悦度', min: -1, max: 1, color: 'var(--pos)' },
    { key: 'arousal', label: '唤醒度', min: -1, max: 1, color: 'var(--warm)' },
  ].map(({ key, label, color }) => {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = -1;
    input.max = 1;
    input.step = 0.01;
    input.value = 0;
    input.style.setProperty('--fill', color);
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = '0.00';
    input.oninput = () => {
      val.textContent = Number(input.value).toFixed(2);
      const v = Number(document.getElementById('emo-v').value);
      const a = Number(document.getElementById('emo-a').value);
      // 手动拖了就交给用户，别让对话的情绪推断把滑块拽回去
      mixer.autoEmotion = false;
      mixer.setEmotion(v, a);
    };
    input.id = key === 'valence' ? 'emo-v' : 'emo-a';
    row.append(name, input, val);
    return row;
  });

  const toggles = [
    ['blink', '自动眨眼'],
    ['gaze', '注视与扫视'],
    ['idle', '呼吸与头摆'],
    ['micro', '微表情'],
    ['emotion', '情绪底色'],
    ['preset', '表情层（L1）'],
    ['semantic', '文本情绪推断'],
  ].map(([key, label]) => {
    const row = document.createElement('label');
    row.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = mixer.enabled[key];
    box.onchange = () => {
      mixer.enabled[key] = box.checked;
    };
    const span = document.createElement('span');
    span.textContent = label;
    const sw = document.createElement('i');
    row.append(box, sw, span);
    return row;
  });

  const groupsEl = document.createElement('div');
  groupsEl.className = 'groups';
  const sliders = new Map();

  for (const g of CHANNEL_GROUPS) {
    const det = document.createElement('details');
    if (g.key === 'brow' || g.key === 'mouth') det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `<span>${g.label}</span><em>${g.channels.length}</em>`;
    det.append(sum);

    for (const [id, label] of g.channels) {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = label;
      name.title = id;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = 0;
      input.max = 1;
      input.step = 0.01;
      input.value = 0;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = '0';
      input.oninput = () => {
        const v = Number(input.value);
        val.textContent = v.toFixed(2);
        mixer.manual.set(input.dataset.ch, v);
      };
      // 双击滑块恢复自动驱动
      input.ondblclick = () => {
        mixer.manual.delete(input.dataset.ch);
        input.value = 0;
        val.textContent = '0';
      };
      input.dataset.ch = id;
      row.append(name, input, val);
      det.append(row);
      sliders.set(id, { input, val });
    }
    groupsEl.append(det);
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'ghost';
  resetBtn.textContent = '重置表情';
  resetBtn.onclick = () => {
    mixer.resetPose();
    mixer.manual.clear();
    mixer.autoEmotion = true;
    sliders.forEach(({ input, val }) => {
      input.value = 0;
      val.textContent = '0';
    });
    document.getElementById('emo-v').value = 0;
    document.getElementById('emo-a').value = 0;
    syncPresetButtons();
  };

  panel.append(
    section('实时状态', liveEl),
    section('表情预设', presetWrap),
    section('情绪底色（L0）', emotionRows),
    section('自动行为', toggles),
    section('52 个通道（双击恢复自动）', groupsEl, resetBtn)
  );

  // 每 8 帧回读一次自动驱动值，让滑块同步显示
  let frame = 0;
  let lastPreset = mixer.preset;
  return {
    tick() {
      if (++frame % 8) return;
      renderLive();
      // 预设可能被对话层改掉，面板要跟上，否则脸和按钮会互相打架
      if (mixer.preset !== lastPreset) {
        lastPreset = mixer.preset;
        syncPresetButtons();
      }
      for (const [id, { input, val }] of sliders) {
        if (mixer.manual.has(id)) continue;
        if (document.activeElement === input) continue;
        const v = rig.get(id);
        input.value = v;
        val.textContent = v < 0.005 ? '0' : v.toFixed(2);
      }
    },
  };
}

function section(title, ...children) {
  const s = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  s.append(h);
  for (const c of children.flat()) s.append(c);
  return s;
}
