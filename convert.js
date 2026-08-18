// kaeru の変換そのもの。入口（MCP・画面）はここを呼ぶだけで、対応表を知らない。
// 変換そのものは書かない。その機械に入っている道具を呼ぶだけ。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, link, open, readFile, rename, readdir, copyFile, unlink, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { bin, has, install, pandocReads, pandocWrites, magickFormats, magickBlocked, keepSupported } from './tools.js';

const run = promisify(execFile);

const ALIAS = { markdown: 'md', mdown: 'md', mkd: 'md', jpeg: 'jpg', tif: 'tiff', htm: 'html' };
const normalize = (ext) => {
  const e = ext.replace(/^\./, '').toLowerCase();
  return ALIAS[e] ?? e;
};
const isUrl = (s) => /^https?:\/\//i.test(s);

// 取り込みの URL は、**外の世界だけ**に限る。`http://127.0.0.1:...` や社内の
// アドレスを渡されると、本来見えないものを取りに行かされる（SSRF）。
//
// **名前で判定してはいけない。** `0x7f.0.0.1` `2130706433` `[::ffff:127.0.0.1]` や、
// 127.0.0.1 に解決するだけの普通のドメイン名がすり抜ける（2026-08-18 に自分で実証）。
// **必ず解決して、出てきた住所そのものを見る。**
const privateAddress = (ip) => {
  // IPv6 に埋め込んだ IPv4 は2通りの書き方がある。**16進の方を忘れると素通りする**
  // （`::ffff:7f00:1` は 127.0.0.1 のこと。2026-08-18 に実際にすり抜けた）
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const v4 = hex
    ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255,
       parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.')
    : ip.replace(/^::ffff:/i, '');
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = m.slice(1).map(Number);
    return a === 0 || a === 127 || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)                     // 通信会社の内側（CGNAT）
      || a >= 224;                                              // マルチキャスト以上
  }
  const v6 = ip.toLowerCase();
  // link-local は fe80::/10 = fe80〜febf。`fe80:` だけだと fe90 等が抜ける
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
};

