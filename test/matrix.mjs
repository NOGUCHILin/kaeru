// 対応表に載っている組み合わせを、1つずつ実際に通す試験。
//
// なぜ要るか: 「◯◯通り対応」は道具の自己申告を足し算しても書ける。それは主張であって
// 証拠ではない（規約02）。ここでは server.js の対応表を読み、**本物のファイルを作って
// 本当に変換し、出力が空でないことまで確かめる**。落ちた組み合わせは表から外す。
//
//   node test/matrix.mjs            # 全部
//   node test/matrix.mjs png jpg    # 入力形式を絞る
//
// 結果は test/matrix-result.json に残る（通った数・落ちた組み合わせ・所要時間）。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bin } from '../tools.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const WORK = mkdtempSync(join(tmpdir(), 'kaeru-matrix-'));
const only = process.argv.slice(2);

// ── 素材を作る ────────────────────────────────────────────────────
// 種は3つだけ（絵・音つき動画・文書）。あとはその3つから作る。作れなかった形式は
// 「素材が用意できなかった」として試験から外し、落ちた扱いにはしない。
const seed = {
  png: join(WORK, 'seed.png'),
  mp4: join(WORK, 'seed.mp4'),
  wav: join(WORK, 'seed.wav'),
  md: join(WORK, 'seed.md'),
  obj: join(WORK, 'seed.obj'),
  csv: join(WORK, 'seed.csv'),
  svg: join(WORK, 'seed.svg'),
};

const quiet = async (cmd, args) => {
  if (!cmd) return false; // その道具がこの機械に無い
  try {
    await run(cmd, args, { timeout: 120_000, maxBuffer: 32 << 20 });
    return true;
  } catch {
    return false;
  }
};

const makeSeeds = async () => {
  await quiet(bin('magick'), ['-size', '64x48', 'gradient:red-blue', seed.png]);
  await quiet(bin('ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', seed.mp4]);
  await quiet(bin('ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', seed.wav]);
  writeFileSync(seed.md, '# 見出し\n\n本文です。ASCII and 日本語。\n\n- 一\n- 二\n');
  writeFileSync(seed.obj, [
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1', 'v 1 0 1', 'v 1 1 1', 'v 0 1 1',
    'f 1 2 3', 'f 1 3 4', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5',
    'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8', '',
  ].join('\n'));
  writeFileSync(seed.csv, '名前,数量\n髙橋,3\n波～,10\n');
  writeFileSync(seed.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">' +
    '<rect width="64" height="48" fill="teal"/></svg>');
};

// 入力形式ごとの素材の作り方。作れたものだけが試験の対象になる。
const MODEL_FORMAT = {
  stl: 'stl', obj: 'obj', ply: 'ply', dae: 'collada', '3mf': '3mf', fbx: 'fbx',
  glb: 'glb2', gltf: 'gltf2',
};
const DOC_FORMAT = {
  md: 'markdown', html: 'html', epub: 'epub', rst: 'rst', tex: 'latex', org: 'org',
  textile: 'textile', mediawiki: 'mediawiki', ipynb: 'ipynb', man: 'man', typ: 'typst',
  dj: 'djot', muse: 'muse', opml: 'opml', fb2: 'fb2', jira: 'jira', creole: 'creole',
  t2t: 't2t', dokuwiki: 'dokuwiki', twiki: 'twiki', vimwiki: 'vimwiki', docbook: 'docbook',
  docx: 'docx', odt: 'odt', rtf: 'rtf',

  jats: 'jats', haddock: 'haddock', native: 'native',
};
const OFFICE_SEED = { xlsx: 'csv', xls: 'csv', ods: 'csv', doc: 'docx', ppt: 'pptx' };
// pandoc が「読めるが書けない」形式は素材を作れない。短いので手で書く
// （書かないと、その形式を入力にする組み合わせが丸ごと未試験のまま残る）
const HANDWRITTEN = {
  creole: '= 見出し =\n\n本文です。\n',
  t2t: '題\n作\n2026-08-17\n\n= 見出し =\n\n本文です。\n',
  twiki: '---+ 見出し\n\n本文です。\n',
  vimwiki: '= 見出し =\n\n本文です。\n',
  pod: '=head1 見出し\n\n本文です。\n\n=cut\n',
  tikiwiki: '! 見出し\n\n本文です。\n',
};
// gif は音を持てない。y4m は映像だけ。素材の作り方も、期待する結果も他と違う
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'flv', 'wmv', 'mpg', 'm4v', 'ts', '3gp', 'ogv', 'y4m'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'au', 'ac3', 'caf', 'mka', 'w64'];

