import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO()
  .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2] || './assets/facecap.glb');

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const targets = prim.listTargets();
    if (!targets.length) continue;

    const base = prim.getAttribute('POSITION');
    const b = base.getArray();
    const n = base.getCount();
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = b[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const size = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    console.log(`# verts=${n} bbox=${size.map((v) => v.toFixed(0)).join('x')}`);
    console.log('# idx\tactive\tcx\tcy\tcz\tdx\tdy\tdz\tmaxDelta');

    targets.forEach((t, i) => {
      const attr = t.getAttribute('POSITION');
      const d = attr.getArray();
      let c = 0, sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, md = 0;
      for (let v = 0; v < n; v++) {
        const ex = d[v * 3], ey = d[v * 3 + 1], ez = d[v * 3 + 2];
        const mag = Math.abs(ex) + Math.abs(ey) + Math.abs(ez);
        if (mag < 1) continue;
        c++;
        sx += b[v * 3]; sy += b[v * 3 + 1]; sz += b[v * 3 + 2];
        ax += ex; ay += ey; az += ez;
        if (mag > md) md = mag;
      }
      if (!c) return console.log(`${i}\t0`);
      const nx = (sx / c - min[0]) / size[0];
      const ny = (sy / c - min[1]) / size[1];
      const nz = (sz / c - min[2]) / size[2];
      const l = Math.hypot(ax, ay, az) || 1;
      console.log(
        `${i}\t${c}\t${nx.toFixed(2)}\t${ny.toFixed(2)}\t${nz.toFixed(2)}\t` +
        `${(ax / l).toFixed(2)}\t${(ay / l).toFixed(2)}\t${(az / l).toFixed(2)}\t${md}`
      );
    });
  }
}