const checkUrl = async (raw) => {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL として読めません: ${raw}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`http か https だけです: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let found;
  try {
    found = await lookup(host, { all: true });
  } catch {
    throw new Error(`宛先を見つけられません: ${host}`);
  }
  const inside = found.filter((a) => privateAddress(a.address));
  if (inside.length) {
    throw new Error(`この宛先へは取りに行きません（手元か社内の住所です）: ${host} → ${inside[0].address}`);
  }
};

// ── 道具ごとの呼び方 ───────────────────────────────────────────────
// 受け取るのは { src, srcs, dst, pages }、返すのは
// { cmd, args, produces?, cleanup?, timeout?, fromStdout? }。
// produces は「道具が実際に書き出す場所」で、出したい場所と違う時だけ後で移す
// （LibreOffice は出力名を選べないため）。cleanup はそのために作った一時フォルダ。
// fromStdout は「出力先を道具が決める」時（yt-dlp は題名でファイル名を付ける）。

const MEDIA_TIMEOUT = 600_000; // 動画・取り込みは長い

// 手口ごとに「要る道具」を書いておく。**その機械に無い道具の手口は、対応表から外す**
// （呼ばれてから失敗するのではなく、最初から名乗らない）。
const needs = (tools, fn) => Object.assign(fn, { tools });

// pandoc 3.6.4 の typst テンプレートは typst 0.14 と噛み合わない（font fallback で
// 落ちる）ため、PDF エンジンは weasyprint を使う（2026-08-16 実測）。
// **`--sandbox` は入れない。** 一度入れたが、文書が参照している画像まで読めなくなり、
// `![絵](pic.png)` が黙って消えた（2026-08-18 実測。docx に画像 0 個）。
// しかも肝心の穴（PDF を作る weasyprint が file:// を辿る）はこれでは塞げない。
// **代償が大きく効き目が小さいので採らない。** 危険は SECURITY.md に明記した。
const pandocToPdf = needs(['pandoc', 'weasyprint'],
  ({ src, dst }) => ({ cmd: bin('pandoc'),
    // **入力の種類も明示する。** 拡張子任せだと pandoc が推測に失敗し、
    // `.haddock` などで「形式が分からない」と警告を出したうえ、たまに落ちる（実測）
    args: ['-f', DOC_FORMAT[normalize(extname(src))] ?? 'markdown',
      src, '-o', dst, `--pdf-engine=${bin('weasyprint')}`] }));

// 文書どうしの変換も pandoc 1本。拡張子と pandoc の呼び名が違うものがあるので
// （tex → latex / txt → plain / typ → typst）、拡張子任せにせず必ず名前で渡す。
const DOC_FORMAT = {
  md: 'markdown', html: 'html', epub: 'epub', rst: 'rst', tex: 'latex', org: 'org',
  textile: 'textile', mediawiki: 'mediawiki', ipynb: 'ipynb', man: 'man', typ: 'typst',
  dj: 'djot', muse: 'muse', opml: 'opml', fb2: 'fb2', jira: 'jira', creole: 'creole',
  t2t: 't2t', dokuwiki: 'dokuwiki', twiki: 'twiki', vimwiki: 'vimwiki', docbook: 'docbook',
  docx: 'docx', odt: 'odt', rtf: 'rtf', txt: 'plain', adoc: 'asciidoc', tei: 'tei',
  xwiki: 'xwiki', zimwiki: 'zimwiki', texinfo: 'texinfo', ms: 'ms', icml: 'icml', pptx: 'pptx',
  tikiwiki: 'tikiwiki', pod: 'pod', jats: 'jats', haddock: 'haddock', native: 'native',
  ctx: 'context', markua: 'markua', gfm: 'gfm', revealjs: 'revealjs', slidy: 'slidy',
  dzslides: 'dzslides', s5: 's5',
};
// rst・org・textile を**入力**にすると、日本語・中国語・韓国語・タイ語のように
// 語の間に空白を置かない言葉では、太字と斜体が落ちる（2026-08-17 実測）。
// 強調の始まりは「空白か特定の記号の直後」でないと認められない決まりのため。
// **書き出す方は正しい**（docutils に読ませて太字になることを確認済み）ので、
// 直せるのは「黙って落とさないこと」だけ。当てはまる時だけ言う。
const NO_SPACE_SCRIPT = /[぀-ヿ㐀-鿿가-힯฀-๿]/;
const LOSES_EMPHASIS = ['rst', 'org', 'textile'];
const dropsEmphasis = (src) => {
  if (!LOSES_EMPHASIS.includes(normalize(extname(src)))) return false;
  const buf = Buffer.alloc(1 << 16);
  const fd = openSync(src, 'r');
  let len;
  try {
    len = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  return NO_SPACE_SCRIPT.test(buf.subarray(0, len).toString('utf8'));
};

const pandocDoc = (target) => needs(target === 'pdf' ? ['pandoc', 'weasyprint'] : ['pandoc'], (arg) => {
  if (target === 'pdf') return pandocToPdf(arg);
  const { src, dst } = arg;
  return {
    cmd: bin('pandoc'),
    // -s を付けないと html や tex が断片で出る（頭と尻尾の無い文書になる）
    args: ['-f', DOC_FORMAT[normalize(extname(src))], '-t', DOC_FORMAT[target], '-s', src, '-o', dst],
    note: dropsEmphasis(src)
      ? `${normalize(extname(src))} から読む時、語の間に空白を置かない言葉（日本語・中国語・韓国語・タイ語）の`
        + '太字と斜体は落ちます。文字そのものは残ります。'
      : undefined,
  };
});

// CSV は文字コードを推測させると黙って化ける（2026-08-16 実測）。
// UTF-8 として読めるならそのまま、読めなければ Shift_JIS とみなす（日本の Excel の既定）。
// 数字は soffice の指定（44=カンマ / 34=" / 76=UTF-8 / 64=Shift_JIS）。
// 64 は髙・①・～（Windows の日本語だけにある文字）まで通ることを実測で確かめた。
const UTF8 = 76;
const SHIFT_JIS = 64;
const CSV_OUT = `csv:Text - txt - csv (StarCalc):44,34,${UTF8}`; // 書き出しは必ず UTF-8

const csvCharset = (src) => {
  const size = 1 << 20; // 判定は先頭 1MB で足りる（全部読むと巨大な CSV で詰まる）
  const buf = Buffer.alloc(size);
  const fd = openSync(src, 'r');
  let len;
  try {
    len = readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  // 打ち切った時は末尾の文字が途中で切れうるので 3 バイト捨てる
  const head = buf.subarray(0, len === size ? len - 3 : len);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return UTF8;
  } catch {
    return SHIFT_JIS;
  }
};

// LibreOffice は出力の名前を選べず「元の名前＋新しい拡張子」で書く。出したい場所へ
// 直接書かせると、そこにあった同じ名前の別のファイルを黙って壊す（2026-08-16 に実際に
// 壊した）。そこで毎回、専用の一時フォルダへ出してから移す。
// -env:UserInstallation は LibreOffice の作業場所。分けないと同時に2つ動かせない。
// 名前を pid から作ると**他人に先回りして symlink を置かれる**。
// 推測できない名前を作らせる。
// **変換ごとに別の作業場所を作る。** プロセスに1つだと、同じプロセスから
// 2本以上動かした時に取り合いになって落ちる（2026-08-18 実測。3本中2本が失敗）。
// `file://` を手で組み立てると Windows の `C:\` で壊れるので、OS に作らせる。
const loProfile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kaeru-lo-'));
  return { dir, arg: `-env:UserInstallation=${pathToFileURL(dir).href}` };
};

