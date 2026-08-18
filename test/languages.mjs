// 言語を変えても大丈夫かを見る試験。
//
// 日本語で「太字が落ちる」が見つかったので、他の言葉でも同じことが起きないか調べる。
// 見るのは2つ:
//   ① 文字そのものが残るか（docx・odt・html・pdf を通して取り出して照合）
//   ② 太字・斜体が残るか（rst・org・textile・docx・html・odt を往復させて数える）
//
//   node test/languages.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ONCE = join(HERE, 'convert-once.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'kaeru-lang-'));

// `spaced` は「その言葉がふつう語の間に空白を置くか」。置かない言葉（日本語・中国語・
// 韓国語・タイ語）では強調の印が文字にぴったり付く。そこが効くと踏んでいる。
const LANGS = [
  { code: 'ja', name: '日本語', word: '太字', body: 'これは', tail: 'です。', spaced: false },
  { code: 'zh', name: '中文', word: '粗体', body: '这是', tail: '。', spaced: false },
  { code: 'ko', name: '한국어', word: '굵게', body: '이것은', tail: '입니다.', spaced: false },
  { code: 'th', name: 'タイ語', word: 'ตัวหนา', body: 'นี่คือ', tail: 'ครับ', spaced: false },
  { code: 'ar', name: 'アラビア語', word: 'غامق', body: 'هذا', tail: 'نص', spaced: true },
  { code: 'he', name: 'ヘブライ語', word: 'מודגש', body: 'זה', tail: 'טקסט', spaced: true },
  { code: 'ru', name: 'ロシア語', word: 'жирный', body: 'это', tail: 'текст', spaced: true },
  { code: 'el', name: 'ギリシャ語', word: 'έντονα', body: 'αυτό', tail: 'κείμενο', spaced: true },
  { code: 'hi', name: 'ヒンディー語', word: 'मोटा', body: 'यह', tail: 'पाठ', spaced: true },
  { code: 'vi', name: 'ベトナム語', word: 'đậm', body: 'đây là', tail: 'chữ', spaced: true },
  { code: 'emoji', name: '絵文字', word: '\u{1F600}\u{1F38C}', body: 'これは', tail: 'です。', spaced: false },
  { code: 'nfd', name: '合成文字', word: 'café', body: 'un', tail: 'noir', spaced: true },
];

// 空白を置く言葉は前後に空白を入れ、置かない言葉はぴったり付ける
const sentence = (l) => (l.spaced
  ? `${l.body} **${l.word}** ${l.tail} *${l.word}* ${l.tail}.`
  : `${l.body}**${l.word}**${l.tail}*${l.word}*${l.tail}`);

const quiet = async (cmd, args) => {
  try {
    const { stdout } = await run(cmd, args, { timeout: 120_000, maxBuffer: 32 << 20 });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: '', err: (e.stderr || e.message || '').slice(0, 120) };
  }
};

const EMPH_VIA = ['rst', 'org', 'textile', 'docx', 'html', 'odt'];
const TEXT_VIA = ['docx', 'odt', 'html', 'pdf'];

const rows = [];
for (const lang of LANGS) {
  const md = join(WORK, `${lang.code}.md`);
  writeFileSync(md, `# ${lang.name}\n\n${sentence(lang)}\n`);

  const emph = {};
  for (const via of EMPH_VIA) {
    const mid = join(WORK, `${lang.code}.${via}`);
    if (!(await quiet('node', [ONCE, md, via, mid])).ok) { emph[via] = null; continue; }
    const back = await quiet('pandoc', ['-f', via, '-t', 'native', mid]);
    emph[via] = back.ok ? (back.stdout.match(/\bStrong\b/g) ?? []).length : null;
  }

  const text = {};
  for (const via of TEXT_VIA) {
    const mid = join(WORK, `t-${lang.code}.${via}`);
    if (!(await quiet('node', [ONCE, md, via, mid])).ok) { text[via] = null; continue; }
    // pdf は文字の層を取り出す。それ以外は素の文章に戻して読む
    const got = via === 'pdf'
      ? await quiet('pdftotext', [mid, '-'])
      : await quiet('pandoc', ['-f', via, '-t', 'plain', mid]);
    // 合成文字は見た目が同じでも並びが違うので、揃えてから比べる
    const norm = (s) => s.normalize('NFC');
    text[via] = got.ok ? norm(got.stdout).includes(norm(lang.word)) : null;
  }

  rows.push({ code: lang.code, name: lang.name, spaced: lang.spaced, emph, text });
}

await writeFile(join(HERE, 'languages-result.json'),
  `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`);

const mark = (v) => (v === null ? '—' : v > 0 ? '○' : '×');
console.log(`言語(語間の空白)  ${EMPH_VIA.map((v) => v.padEnd(8)).join('')}| 文字が残るか`);
for (const r of rows) {
  const e = EMPH_VIA.map((v) => mark(r.emph[v]).padEnd(8)).join('');
  const lost = TEXT_VIA.filter((v) => r.text[v] === false);
  console.log(`${`${r.name}(${r.spaced ? '有' : '無'})`.padEnd(16)}${e}| ${lost.length ? `落ちた: ${lost.join(',')}` : '全部残った'}`);
}
console.log('（○＝太字が残った ×＝落ちた —＝その形式では測れない）');
console.log(`詳しくは test/languages-result.json / 作った物は ${WORK}`);
