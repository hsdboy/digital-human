import * as THREE from 'three';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

function toonGradient() {
  const data = new Uint8Array([95, 155, 215, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 一条有体积、会收尖的发束（用 CatmullRom 曲线 + 环形截面）。
 * 所有坐标以 u（眼到嘴）为单位，世界坐标。
 */
function makeLock(points, width, depth, material, options = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.45);
  const rings = options.rings || 22;
  const sides = options.sides || 10;
  const positions = [];
  const uvs = [];
  const indices = [];
  const forward = new THREE.Vector3(0, 0, 1);
  const tangent = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const center = new THREE.Vector3();

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    curve.getPoint(t, center);
    curve.getTangent(t, tangent).normalize();
    lateral.crossVectors(tangent, forward).normalize();
    if (lateral.lengthSq() < 0.01) lateral.set(1, 0, 0);
    normal.crossVectors(lateral, tangent).normalize();
    const taper = (0.68 + 0.32 * Math.sin(Math.PI * t)) * (1 - 0.94 * smoothstep(0.68, 1, t));
    const w = width * taper;
    const d = depth * (0.80 + 0.20 * Math.sin(Math.PI * t)) * (1 - 0.90 * smoothstep(0.76, 1, t));
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions.push(
        center.x + lateral.x * ca * w + normal.x * sa * d,
        center.y + lateral.y * ca * w + normal.y * sa * d,
        center.z + lateral.z * ca * w + normal.z * sa * d
      );
      uvs.push(j / sides, t);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 头顶发壳：覆盖头盖骨的球冠。 */
function makeCap(center, radii, material) {
  const around = 72;
  const down = 34;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= around; j++) {
    const phi = (j / around) * Math.PI * 2;
    const frontness = Math.cos(phi);
    // 前发际线略高，后脑覆盖得更低
    const thetaMax = 1.80 + 0.60 * smoothstep(0.1, -1, frontness);
    for (let i = 0; i <= down; i++) {
      const theta = (i / down) * thetaMax;
      const st = Math.sin(theta);
      positions.push(
        center.x + radii.x * st * Math.sin(phi),
        center.y + radii.y * Math.cos(theta),
        center.z + radii.z * st * Math.cos(phi)
      );
      uvs.push(j / around, i / down);
    }
  }
  for (let j = 0; j < around; j++) {
    for (let i = 0; i < down; i++) {
      const a = j * (down + 1) + i;
      const b = (j + 1) * (down + 1) + i;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 清透少女发型：深栗色长发 + 轻薄刘海 + 小蝴蝶结。
 * 全部坐标以 u（眼到嘴）为单位，世界坐标。
 * 头部：眼 y≈0，头顶 ≈ 眼上 1.7u，发际线 ≈ 眼上 0.55u，头半宽 ≈ 1.2u。
 */
export function createHair(anchors) {
  const group = new THREE.Group();
  group.name = 'beauty-hair';
  const mid = anchors.eyeL.clone().add(anchors.eyeR).multiplyScalar(0.5);
  const u = Math.max(1e-5, anchors.mouth.distanceTo(mid));
  const gradient = toonGradient();
  const hairMat = new THREE.MeshToonMaterial({ color: 0x3a2a34, gradientMap: gradient });
  const hairLight = new THREE.MeshToonMaterial({ color: 0x5a3a44, gradientMap: gradient });
  const ribbonMat = new THREE.MeshToonMaterial({ color: 0xe8a8b8, gradientMap: gradient });

  const ox = mid.x;
  const oy = mid.y;
  const oz = mid.z;

  // 关键：head 世界 bbox 高 2.08（center y 0.097），头顶 y≈1.14，发际线 y≈0.35。
  // 眼到嘴 u≈0.18 只是脸的尺度，头整体是它的 6 倍，发壳必须用绝对坐标。
  const TOP = 1.14;    // 头顶世界 y
  const HAIRLINE = 0.40; // 发际线世界 y（额头上缘）
  const BACK = oz - 0.55; // 后脑世界 z

  // ---- 发壳：覆盖头顶与后脑，正面停在发际线（不遮脸）----
  // 球心放头部中心偏上（y≈0.35），radii.y 0.85：顶部到 1.20 贴头顶，
  // 正面 thetaMax 1.80 下缘到 0.16（眉上），后脑 thetaMax 2.40 到 -0.28。
  group.add(
    makeCap(
      new THREE.Vector3(ox, 0.35, oz - 0.25),
      new THREE.Vector3(0.78, 0.85, 0.80),
      hairMat
    )
  );

  // ---- 刘海：分束，发尾停在眉上（y≈0.15）----
  for (let i = 0; i < 7; i++) {
    const s = (i - 3) / 3;
    const rootX = ox + s * 0.55;
    const tipX = ox + s * 0.66 + 0.03;
    const tipY = 0.16 + 0.04 * Math.abs(s);
    const z = oz + (0.42 - 0.06 * Math.abs(s));
    group.add(
      makeLock(
        [
          new THREE.Vector3(rootX * 0.92 + ox * 0.08, HAIRLINE + 0.12, oz + 0.08),
          new THREE.Vector3(rootX, HAIRLINE - 0.02, z - 0.03),
          new THREE.Vector3((rootX + tipX) * 0.5, 0.22, z + 0.03),
          new THREE.Vector3(tipX, tipY, z + 0.06),
        ],
        0.18,
        0.06,
        hairMat
      )
    );
  }

  // ---- 脸侧长发：决定「女性发型」的关键轮廓 ----
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = ox + side * (0.72 + k * 0.09);
      const z = oz + (0.15 - k * 0.20);
      group.add(
        makeLock(
          [
            new THREE.Vector3(ox + side * 0.66, HAIRLINE + 0.05, oz - 0.08),
            new THREE.Vector3(x, oy + 0.30, z),
            new THREE.Vector3(x + side * 0.05, oy - 0.85, z + 0.06),
            new THREE.Vector3(x + side * 0.10, oy - (2.10 - k * 0.15), z + 0.14),
          ],
          0.20 - k * 0.02,
          0.09,
          k === 0 ? hairLight : hairMat
        )
      );
    }
  }

  // ---- 后脑长发：几束垂在脑后 ----
  for (let i = 0; i < 7; i++) {
    const s = (i - 3) / 3;
    const x = ox + s * 0.62;
    const z = BACK - (0.25 + 0.12 * (1 - Math.abs(s)));
    group.add(
      makeLock(
        [
          new THREE.Vector3(x * 0.7 + ox * 0.3, HAIRLINE + 0.05, z + 0.15),
          new THREE.Vector3(x, oy + 0.20, z),
          new THREE.Vector3(x, oy - 0.85, z + 0.04),
          new THREE.Vector3(x + s * 0.06, oy - 2.30, z + 0.12),
        ],
        0.21,
        0.12,
        i % 3 === 0 ? hairLight : hairMat
      )
    );
  }

  // ---- 左侧小蝴蝶结 ----
  const bow = new THREE.Group();
  bow.position.set(ox - 0.78, HAIRLINE + 0.05, oz + 0.26);
  bow.rotation.z = -0.18;
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), ribbonMat);
    wing.scale.set(0.12, 0.075, 0.038);
    wing.position.x = side * 0.10;
    wing.rotation.z = side * 0.42;
    wing.castShadow = true;
    bow.add(wing);
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), ribbonMat);
  knot.scale.setScalar(0.05);
  bow.add(knot);
  group.add(bow);

  return group;
}