const officeTo = (target) => needs(['soffice'], ({ src, dst }) => {
  const tmp = mkdtempSync(join(tmpdir(), 'kaeru-'));
  const profile = loProfile();
  return {
    cmd: bin('soffice'),
    args: [
      '--headless', profile.arg,
      ...(normalize(extname(src)) === 'csv' ? [`--infilter=CSV:44,34,${csvCharset(src)}`] : []),
      '--convert-to', target === 'csv' ? CSV_OUT : target,
      '--outdir', tmp, src,
    ],
    produces: join(tmp, `${basename(src, extname(src))}.${target}`),
    cleanup: [tmp, profile.dir],
    // csv は表を1枚しか持てない。黙って落ちると気づけないので必ず言う（2026-08-16 実測）
    note: target === 'csv' ? 'csv になるのは1枚目のシートだけです。2枚目以降は入りません。' : undefined,
  };
});

const officeToPdf = officeTo('pdf');

const imageMagick = needs(['magick'], ({ src, dst }) => ({ cmd: bin('magick'), args: [src, dst] }));

// 動画・音声はすべて ffmpeg。拡張子から中身の形式を ffmpeg 自身が決める。
const ffmpeg = (extra = []) => needs(['ffmpeg'], ({ src, dst }) => ({
  cmd: bin('ffmpeg'),
  args: ['-y', '-i', src, ...extra, dst],
  timeout: MEDIA_TIMEOUT,
}));
const ffmpegPlain = ffmpeg();
// 動画どうしは色の並べ方を揃える。gif のように色数の少ない元は、指定しないと
// 入れ物が受け取れずに落ちる（gif → webm / ogv / y4m が実際に落ちた・2026-08-17）
const toVideo = ffmpeg(['-pix_fmt', 'yuv420p']);
const toGif = ffmpeg(['-vf', 'fps=12,scale=640:-1:flags=lanczos']); // そのままだと巨大になる
const stripVideo = ffmpeg(['-vn']); // 動画から音だけ取り出す

// 同じ形式のまま小さくする（形は変えず、目方だけ落とす）。
// `-strip` は撮影日時や位置情報などのおまけを捨てる。中身の絵は変わらない。
const compressImage = needs(['magick'],
  ({ src, dst }) => ({ cmd: bin('magick'), args: [src, '-strip', '-quality', '82', dst] }));
const compressAudio = ffmpeg(['-b:a', '96k']);

// PDF → 画像。複数ページなら道具が連番で書き出す（後で実際に出たものを拾う）。
const pdfToImage = needs(['magick'], ({ src, dst }) => ({ cmd: bin('magick'), args: ['-density', '150', src, dst] }));

// 画像 → PDF。img2pdf は JPEG を再圧縮しないので画質が落ちない。
const imagesToPdf = needs(['img2pdf'], ({ srcs, dst }) => ({ cmd: bin('img2pdf'), args: [...srcs, '-o', dst] }));

// PDF → PDF は3つの意味を持つ。入力が複数なら結合、pages があれば切り出し、
// どちらでもなければ圧縮。
// `pages` は qpdf の引数にそのまま渡る。`--file=/秘密.pdf` のような値を入れられると
// **別の PDF を混ぜられる**（2026-08-18 の指摘で判明）。数字・カンマ・ハイフンと、
// qpdf が使う r（末尾から）z（最後）だけを許す。
// 先頭も縛る。`-` で始まると qpdf がオプションとして読む余地が残るため
const SAFE_PAGES = /^[0-9rz][0-9,\-rz:]{0,99}$/;