const sampleFor = async (ext) => {
  const out = join(WORK, `in.${ext}`);
  if (seed[ext]) return seed[ext];
  if (HANDWRITTEN[ext]) return (await writeFile(out, HANDWRITTEN[ext]).then(() => true, () => false)) ? out : null;
  if (ext === 'pptx') return (await quiet(bin('pandoc'), [seed.md, '-o', out])) ? out : null;
  if (ext === 'pdf') return (await quiet(bin('pandoc'), [seed.md, '-o', out, '--pdf-engine=weasyprint'])) ? out : null;
  if (ext === 'parquet') {
    const sql = `COPY (SELECT * FROM read_csv_auto('${seed.csv}')) TO '${out}' (FORMAT PARQUET)`;
    return (await quiet(bin('duckdb'), ['-c', sql])) ? out : null;
  }
  if (ext === 'json') {
    return (await writeFile(out, '[{"a":1,"b":"x"},{"a":2,"b":"y"}]\n').then(() => true, () => false)) ? out : null;
  }
  if (MODEL_FORMAT[ext]) return (await quiet(bin('assimp'), ['export', seed.obj, out, `-f${MODEL_FORMAT[ext]}`])) ? out : null;
  if (OFFICE_SEED[ext]) {
    const from = seed[OFFICE_SEED[ext]] ?? (await sampleFor(OFFICE_SEED[ext]));
    if (!from) return null;
    const ok = await quiet(bin('soffice'), ['--headless', '--convert-to', ext, '--outdir', WORK, from]);
    const made = join(WORK, `${basename(from, extname(from))}.${ext}`);
    return ok && (await stat(made).then(() => true, () => false)) ? made : null;
  }
  if (DOC_FORMAT[ext]) {
    return (await quiet(bin('pandoc'), ['-f', 'markdown', '-t', DOC_FORMAT[ext], '-s', seed.md, '-o', out])) ? out : null;
  }
  // 動画と音は必ず ffmpeg で作る。ここで magick を先に試すと、静止画から**音の無い
  // 動画**ができてしまい、「動画 → 音」が道具のせいではなく素材のせいで落ちる
  // （2026-08-17 実測。これで 300 件以上が偽の失敗になっていた）。
  if (VIDEO_EXT.includes(ext)) return (await quiet(bin('ffmpeg'), ['-y', '-i', seed.mp4, out])) ? out : null;
  if (AUDIO_EXT.includes(ext)) return (await quiet(bin('ffmpeg'), ['-y', '-i', seed.wav, out])) ? out : null;
  if (await quiet(bin('magick'), [seed.png, out])) return out;
  return null;
};

