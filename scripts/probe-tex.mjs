/**
 * 把 GLB 里的 KTX2 贴图解成 PNG，用来肉眼确认贴图内容。
 * 之前在 P0 阶段判定「解出来是均匀灰」，但那个结论没有留下证据文件，
 * 现在重新走一遍，并把统计量打出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const dir = path.resolve('basis');
const src = fs.readFileSync(path.join(dir, 'basis_transcoder.js'), 'utf8');
const mod = { exports: {} };
const nodeRequire = createRequire(path.join(dir, 'basis_transcoder.js'));
const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', 'process', 'console',
  src + '\n;return module.exports;');
const BASIS = fn(mod, mod.exports, nodeRequire, path.join(dir, 'basis_transcoder.js'), dir, process, console);
const m = await BASIS({ locateFile: (f) => path.join(dir, f) });
// 不调这一步，KTX2File 拿到的所有状态都是 0（isValid=false、startTranscoding=0），
// 看起来就像"文件坏了"。实际只是 wasm 里的全局状态没初始化。
if (typeof m.initializeBasis === 'function') m.initializeBasis();

const glb = fs.readFileSync('assets/facecap.glb');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bv = json.bufferViews[json.images[0].bufferView];
const off = binStart + (bv.byteOffset || 0);
const ktx2 = new Uint8Array(glb.buffer, glb.byteOffset + off, bv.byteLength);
console.log('ktx2 长度', bv.byteLength, 'magic', Buffer.from(ktx2.slice(0, 12)).toString('hex'));

// 拷一份，避免 emscripten 看到的是 Node Buffer 的池化底层
const copy = new Uint8Array(ktx2);
const file = new m.KTX2File(copy);
console.log('isValid', file.isValid());
const ok = file.startTranscoding();
console.log('startTranscoding', ok);
if (!ok) {
  // 换一条路：用 BasisFile（BasisLZ 走这个入口也能试）
  file.close?.();
  process.exit(1);
}
const w = file.getWidth();
const h = file.getHeight();
const fmt = m.transcoder_texture_format.cTFRGBA32;
const size = file.getImageTranscodedSizeInBytes(0, 0, 0, fmt);
console.log('尺寸', w, h, 'RGBA 字节', size);
const dst = new Uint8Array(size);
// 参数顺序同 three 的 KTX2Loader：
// (dst, level, layer, face, format, getAlphaForOpaquePixels, decodeSRGB, byteStride)
const tOk = file.transcodeImage(dst, 0, 0, 0, fmt, 0, -1, -1);
console.log('transcodeImage', tOk);
file.close();

const png = new PNG({ width: w, height: h });
png.data = Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength);
fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/face_skin.png', PNG.sync.write(png));

// 统计：均值 / 方差 / 独立颜色数
let n = w * h;
let s = [0, 0, 0];
const mn = [255, 255, 255];
const mx = [0, 0, 0];
const seen = new Set();
for (let i = 0; i < n; i++) {
  for (let c = 0; c < 3; c++) {
    const v = dst[i * 4 + c];
    s[c] += v;
    if (v < mn[c]) mn[c] = v;
    if (v > mx[c]) mx[c] = v;
  }
  seen.add((dst[i * 4] >> 3) << 10 | (dst[i * 4 + 1] >> 3) << 5 | (dst[i * 4 + 2] >> 3));
}
console.log('均值', s.map((x) => Math.round(x / n)), 'min', mn, 'max', mx, '不同颜色(5bit)', seen.size);
console.log('→ assets/face_skin.png', (fs.statSync('assets/face_skin.png').size / 1024).toFixed(0), 'KB');
