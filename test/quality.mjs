// 「通った」ではなく「中身が保たれているか」を見る試験。
//
// matrix.mjs は変換が成功して読み直せることまでしか見ていない。それだけでは
// **真っ白な絵や空の文書でも合格してしまう**。ここでは往復させて元と比べる。
//
//   絵   : png → その形式 → png に戻し、元との画素の差（RMSE）を測る
//   文書 : md → その形式 → 素の文章に戻し、元の言葉が残っているかを見る
//
//   node test/quality.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'kaeru-quality-'));

const src = join(WORK, 'seed.png');
const seedMd = join(WORK, 'seed.md');
const WORDS = ['見出し', '本文です', 'ASCII'];

const quiet = async (cmd, args) => {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 120_000, maxBuffer: 32 << 20 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e.stderr ?? String(e) };
  }
};

// 元の絵は「写真のような絵」にする。単色だと、色を減らす形式でも差が出ず甘くなる
await quiet('magick', ['-size', '160x120', 'plasma:fractal', '-depth', '8', src]);
writeFileSync(seedMd, '# 見出し\n\n本文です。ASCII and 日本語。\n\n- 一\n- 二\n');

const listOf = async (family) => {
  const { stdout } = await run('node', [join(HERE, '..', 'server.js'), '--list'], { maxBuffer: 32 << 20 });
  const pairs = stdout.trim().split('\n').map((k) => k.split('>'));
  return [...new Set(pairs.filter(([f]) => f === family).map(([, t]) => t))];
};

// ── 絵: 往復して画素の差を測る ────────────────────────────────────
const imageTargets = (await listOf('png')).filter((t) => t !== 'pdf');
const image = [];
for (const t of imageTargets) {
  const mid = join(WORK, `rt.${t}`);
  const back = join(WORK, `rt-${t}.png`);
  if (!(await quiet('magick', [src, mid])).ok) { image.push({ format: t, note: '往路で落ちた' }); continue; }
  if (!(await quiet('magick', [mid, back])).ok) { image.push({ format: t, note: '復路で落ちた' }); continue; }
  // compare は差があると終了コードが 0 以外になる。数値は stderr に出る
  const r = await quiet('magick', ['compare', '-metric', 'RMSE', src, back, 'null:']);
  const m = (r.stderr || '').match(/\(([\d.]+)\)/);
  image.push({ format: t, rmse: m ? Number(m[1]) : null });
}

// ── 文書: 往復して言葉が残っているか見る ──────────────────────────
const docTargets = (await listOf('md')).filter((t) => !['pdf', 'icml'].includes(t));
const doc = [];
for (const t of docTargets) {
  const mid = join(WORK, `d.${t}`);
  const back = join(WORK, `d-${t}.txt`);
  const fwd = await quiet('node', [join(HERE, 'convert-once.mjs'), seedMd, t, mid]);
  if (!fwd.ok) { doc.push({ format: t, note: '往路で落ちた' }); continue; }
  const rev = await quiet('node', [join(HERE, 'convert-once.mjs'), mid, 'txt', back]);
  if (!rev.ok) { doc.push({ format: t, note: '戻せない（この形式は読み込みに未対応）' }); continue; }
  const text = await readFile(back, 'utf8').catch(() => '');
  doc.push({ format: t, kept: WORDS.filter((w) => text.includes(w)).length, of: WORDS.length });
}

const clean = (xs) => xs.filter((x) => !x.note);
const lossless = clean(image).filter((x) => x.rmse === 0).map((x) => x.format);
const lossy = clean(image).filter((x) => x.rmse > 0).sort((a, b) => b.rmse - a.rmse);
const fullText = clean(doc).filter((x) => x.kept === x.of).map((x) => x.format);
const lostText = clean(doc).filter((x) => x.kept < x.of);

const report = { ranAt: new Date().toISOString(), image, doc };
await writeFile(join(HERE, 'quality-result.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(`絵: 往復して画素が完全に一致 ${lossless.length} / ${clean(image).length} 形式`);
console.log(`  ずれたもの（大きい順・0〜1）: ${lossy.slice(0, 8).map((x) => `${x.format} ${x.rmse.toFixed(4)}`).join(', ')}`);
console.log(`文書: 往復して言葉が全部残った ${fullText.length} / ${clean(doc).length} 形式`);
if (lostText.length) console.log(`  欠けたもの: ${lostText.map((x) => `${x.format} ${x.kept}/${x.of}`).join(', ')}`);
const skipped = [...image, ...doc].filter((x) => x.note);
if (skipped.length) console.log(`  測れなかったもの: ${skipped.map((x) => `${x.format}(${x.note})`).join(', ')}`);
console.log('詳しくは test/quality-result.json');