const pdfToPdf = needs(['qpdf', 'gs'], ({ srcs, dst, pages }) => {
  if (pages && !SAFE_PAGES.test(pages)) throw new Error(`pages の書き方が不正です: ${pages}`);
  if (srcs.length > 1) return { cmd: bin('qpdf'), args: ['--empty', '--pages', ...srcs, '--', dst] };
  if (pages) return { cmd: bin('qpdf'), args: ['--empty', '--pages', srcs[0], pages, '--', dst] };
  return {
    cmd: bin('gs'),
    args: [
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7', '-dPDFSETTINGS=/ebook',
      '-dNOPAUSE', '-dBATCH', '-dQUIET', `-sOutputFile=${dst}`, srcs[0],
    ],
  };
});

// 動画サイトからの取り込み。出力先は yt-dlp が題名から決めるので stdout で受け取る。
const ytdlp = (audioOnly) => needs(['yt-dlp'], ({ src, dst, overwrite }) => ({
  cmd: bin('yt-dlp'),
  args: [
    // 出力名を決めるのは yt-dlp 側なので、**yt-dlp 自身にも意向を伝える**。
    // 固定で禁止すると `overwrite: true` が効かず、古いファイルを成果として返す
    overwrite ? '--force-overwrites' : '--no-overwrites',
    ...(audioOnly
      ? ['-x', '--audio-format', normalize(extname(dst))]
      : ['-f', 'bv*+ba/b', '--merge-output-format', normalize(extname(dst))]),
    '-o', dst, '--print', 'after_move:filepath', '--no-simulate', src,
  ],
  timeout: MEDIA_TIMEOUT,
  fromStdout: true,
}));

// 3Dモデルは assimp 1本で相互に変換できる。ただし書き出す形式の名前は拡張子と違う
// ものがある（glb → glb2 / dae → collada）。拡張子任せにすると黙って別の版で書くので
// 必ず明示する。
const MODEL_FORMAT = {
  stl: 'stl', obj: 'obj', ply: 'ply', dae: 'collada', '3mf': '3mf', fbx: 'fbx',
  glb: 'glb2', gltf: 'gltf2',
};
// 隣にもう1つファイルが出るもの。2つで1組なので、片方だけ運ぶと形が崩れる（実測）
const MODEL_COMPANION = { obj: '.mtl（材質）', gltf: '.bin（頂点データ）' };

const assimpTo = (target) => needs(['assimp'], ({ src, dst }) => ({
  cmd: bin('assimp'),
  args: ['export', src, dst, `-f${MODEL_FORMAT[target]}`],
  note: MODEL_COMPANION[target]
    ? `${target} は本体の隣に ${MODEL_COMPANION[target]} も書きます。2つで1組なので一緒に運んでください。`
    : undefined,
}));

// Parquet は duckdb 1本で読み書きする。SQL に渡すので ' は二重にして閉じ込める。
const sqlText = (s) => s.replaceAll("'", "''");
// CP932 の CSV は duckdb では読めずに止まる。ICU の名前で渡すと通る
// （`Shift_JIS` や `windows-31j` では通らない。2026-08-16 実測）。
const DUCK_SJIS = 'ibm-943_P15A-2003';
const duckRead = (src) => {
  const ext = normalize(extname(src));
  if (ext === 'csv') {
    const enc = csvCharset(src) === UTF8 ? '' : `, encoding='${DUCK_SJIS}'`;
    return `read_csv_auto('${sqlText(src)}'${enc})`;
  }
  if (ext === 'json') return `read_json_auto('${sqlText(src)}')`;
  return `read_parquet('${sqlText(src)}')`;
};
const DUCK_WRITE = { parquet: 'FORMAT PARQUET', csv: 'FORMAT CSV, HEADER', json: 'FORMAT JSON, ARRAY true' };
const duckCopy = needs(['duckdb'], ({ src, dst }) => ({
  cmd: bin('duckdb'),
  args: ['-c', `COPY (SELECT * FROM ${duckRead(src)}) TO '${sqlText(dst)}' (${DUCK_WRITE[normalize(extname(dst))]})`],
  timeout: MEDIA_TIMEOUT, // Parquet を使うのは大きな表。既定の2分では足りないことがある
}));

