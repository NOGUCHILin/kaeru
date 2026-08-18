// 文書の「中身が保たれているか」を、部品の数で見る試験。
//
// quality.mjs は言葉が残るかしか見ていない。文書で本当に困るのは
// **表が消える・箇条書きが段落になる・見出しの段が潰れる**といった崩れなので、
// ここでは pandoc の native（文書の骨組みをそのまま書き出したもの）を数えて比べる。
//
//   node test/fidelity.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const WORK = mkdtempSync(join(tmpdir(), 'kaeru-fidelity-'));

// わざと部品を全部入れた1枚。ここが崩れる形式は、実際の資料でも崩れる。
const SEED = `# 大見出し

本文です。**太字**と*斜体*、それに \`コード\` を混ぜます。ASCII and 日本語。

## 中見出し

- 箇条書き 一
- 箇条書き 二
  - 入れ子

1. 番号 一
2. 番号 二

| 品目 | 数量 | 備考 |
|---|---|---|
| 髙橋 | 3 | 異体字 |
| 波～ | 10 | 波ダッシュ |

> 引用文です。

\`\`\`
コードの塊
\`\`\`

[リンク](https://example.com)
`;

const seedMd = join(WORK, 'seed.md');
writeFileSync(seedMd, SEED);

const quiet = async (cmd, args) => {
  try {
    const { stdout } = await run(cmd, args, { timeout: 120_000, maxBuffer: 32 << 20 });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: '', err: (e.stderr || e.message || '').slice(0, 160) };
  }
};

// 骨組みの中で「消えたら困るもの」だけ数える
const PARTS = ['Header', 'BulletList', 'OrderedList', 'Table', 'BlockQuote', 'CodeBlock', 'Strong', 'Emph', 'Link'];
// 拡張子と pandoc の呼び名の対応（読み戻す時に要る）
const DOC_FORMAT = {
  md: 'markdown', tex: 'latex', typ: 'typst', dj: 'djot', adoc: 'asciidoc', txt: 'plain',
  ctx: 'context', s5: 's5',
};
const countParts = (native) =>
  Object.fromEntries(PARTS.map((p) => [p, (native.match(new RegExp(`\\b${p}\\b`, 'g')) ?? []).length]));

const baseNative = (await quiet('pandoc', ['-f', 'markdown', '-t', 'native', seedMd])).stdout;
const base = countParts(baseNative);

const { stdout: list } = await run('node', [SERVER, '--list'], { maxBuffer: 32 << 20 });
const targets = [...new Set(list.trim().split('\n').map((k) => k.split('>'))
  .filter(([f]) => f === 'md').map(([, t]) => t))];

const rows = [];
for (const t of targets) {
  const mid = join(WORK, `d.${t}`);
  const fwd = await quiet('node', [join(HERE, 'convert-once.mjs'), seedMd, t, mid]);
  if (!fwd.ok) { rows.push({ format: t, note: '往路で落ちた' }); continue; }
  // 戻せない形式（pandoc が読めないもの）は、この測り方では見られない
  // 読み戻しは pandoc を直接呼ぶ。サーバー経由だと `-s` が付き、**先頭の見出しが
  // 「題」として抜き取られて**「見出しが1つ消えた」ように見える（測り方の副作用）。
  const rev = await quiet('pandoc', ['-f', DOC_FORMAT[t] ?? t, '-t', 'native', mid]);
  if (!rev.ok) { rows.push({ format: t, note: '読み戻せない形式' }); continue; }
  const got = countParts(rev.stdout);
  const lost = PARTS.filter((p) => base[p] > 0 && got[p] < base[p]);
  rows.push({ format: t, lost, counts: got });
}

const measured = rows.filter((r) => !r.note);
const perfect = measured.filter((r) => r.lost.length === 0);
await writeFile(join(HERE, 'fidelity-result.json'),
  `${JSON.stringify({ ranAt: new Date().toISOString(), base, rows }, null, 2)}\n`);

console.log(`骨組みがそのまま残った: ${perfect.length} / ${measured.length} 形式`);
for (const r of measured.filter((x) => x.lost.length)) {
  console.log(`  ${r.format.padEnd(9)} 欠けた: ${r.lost.join(', ')}`);
}
const skipped = rows.filter((r) => r.note);
console.log(`  この測り方では見られない: ${skipped.map((r) => r.format).join(', ')}`);
console.log('詳しくは test/fidelity-result.json');
console.log(`作った文書は ${WORK} に残してある（目で見る用）`);
