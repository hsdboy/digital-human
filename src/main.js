import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadRig, setupEnvironment } from './rig.js';
import { FaceMixer } from './anim.js';
import { buildPanel } from './ui.js';
import { startDialogue } from './dialogue.js';
import { buildVisemes, buildSegments, sampleViseme } from './viseme.js';

const canvas = document.getElementById('stage');
const loading = document.getElementById('loading');
const errBox = document.getElementById('error');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
// PCF 而不是 PCFSoft：radius 在 PCFSoft 下会被忽略，而这里正需要一点模糊 ——
// 硬边的自阴影在脸上会读成「塑料贴纸」，柔边才像皮肤挡住光。
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3edf1);

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
camera.position.set(0, 0.02, 2.62);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.02, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 1.7;
controls.maxDistance = 4.6;
controls.minPolarAngle = 1.15;
controls.maxPolarAngle = 1.95;
controls.update();

setupEnvironment(renderer, scene);

const key = new THREE.DirectionalLight(0xfff3e8, 1.95);
key.position.set(1.3, 1.7, 2.1);
// 自阴影：鼻影、鼻翼沟、眼窝、耳根、下巴投在脖子上的那道暗影，
// 全靠这一盏灯投出来。没有阴影时所有形体都被照得一样亮，脸一定是平的。
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.2;
key.shadow.camera.far = 8;
key.shadow.camera.left = -0.75;
key.shadow.camera.right = 0.75;
key.shadow.camera.top = 0.85;
key.shadow.camera.bottom = -0.85;
// 这个头模只有 2694 个顶点，法线是插值出来的、并不贴合每一处起伏，
// 所以 bias 必须给够，否则脸颊上会爬满自阴影的条纹（acne）。
key.shadow.bias = -0.00035;
key.shadow.normalBias = 0.005;
key.shadow.radius = 4;
// 阴影别压满。眼窝、鼻翼这些地方的阴影一深，脸上就多出一圈「黑眼圈 + 憔悴」，
// 是「显老显脏」最直接的来源。真人脸上是有漫反射补光的，阴影永远到不了纯黑。
key.shadow.intensity = 0.62;
const fill = new THREE.DirectionalLight(0xe6eeff, 1.15);
fill.position.set(-2.1, 0.5, 1.1);
const rim = new THREE.DirectionalLight(0xffffff, 1.7);
rim.position.set(-0.4, 1.3, -2.2);
scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xa8a49c, 0.52));

// 地面接触阴影，避免头"飘着"
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(1.1, 48),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.07 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.62;
scene.add(ground);

let mixer = null;
let panel = null;
let rig = null;
let dialogue = null;

async function start() {
  rig = await loadRig(renderer, 'assets/facecap.glb');
  scene.add(rig.root);

  mixer = new FaceMixer(rig);
  window.__mixer = mixer;
  window.__rig = rig;
  window.__three = { THREE, renderer, scene, camera, controls };
  // 音素层没有渲染对象可看，调试时只能在控制台查表：
  //   __viseme.track('妈妈不明白')  → 逐字口型
  //   __viseme.now()               → 这一帧正在生效的口型姿态
  window.__viseme = {
    buildVisemes,
    buildSegments,
    sampleViseme,
    track: (t) => buildVisemes(t),
    now: () => mixer.speech.vis,
  };

  panel = buildPanel(mixer, rig, {
    onMode: (preset) => {
      const mode = preset === 'thinking' ? 'think' : preset === 'neutral' ? 'listen' : 'speak';
      mixer.setMode(mode);
      dialogue?.clearExpiry?.();
    },
    exprSrc: () => dialogue?.stats?.().exprSrc,
  });

  dialogue = startDialogue(mixer, { baseRate: 4.8 });
  window.__dialogue = dialogue;

  // 拼音词典首次查询要建索引，别让它在第一句话开口时才付这笔钱
  buildVisemes('预热');

  loading.classList.add('done');

  const badge = document.getElementById('channels');
  badge.textContent = `${rig.channelIndex.size} / 52 通道`;
  if (rig.missing.length) {
    document.getElementById('missing').textContent = `缺失：${rig.missing.join(', ')}`;
  }

  animate();
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);

let last = performance.now();
let frames = 0;
let fpsAcc = 0;
let fps = 0;
const fpsEl = document.getElementById('fps');
const activeEl = document.getElementById('active');

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  controls.update();
  if (mixer) {
    if (dialogue) dialogue.tick(now / 1000);
    mixer.update(dt, now / 1000);
    panel.tick();
  }
  renderer.render(scene, camera);

  frames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    fps = Math.round(frames / fpsAcc);
    frames = 0;
    fpsAcc = 0;
    fpsEl.textContent = `${fps} fps`;
    if (mixer) activeEl.textContent = `激活 ${mixer.activeCount} 通道`;
  }
}

start().catch((e) => {
  console.error(e);
  loading.classList.add('done');
  errBox.style.display = 'block';
  errBox.textContent = `加载失败：${e.message}\n（如果是纹理相关错误，检查 /basis/ 下的 transcoder 是否可访问）`;
});

resize();