const OFFICE = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'csv'];
const SHEET = ['csv', 'xlsx', 'xls', 'ods']; // 表計算どうしは相互に変換できる
// 一覧はどれも「その道具が読み書き**両方**できると自分で言っている形式」から選び、
// **実際に1つずつ通して残ったものだけ**を載せている（`node test/matrix.mjs` で数え直せる）。
// 形式を1つ足すと、その族の組み合わせがまとめて増える。
const IMAGE = [
  'png', 'jpg', 'webp', 'avif', 'heic', 'tiff', 'gif', 'bmp', 'apng', 'dds', 'dpx',
  'farbfeld', 'fits', 'hdr', 'ico', 'jng', 'miff', 'pam', 'pbm', 'pcx', 'pgm', 'pnm',
  'ppm', 'psd', 'ptif', 'qoi', 'ras', 'sgi', 'tga', 'wbmp', 'xbm', 'xpm', 'palm', 'viff',
  'jps', 'mng', 'pict', 'pdb', 'vips', 'ipl', 'hrz', 'mtv', 'otb', 'sun', 'cur', 'psb',
  'wpg', 'vicar', 'pgx', 'phm', 'xv', 'mpc', 'fl32', 'cin',
];
// mpg と 3gp は外した。既定の符号化では入れ物が受け取らず、形式ごとの指定が要る
// （実測で全滅した。要るようになったら足す）
const VIDEO = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'flv', 'wmv', 'm4v', 'ts', 'ogv', 'y4m'];
const AUDIO = ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'au', 'ac3', 'caf', 'mka', 'w64'];
// 文書。読める側と書ける側が違う（pandoc が読めない形式でも書けることがある）
const DOC_IN = [
  'md', 'html', 'epub', 'rst', 'tex', 'org', 'textile', 'mediawiki', 'ipynb', 'man',
  'typ', 'dj', 'muse', 'opml', 'fb2', 'jira', 'creole', 't2t', 'dokuwiki', 'twiki',
  'vimwiki', 'docbook', 'docx', 'odt', 'rtf', 'tikiwiki', 'pod', 'jats', 'haddock', 'native',
];
const DOC_OUT = [
  'pdf', 'docx', 'odt', 'html', 'epub', 'md', 'rst', 'tex', 'org', 'textile', 'mediawiki',
  'man', 'ipynb', 'typ', 'dj', 'muse', 'opml', 'jira', 'adoc', 'rtf', 'txt', 'fb2', 'tei',
  'xwiki', 'zimwiki', 'docbook', 'texinfo', 'ms', 'icml', 'pptx', 'ctx', 'jats', 'markua',
  'gfm', 'native', 'haddock', 'revealjs', 'slidy', 'dzslides', 's5',
];
// ここで一覧を絞る。**道具が入っていても、その版が対応しているとは限らない。**
// Linux の pandoc 2 系は typst も djot も知らなかった（2026-08-18 実機で確認）。
// 道具に直接聞いて、できないものは最初から名乗らない。聞けなかった時は絞らない。
const DOC_IN_OK = keepSupported(DOC_IN, pandocReads(), (e) => DOC_FORMAT[e]);
const DOC_OUT_OK = keepSupported(DOC_OUT.filter((t) => t !== 'pdf'), pandocWrites(), (e) => DOC_FORMAT[e]);
const DOC_OUT_ALL = [...DOC_OUT_OK, ...(DOC_OUT.includes('pdf') ? ['pdf'] : [])];
const BLOCKED = magickBlocked() ?? new Set();
const IMAGE_OK = keepSupported(IMAGE, magickFormats()).filter((f) => !BLOCKED.has(f));
// ImageMagick に PDF を触らせない設定の機械がある（Debian の既定）。その時は
// 絵 ⇄ PDF を magick に頼れないので名乗らない（img2pdf の分だけは残る）
const MAGICK_PDF = !BLOCKED.has('pdf');

const MODEL = Object.keys(MODEL_FORMAT);
const TABLE = ['csv', 'json']; // Parquet と行き来できるもの
// img2pdf は元の絵をそのまま埋めるので画質が落ちない。ただし1画素16ビットの tiff は
// 断られる（`PIL is unable to preserve more than 8 bits per sample`・実測）ので tiff は magick に回す。
const LOSSLESS_TO_PDF = ['png', 'jpg'];

const cross = (froms, tos, recipe) =>
  Object.fromEntries(froms.flatMap((f) => tos.filter((t) => t !== f).map((t) => [`${f}>${t}`, recipe])));