// 出来たものを別の道具で読み直す。読めれば「中身がある」と言ってよい。
// 文書は読み直す共通の道具が無いので、大きさが 0 でないことだけを条件にする。
const magickWritable = new Set();
const loadMagickFormats = async () => {
  if (!bin('magick')) return; // 絵の道具が無い機械では、読み直しの確認を省く
  const { stdout } = await run(bin('magick'), ['-list', 'format'], { maxBuffer: 8 << 20 });
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9]+)\*?\s+\S+\s+rw/);
    if (m) magickWritable.add(m[1].toLowerCase());
  }
};
const readable = async (path, to) => {
  if (VIDEO_EXT.includes(to) || AUDIO_EXT.includes(to)) {
    return quiet(bin('ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path]);
  }
  // txt は ImageMagick にとって「画素を並べた文字列」の形式名でもある。ここでの txt は
  // ただの文章なので、絵として読ませると必ず落ちる（25件が偽の失敗になっていた・実測）
  // 絵の読み直し。呼び方が3通りある:
  //   ImageMagick 6 … `identify`（別の実行ファイル）
  //   ImageMagick 7 … `magick identify`（Windows は identify.exe を入れない・実機で確認）
  // 6 に `convert identify` と渡すと必ず落ちる（Linux で 2,691件の偽の失敗を出した）
  if (to === 'txt' || !magickWritable.has(to)) return true;
  if (bin('identify')) return quiet(bin('identify'), ['-ping', path]);
  const m = bin('magick');
  return m && /magick(\.exe)?$/i.test(m) ? quiet(m, ['identify', '-ping', path]) : true;
  return true;
};

// ── サーバーを立てて1つずつ呼ぶ ──────────────────────────────────
const server = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '';
const waiting = new Map();
server.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = ++id;
    waiting.set(myId, res);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });

const main = async () => {
  await makeSeeds();
  await loadMagickFormats();
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'matrix', version: '0' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const { stdout } = await run('node', [SERVER, '--list'], { maxBuffer: 32 << 20 });
  const pairs = stdout.trim().split('\n')
    .map((k) => k.split('>'))
    // url は外から取ってくるもの。手元だけの試験には入れない
    .filter(([f]) => f !== 'url')
    .filter(([f]) => only.length === 0 || only.includes(f));

  const samples = new Map();
  const inputs = [...new Set(pairs.map(([f]) => f))];
  for (const f of inputs) samples.set(f, await sampleFor(f));
  const missing = inputs.filter((f) => !samples.get(f));

  const passed = [];
  const failed = [];
  let done = 0;
  for (const [from, to] of pairs) {
    const src = samples.get(from);
    if (!src) continue;
    const dst = join(WORK, `out-${from}-to-${to}.${to}`);
    const started = Date.now();
    const r = await rpc('tools/call', { name: 'convert', arguments: { input: src, to, output: dst } });
    const ms = Date.now() - started;
    const size = await stat(dst).then((s) => s.size, () => 0);
    // 連番で出るもの（pdf → png など）は本体が無いので、隣に出た物を数える
    const spread = size === 0
      ? (await readdir(WORK)).filter((n) => n.startsWith(`out-${from}-to-${to}-`)).length
      : 0;
    // 「空でない」だけでは弱い。絵・動画・音は**読み直せるか**まで見る
    const ok = !r.result?.isError && (size > 0 || spread > 0) && (size === 0 || await readable(dst, to));
    (ok ? passed : failed).push(ok
      ? { pair: `${from}>${to}`, ms, bytes: size, files: spread || 1 }
      : { pair: `${from}>${to}`, why: (r.result?.content?.[0]?.text ?? 'no output').split('\n').slice(0, 2).join(' / ').slice(0, 200) });
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${pairs.length}\n`);
  }

  const report = {
    ranAt: new Date().toISOString(),
    tried: passed.length + failed.length,
    passed: passed.length,
    failed: failed.length,
    inputsWithoutSample: missing,
    slowest: [...passed].sort((a, b) => b.ms - a.ms).slice(0, 10),
    failures: failed,
  };
  await writeFile(join(HERE, 'matrix-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`通った: ${passed.length} / 試した: ${report.tried}（落ちた: ${failed.length}）`);
  if (missing.length) console.log(`素材を作れず試験できなかった入力: ${missing.join(', ')}`);
  console.log(`詳しくは test/matrix-result.json`);
  server.kill();
};

await main();
