import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ARKIT_ORDER, CHANNEL_IDS, nameKey } from './channels.js';
import { bakeSkin, bakeEye, toCanvas } from './skin.js';
import { reshape, reshapeEye, reshapeMesh } from './reshape.js';
import { createHair } from './hair.js';

/**
 * 加载头部模型并建立通道映射。
 * 返回的 rig 把「ARKit 语义通道」和「模型 morph target 索引」解耦，
 * 上层动画系统只认语义通道。
 */
export async function loadRig(renderer, url) {
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  ktx2.detectSupport(renderer);
  // 强制输出未压缩 RGBA：ASTC/BC 等压缩纹理在软件渲染器和部分老 GPU 上会
  // 静默解码失败。这个模型自带的贴图本身是空的（见 skin.js 的说明），
  // 保留 loader 只是为了将来换带有效贴图的模型时不用再改这里。
  ktx2.workerConfig = {
    astcSupported: false,
    etc1Supported: false,
    etc2Supported: false,
    dxtSupported: false,
    bptcSupported: false,
    pvrtcSupported: false,
  };

  const loader = new GLTFLoader();
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;

  let head = null;
  model.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences && o.morphTargetInfluences.length >= 40) {
      head = o;
    }
  });
  if (!head) throw new Error('模型里找不到带 morph target 的头部网格');

  // ---- 通道映射：ARKit 语义名 -> morph target index ----
  const dict = head.morphTargetDictionary || {};
  const indexByKey = new Map();
  for (const [name, idx] of Object.entries(dict)) {
    indexByKey.set(nameKey(name), idx);
  }
  // 没有 targetNames 时按 ARKit 标准顺序兜底
  const hasNames = Object.keys(dict).length > 0;

  const channelIndex = new Map();
  const missing = [];
  for (const id of CHANNEL_IDS) {
    let idx = indexByKey.get(nameKey(id));
    if (idx === undefined && !hasNames) {
      const pos = ARKIT_ORDER.indexOf(id);
      if (pos >= 0 && pos < head.morphTargetInfluences.length) idx = pos;
    }
    if (idx === undefined) missing.push(id);
    else channelIndex.set(id, idx);
  }

  // ---- 归一化：居中 + 统一尺寸，后续所有动画数值都基于此尺度 ----
  const root = new THREE.Group();
  root.add(model);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // 朝向：双眼中点相对头部中心的方向就是脸朝的方向
  const eyeL = model.getObjectByName('grp_eyeLeft') || model.getObjectByName('eyeLeft');
  const eyeR = model.getObjectByName('grp_eyeRight') || model.getObjectByName('eyeRight');
  let faceDirZ = 1;
  if (eyeL && eyeR) {
    const a = eyeL.getWorldPosition(new THREE.Vector3());
    const b = eyeR.getWorldPosition(new THREE.Vector3());
    const mid = a.add(b).multiplyScalar(0.5);
    faceDirZ = mid.z - center.z >= 0 ? 1 : -1;
  }
  if (faceDirZ < 0) root.rotation.y = Math.PI;

  model.position.sub(center);
  const span = Math.max(size.x, size.y, size.z) || 1;
  root.scale.setScalar(1 / span);

  root.updateMatrixWorld(true);

  // ---- 收集几何锚点 ----
  // 眼睛和牙齿的位置决定了唇、眼周、鼻这些区域在脸上的落点。
  // 与其硬编码坐标（换模型就全错），不如从几何里量出来。
  const eyeMeshes = [];
  for (const n of ['grp_eyeLeft', 'grp_eyeRight', 'eyeLeft', 'eyeRight']) {
    const node = model.getObjectByName(n);
    node?.traverse((o) => {
      if (o.isMesh && !eyeMeshes.includes(o)) eyeMeshes.push(o);
    });
  }
  // 有时眼节点名字不固定，退而求其次：530 顶点的网格就是眼球
  if (!eyeMeshes.length) {
    model.traverse((o) => {
      if (o.isMesh && o !== head && o.geometry?.attributes?.position?.count === 530) eyeMeshes.push(o);
    });
  }

  const eyeAnchors = eyeMeshes.map((m) => {
    const bb = new THREE.Box3().setFromObject(m);
    const c = bb.getCenter(new THREE.Vector3());
    const s = bb.getSize(new THREE.Vector3());
    return { center: c, radius: Math.max(s.x, s.y, s.z) * 0.5, mesh: m };
  });
  // 左右按 x 排序（此时脸已朝 +z）
  eyeAnchors.sort((a, b) => a.center.x - b.center.x);

  const teeth = (() => {
    let found = null;
    model.traverse((o) => {
      if (o.isMesh && o !== head && !eyeMeshes.includes(o) && o.geometry?.attributes?.position) {
        if (o.geometry.attributes.position.count > 200) found = o;
      }
    });
    return found;
  })();

  const browCenters = [];
  for (const e of eyeAnchors) {
    browCenters.push(new THREE.Vector3(e.center.x, e.center.y + 0.072, e.center.z + 0.012));
  }

  const anchors = {
    eyeL: eyeAnchors[0]?.center ?? new THREE.Vector3(-0.06, 0.02, 0.1),
    eyeR: eyeAnchors[1]?.center ?? new THREE.Vector3(0.06, 0.02, 0.1),
    mouth: teeth
      ? new THREE.Box3().setFromObject(teeth).getCenter(new THREE.Vector3())
      : new THREE.Vector3(0, -0.16, 0.1),
    browY: browCenters[0]?.y,
  };

  // ---- 造型：把「大饼脸 + 鸡蛋头」捏回正常人的比例 ----
  // 必须在烘焙之前：贴图是按变形后的几何烘的，顺序反了整张脸都会错位。
  //
  // 注意只动 head。眼球和牙齿是独立网格，一旦跟着搬就得在**有旋转的父级**里
  // 反算局部坐标（worldToLocal + position.copy + 围绕局部原点 scale），
  // 任何一步的误差都会污染 anchors —— 而 anchors 决定唇在哪、眉毛多长，
  // 错一点就是「整张脸一大块红」。眼球宁可先不搬，让它在收窄后的眼裂里
  // 显得大一点，看渲染结果再决定要不要补偿。
  const qs = new URLSearchParams(location.search);
  if (!qs.has('noshape')) {
    const field = reshape(head, anchors);
    // 眼球：尺寸不动，只后推一点点。
    //
    // 这里试过缩到 0.80，是错的：眼球直径 0.44u，缩小后 0.35u，
    // 反而比眼裂（收窄后约 0.40u）还窄 —— 眼裂里能看见整个球，
    // 连两侧的球面都露出来，读作「两颗白瓷珠」。
    // 正确的做法是让球比眼裂大、往后嵌进去：两侧被眼睑挡住，
    // 露出来的只有中间的虹膜和一点眼白，这才是真人眼睛的样子。
    const eyeOff = new THREE.Vector3(0, -0.006, -0.012);
    for (const e of eyeAnchors) {
      const c = reshapeEye(e.mesh, field, 0.85, eyeOff);
      if (c) {
        e.center.copy(c);
        const bb = new THREE.Box3().setFromObject(e.mesh);
        const sz = bb.getSize(new THREE.Vector3());
        e.radius = Math.max(sz.x, sz.y, sz.z) * 0.5;
      }
    }
    model.updateMatrixWorld(true);
    // 牙齿跟着走（FACE_Y 压了下巴，牙齿不跟就会掉出嘴外）
    if (teeth) {
      const c = reshapeMesh(teeth, field);
      anchors.mouth.copy(c);
    }
    // 眼球换了位置，锚点必须重算：唇宽、眉毛长度、眼周阴影全按它换算
    if (eyeAnchors.length >= 2) {
      anchors.eyeL.copy(eyeAnchors[0].center);
      anchors.eyeR.copy(eyeAnchors[1].center);
      anchors.browY = (anchors.eyeL.y + anchors.eyeR.y) / 2 + 0.072;
    }
  }

  // ---- 烘焙皮肤与眼球贴图 ----
  const skin = bakeSkin(head, anchors, { size: 1024 });
  const eyeTex = eyeAnchors.length ? bakeEye(eyeMeshes, eyeAnchors, 512) : null;
  const eyeCanvas = eyeTex ? toCanvas(eyeTex.albedo, eyeTex.width, eyeTex.height, 3) : null;

  // ---- 材质 ----
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // 保持 CanvasTexture 默认的 flipY=true：bake 时用 (1-v)*size 绘制，两者配套。
  // 另外这几个贴图必须关掉 mipmap 以外的「自动重采样」：
  // minFilter 保持三线性，但 anisotropy 拉满是让斜视角下不糊的关键。
  const makeTex = (data, ch, srgb) => {
    const t = new THREE.CanvasTexture(toCanvas(data, skin.size, skin.size, ch));
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    // bake 时按 v*size 绘制，所以这里必须 flipY=false：
    // flipY=true 会让采样取到 (1-v)，整张脸就上下错位了。
    t.flipY = false;
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
    return t;
  };

  // 调试开关：?nonormal / ?noroughtex 用来隔离是 albedo 还是别的贴图在出问题
  const skinMap = makeTex(skin.albedo, 3, true);
  // roughnessMap 读的是 G 通道，这里三通道同值，省得再分支
  const roughMap = qs.has('noroughtex') ? null : makeTex(skin.rough, 1, false);
  const normalMap = qs.has('nonormal') ? null : makeTex(skin.normal, 3, false);

  // 调试图：把已知世界位置的两种行方向落点都画出来。
  // 只有带 ?marks 时才生成 —— 它要多复制一整张 1024² 画布，
  // 正常加载时纯属浪费内存。
  const marked = !qs.has('marks')
    ? null
    : (() => {
        const c = toCanvas(skin.albedo, skin.size, skin.size, 3);
        const ctx = c.getContext('2d');
        ctx.font = '15px monospace';
        for (const mk of skin.marks || []) {
          ctx.fillStyle = '#ff2b2b';
          ctx.beginPath();
          ctx.arc(mk.x, mk.yA, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#2bff5c';
          ctx.beginPath();
          ctx.arc(mk.x, mk.yB, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(mk.label, mk.x + 9, mk.yA - 7);
        }
        return c;
      })();

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.material?.dispose?.();
    // 参与自阴影：头部既是投影者也是接收者（鼻影落在脸颊上、眼睑落在眼球上）
    o.castShadow = true;
    o.receiveShadow = true;

    if (o === head) {
      o.material = makeSkinMaterial({ skinMap, roughMap, normalMap });
      paintCavity(o);
    } else if (eyeMeshes.includes(o)) {
      o.material = eyeTex ? makeEyeMaterial(eyeTex, maxAniso) : new THREE.MeshPhysicalMaterial({ color: 0xeeeeea });
    } else {
      // 牙齿：偏暖的象牙色，别用纯白——纯白在口腔暗部里会跳出来像塑料板
      o.material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0xe4d8c6),
        roughness: 0.42,
        clearcoat: 0.25,
        clearcoatRoughness: 0.5,
      });
    }
  });

  // 发型在世界坐标中生成，再反变换到 root 局部；之后头摆、呼吸都会带着它走。
  // 几何头发（hair.js）因坐标系/遮挡问题暂不稳定，默认关闭，用皮肤贴图的
  // 发际线表现；加 ?hair 参数可启用几何头发继续调试。
  root.updateMatrixWorld(true);
  const hair = qs.has('hair') ? createHair(anchors) : new THREE.Group();
  hair.applyMatrix4(root.matrixWorld.clone().invert());
  root.add(hair);

  /**
   * 皮肤材质。
   *
   * 真实感和「塑料感」的差别，一半在贴图，另一半在这三件事：
   *   1. 次表面散射——皮肤不是不透明漫反射板，光会在角质层下走一段再出来，
   *      所以明暗交界是软的，轮廓边缘会透出血色。
   *   2. 粗糙度不均——额头和鼻梁出油、嘴唇湿润，全脸同一个 roughness 立刻变石膏。
   *   3. 极弱的清漆层——皮肤表面那层薄薄的皮脂膜，给出「湿润但不反光」的高光。
   */
  function makeSkinMaterial({ skinMap: m }) {
    // 清透日系风：回到 Physical 材质 + 柔和次表面散射，让皮肤有「透」的感觉，
    // 而不是 toon 分阶的平涂。用偏冷的暖白散射保留清纯感，避免写实的红血丝。
    const m2 = new THREE.MeshPhysicalMaterial({
      map: m,
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      clearcoat: 0.18,
      clearcoatRoughness: 0.55,
      // 次表面散射：浅色透明感的关键，散射色偏粉白而不是血红
      thickness: 0.35,
      ior: 1.4,
    });
    m2.onBeforeCompile = (shader) => {
      // 在 normal_fragment_begin 之后注入：此时 normal 变量已正确定义，
      // 且我们补的是漫反射分量，直接作用在最终颜色上。
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // 菲涅尔暖红透光：只在轮廓边缘补一点粉红，模拟皮肤透光。
        // 用 geometryNormal（世界空间几何法线）做点积，避免依赖材质法线贴图。
        float _fres = pow(1.0 - abs(dot(normalize(vViewPosition), normalize(vNormal))), 3.0);
        diffuseColor.rgb += vec3(0.055, 0.022, 0.028) * _fres;`
      );
    };
    return m2;
  }

  function makeEyeMaterial(tex, aniso) {
    const m = new THREE.CanvasTexture(toCanvas(tex.albedo, tex.width, tex.height, 3));
    m.colorSpace = THREE.SRGBColorSpace;
    m.anisotropy = aniso;
    // 和皮肤贴图同理：bakeEye 按 v = acos(dir.y)/π 写第 0 行 = 眼球顶部，
    // CanvasTexture 默认 flipY=true 会把 v=0 取到图像最后一行，
    // 于是整张经纬图上下颠倒 —— 上眼睑的阴影被贴到眼球下半部去了。
    m.flipY = false;
    m.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({
      map: m,
      roughness: 0.22,
      metalness: 0,
      // 角膜是全身最光滑的表面，但**不能整片反光**：
      // clearcoat 给满 + envMap 拉高，眼球两侧那个曲率最大的位置会反射出一圈
      // 惨白的弧，看起来像两颗白瓷珠或者金属球。真人的眼白是浅灰带血色的，
      // 高光应该只是一个点（主光的方向），不是整条边。
      clearcoat: 0.35,
      clearcoatRoughness: 0.12,
      ior: 1.38,
      envMapIntensity: 0.22,
    });
  }

  // 眉毛已经烘进皮肤贴图（会随 morph 一起变形）。
  // 旧版用几何椭球当眉毛的那套代码已删除：独立 mesh 必须手动追坐标，
  // 而 updateBrows 从未被调用过，那些「眉毛」一直是钉在原地的，
  // 表情一动就和眉骨脱节。

  /**
   * 口腔内壁压暗。
   *
   * 这个模型的口腔内壁是头部网格的一部分，用同一套皮肤材质。张嘴时是一整片
   * 和脸同色的浅色面，看着像塞了张纸板。真实口腔几乎不反光，所以按「离口腔
   * 中心的距离 + 深度」做平滑衰减压暗，唇缘保持肤色，往里的面迅速变暗。
   *
   * 做成顶点色乘数而不是直接改贴图：口腔内壁和唇面在 UV 上可能挨得很近，
   * 逐像素判断容易把唇也一起压暗；顶点级反而干净，而且这个区域顶点够密。
   */
  function paintCavity(mesh) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    const macro = anchors.mouth;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      let k = 1;
      // 范围必须比唇本身小：唇宽半径约 0.058，这里给 0.05 就已经贴到唇线了。
      // 之前给 0.086 把整片唇一起压暗，上唇直接消失。
      const md = Math.hypot((v.x - macro.x) / 0.050, (v.y - macro.y) / 0.034);
      if (md < 1.1) {
        // 关键是这个 z 方向：唇面比口腔内壁更靠前（z 更大），
        // 所以「越靠后越暗」。写成 macro.z - x → macro.z 会得到相反的结果，
        // 把唇当成内壁压掉。
        const depth = smoothstep(macro.z - 0.005, macro.z - 0.055, v.z);
        if (depth > 0.001) {
          const a = smoothstep(1.1, 0.45, md) * depth;
          k = 1 - a * 0.92;
        }
      }
      colors[i * 3] = k;
      colors[i * 3 + 1] = k * 0.97;
      colors[i * 3 + 2] = k * 0.96;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  const influences = head.morphTargetInfluences;
  const baseYaw = root.rotation.y;

  const rig = {
    root,
    head,
    hair,
    channelIndex,
    missing,
    anchors,
    skin,
    /** 语义通道 -> 当前值，渲染前统一提交 */
    values: new Float32Array(CHANNEL_IDS.length),
    /** 烘焙产物，调试时可以直接掏出来看 */
    debug: { skinMap, roughMap, normalMap, eyeTex, eyeCanvas, marked },
    set(id, v) {
      const idx = channelIndex.get(id);
      if (idx === undefined) return;
      influences[idx] = v < 0 ? 0 : v > 1 ? 1 : v;
    },
    commit() {
      // three 会在渲染时检测 morphTargetInfluences 变化并上传
      head.morphTargetInfluences = influences;
    },
    get(id) {
      const idx = channelIndex.get(id);
      return idx === undefined ? 0 : influences[idx];
    },
    reset() {
      influences.fill(0);
    },
    /** 头部朝向微调（呼吸、头摆用） */
    setHeadPose(yaw, pitch, roll, lift) {
      root.rotation.y = baseYaw + yaw;
      root.rotation.x = pitch;
      root.rotation.z = roll;
      root.position.y = lift;
    },
  };

  return rig;
}

/** 环境光贴图，让皮肤和眼球有高光层次 */
export function setupEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;
  pmrem.dispose();
  return scene.environment;
}