const fanOut = (froms, to, recipe) => Object.fromEntries(froms.map((f) => [`${f}>${to}`, recipe]));
const fanIn = (from, tos, recipe) => Object.fromEntries(tos.map((t) => [`${from}>${t}`, recipe]));

// 対応表。1行足せば1種類増える。入口（convert）はここを知らない。
const RECIPES = {
  // 文書どうし（pandoc）
  ...Object.fromEntries(
    DOC_IN_OK.flatMap((f) => DOC_OUT_ALL.filter((t) => t !== f).map((t) => [`${f}>${t}`, pandocDoc(t)])),
  ),
  // Office → pdf は soffice に任せる（見た目が元のまま出る）。pandoc の分を上書きする
  ...fanOut(OFFICE, 'pdf', officeToPdf),
  // 表計算どうし（csv ⇄ xlsx / xls / ods）。行き先ごとに soffice の出力形式が変わる
  ...Object.fromEntries(
    SHEET.flatMap((f) => SHEET.filter((t) => t !== f).map((t) => [`${f}>${t}`, officeTo(t)])),
  ),
  // SVG は入力としてだけ扱う（絵を SVG に戻すことはできない）
  ...fanIn('svg', [...IMAGE_OK, ...(MAGICK_PDF ? ['pdf'] : [])], imageMagick),
  // 動画・音声
  ...cross(VIDEO, VIDEO.filter((t) => t !== 'gif'), toVideo),
  ...fanOut(VIDEO.filter((f) => f !== 'gif'), 'gif', toGif),
  // 音を取り出せるのは音を持てる入れ物だけ。gif と y4m は映像しか入らない
  ...cross(VIDEO.filter((f) => !['gif', 'y4m'].includes(f)), AUDIO, stripVideo),
  ...cross(AUDIO, AUDIO, ffmpegPlain),
  // PDF
  ...(MAGICK_PDF ? fanIn('pdf', ['png', 'jpg', 'tiff'], pdfToImage) : {}),
  ...fanOut(LOSSLESS_TO_PDF, 'pdf', imagesToPdf),
  ...(MAGICK_PDF ? fanOut(IMAGE_OK.filter((f) => !LOSSLESS_TO_PDF.includes(f)), 'pdf', imageMagick) : {}),
  'pdf>pdf': pdfToPdf,
  // 同じ形式のまま小さくする。入力と同じ場所には書けないので output を別にする
  ...Object.fromEntries(IMAGE_OK.map((f) => [`${f}>${f}`, compressImage])),
  ...Object.fromEntries(AUDIO.map((f) => [`${f}>${f}`, compressAudio])),
  // 動画サイトからの取り込み
  ...fanIn('url', VIDEO, ytdlp(false)),
  ...fanIn('url', AUDIO, ytdlp(true)),
  // 3Dモデル（行き先ごとに assimp の形式名が変わる）
  ...Object.fromEntries(
    MODEL.flatMap((f) => MODEL.filter((t) => t !== f).map((t) => [`${f}>${t}`, assimpTo(t)])),
  ),
  // Parquet
  ...fanOut(TABLE, 'parquet', duckCopy),
  ...fanIn('parquet', TABLE, duckCopy),
  // 画像（最後に置く。gif>png などは動画ではなく画像として扱う）
  ...cross(IMAGE_OK, IMAGE_OK, imageMagick),
};

// 実測で通らなかった組み合わせは、表から外す。載せた数と動く数を一致させるため
// （`node test/matrix.mjs` が根拠。落ちたものをここへ書き足す）。
//   gif>mng  … 色数の少ない絵を mng にすると magick が「使える色の一覧が要る」と断る
//   pbm>ipl  … 変換自体は通るが、出来た ipl を読み直せない（中身が壊れている）
for (const broken of ['gif>mng', 'pbm>ipl']) delete RECIPES[broken];

// **その機械に無い道具の手口は、対応表から外す。** kaeru は道具を同梱しないので、
// 何が使えるかは機械ごとに違う。できないものを名乗らないのが、いちばん親切な形。
const MISSING = new Map();     // 道具 → その道具が無いせいで名乗れない組み合わせの数
const UNAVAILABLE = new Map(); // 組み合わせ → 足りない道具（頼まれた時に理由を言うため）
for (const [key, recipe] of Object.entries(RECIPES)) {
  const lack = (recipe.tools ?? []).filter((t) => !has(t));
  if (!lack.length) continue;
  delete RECIPES[key];
  UNAVAILABLE.set(key, lack);
  for (const t of lack) MISSING.set(t, (MISSING.get(t) ?? 0) + 1);
}

// 何が足りなくて、何を失っているか（`--doctor` と画面が使う）
export const missing = () =>
  [...MISSING.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, lost]) => ({ tool, lost, install: install(tool) }));

const targetsFor = (from) =>
  Object.keys(RECIPES)
    .filter((k) => k.startsWith(`${from}>`))
    .map((k) => k.split('>')[1]);

// 別のディスクへは rename できないので、その時だけ写して消す。
// `exclusive` の時は「無ければ作る」を **OS に一度でやらせる**。
// 確かめてから書くと、その隙に横から作られる（2026-08-18 実測。同時3本のうち
// 2本が「成功」して片方が消えた）。link と copyFile の EXCL は既にあれば失敗する。
const move = async (from, to, exclusive = false) => {
  if (exclusive) {
    try {
      await link(from, to);       // 既にあれば EEXIST で失敗する（一度で決まる）
      await unlink(from);
      return;
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`そこには既に何かがあります: ${to}`);
      // **link が使えないディスクがある**（FAT・exFAT・共有フォルダ・古い Linux）。
      // 実測で EXDEV / ENOTSUP が返った。ENOSYS を返す環境もある（2026-08-18 の指摘）。
      if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EMLINK'].includes(e.code)) throw e;
    }
    // link が無い所では、`wx` で**先に場所を押さえてから**中身を書く。
    // 横から入られないが、書いている途中の中身は見えうる（その入れ物には他に手が無い）。
    let handle;
    try {
      handle = await open(to, 'wx', 0o644);
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`そこには既に何かがあります: ${to}`);
      throw e;
    }
    try {
      await handle.writeFile(await readFile(from));
    } catch (e) {
      await handle.close().catch(() => {});
      await unlink(to).catch(() => {});   // 自分が作った物だけを片付ける
      throw e;
    }
    await handle.close();
    await unlink(from);
    return;
  }

  try {
    await rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // 別のディスクへは rename できない。仮の名前へ写してから一度で確定する。
    // **写す所も try の中に入れる**（容量切れ等で仮名が残っていた・2026-08-18 の指摘）
    const half = `${to}.part-${randomUUID()}`;
    try {
      await copyFile(from, half);
      await rename(half, to);
    } catch (err) {
      await unlink(half).catch(() => {});
      throw err;
    }
    await unlink(from);
  }
};



// ── 呼び口 ───────────────────────────────────────────────────────
// 入口（MCP・画面）が使うのはこの3つだけ。
export const pairs = () => Object.keys(RECIPES);
export const targets = (from) => targetsFor(normalize(from));

// 変換して、何をしたかを返す。駄目な時は Error を投げる（理由は message に入れる）。
export const convert = async ({ input, to, output, pages, overwrite = false }) => {
  const given = Array.isArray(input) ? input : [input];
  if (given.length === 0) throw new Error('入力が空です。');
  const url = given.length === 1 && isUrl(given[0]);
  const srcs = url ? given : given.map((p) => resolve(p));
  const from = url ? 'url' : normalize(extname(srcs[0]));
  const target = normalize(to);
  const dst = output
    ? resolve(output)
    : url
      ? join(homedir(), 'Downloads', `%(title)s.${target}`)
      : join(dirname(srcs[0]), `${basename(srcs[0], extname(srcs[0]))}.${target}`);
  const key = `${from}>${target}`;
  const recipe = RECIPES[key];

  if (!recipe) {
    // 「そもそも無い」のか「道具が入っていないだけ」なのかを分けて言う。
    // 後者は入れれば直るので、入れ方まで返す。
    const lack = UNAVAILABLE.get(key);
    if (lack) {
      throw new Error(`${key} はこの機械では使えません。道具が足りません:\n`
        + lack.map((t) => `  ${t} — 入れ方: ${install(t)}`).join('\n'));
    }
    const list = targetsFor(from);
    throw new Error(list.length
      ? `${key} は未対応です。${from} から作れるのは: ${list.join(', ')}`
      : `${from} は未対応の入力形式です。`);
  }
  if (!url) {
    for (const s of srcs) {
      try {
        await access(s);
      } catch {
        throw new Error(`入力ファイルが見つかりません: ${s}`);
      }
    }
    // 入力を上書きすると元に戻せない（pdf → pdf の圧縮で起こりうる）
    if (srcs.includes(dst)) throw new Error(`出力先が入力と同じです: ${dst}\noutput に別の場所を指定してください。`);
    // **既にあるファイルを黙って消さない。** エージェントが操られた時に
    // 設定ファイルを潰される道を塞ぐ（公開前のレビューで「高」と指摘された）
  } else {
    await checkUrl(srcs[0]);
  }
  // 取り込み（URL）は一時フォルダを使わないので、ここで見ておく
  if (!overwrite && url && output) {
    // **`access` ではなく `lstat`。** access は symlink を辿った先を見るので、
    // 「切れた symlink」が置かれていると素通りし、**その先に書いてしまう**
    // （2026-08-18 に実際に書けた）。lstat なら symlink そのものが見える。
    const taken = await lstat(dst).then(() => true, () => false);
    if (taken) throw new Error(`そこには既に何かがあります: ${dst}\n上書きするなら overwrite: true を付けてください。`);
  }

  // **必ず「誰も居ない一時フォルダ」の中で変換し、出来た物だけを運び出す。**
  // 出力先へ直接書かせると、道具が勝手に作る連番（`x-0.png`）や連れ子（`.mtl` `.bin`）が
  // **同名の既存ファイルを黙って潰す**（2026-08-18 の4回目の指摘）。
  // 一時フォルダなら「今回出来た物」が一目で分かるので、時刻で推測する必要もない。
  const work = url ? null : mkdtempSync(join(tmpdir(), 'kaeru-out-'));
  const inWork = work ? join(work, basename(dst)) : dst;

  let plan;
  try {
    plan = recipe({ src: srcs[0], srcs, dst: inWork, pages, overwrite });
  } catch (e) {
    // 手口の組み立てで弾かれた時（不正な pages など）も、一時フォルダを残さない
    if (work) await rm(work, { recursive: true, force: true });
    throw e;
  }
  const { cmd, args, produces, timeout = 120_000, fromStdout, cleanup, note } = plan;
  const started = Date.now();
  let stdout = '';
  try {
    // **入力があるフォルダで動かす。** そうしないと `![絵](pic.png)` のような
    // 相対参照が解決できず、画像が黙って落ちる（2026-08-18 実測。docx に画像 0 個）
    ({ stdout } = await run(cmd, args, {
      timeout, maxBuffer: 32 * 1024 * 1024, cwd: url ? undefined : dirname(srcs[0]),
    }));
    if (produces && produces !== inWork) await move(produces, inWork);
  } catch (e) {
    if (work) await rm(work, { recursive: true, force: true });
    throw new Error(`変換に失敗しました（${cmd}）\n${e.stderr || e.message}`);
  } finally {
    for (const c of [cleanup].flat().filter(Boolean)) await rm(c, { recursive: true, force: true });
  }
  const ms = Date.now() - started;

  // 実際に出たものを確かめてから返す（規約02「証拠を出す」）
  let outs = [dst];
  if (fromStdout) {
    outs = [stdout.trim().split('\n').filter(Boolean).pop() || dst];
  } else if (work) {
    // ここから先は**何があっても** work を消す（前は throw の道筋で残っていた）
    const moved = [];
    try {
      const made = (await readdir(work)).sort();
      if (!made.length) throw new Error(`何も出来ませんでした（${cmd}）`);
      // 運び出す前に、行き先が空いているか**1つずつ**見る（連番も連れ子も漏らさない）
      const targets = made.map((f) => join(dirname(dst), f));
      if (!overwrite) {
        for (const t of targets) {
          const taken = await lstat(t).then(() => true, () => false);
          if (taken) throw new Error(`そこには既に何かがあります: ${t}\n上書きするなら overwrite: true を付けてください。`);
        }
      }
      // 上書きを許していない時は「無ければ作る」で運ぶ（確かめてから書くと隙ができる）
      for (let i = 0; i < made.length; i += 1) {
        await move(join(work, made[i]), targets[i], !overwrite);
        moved.push(targets[i]);
      }
      outs = targets;
    } catch (e) {
      // 途中で失敗したら、運んでしまった分を戻す（半端な結果を残さない）。
      // **ただし overwrite: true の時は戻さない。** その時に運んだ物は既存を置き換えた
      // 結果なので、消すと**元からあったファイルごと失う**（2026-08-18 の指摘）
      if (!overwrite) for (const t of moved) await unlink(t).catch(() => {});
      throw e;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return { key, outs, cmd, args, ms, note };
};
