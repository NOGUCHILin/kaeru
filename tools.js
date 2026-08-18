// 変換に使う外の道具を探す。OS ごとに**名前も置き場所も違う**ので、ここに集める。
//
// 見つかった道具の**絶対パス**を返す。見つからなければ null。
// 名前で呼ばずに絶対パスで呼ぶのは、Windows の LibreOffice のように
// **入っているのに PATH に無い**道具があるため。
//
// OS ごとの分かれ道は `spec()` に閉じ込めてある。**別の OS が手元に無くても
// 分かれ道そのものは試験できる**形にした（test/platforms.mjs）。

import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, delimiter, win32, posix } from 'node:path';
import { homedir, platform } from 'node:os';

const HERE = platform();

// 道具ごとの「探す名前」と「よくある置き場所」を、OS を受け取って返す。
// 引数で OS を渡せるようにしてあるのは、**手元の1台で Windows / Linux の
// 分かれ道を確かめられるようにする**ため。
export const spec = (tool, os = HERE, home = homedir()) => {
  const win = os === 'win32';
  const mac = os === 'darwin';
  const brew = (name) => (mac ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`] : []);
  const table = {
    // ImageMagick 6 までは convert という名前だった。ただし **Windows の convert.exe は
    // ディスクを変換する別物**（呼ぶと危ない）ので、Windows では候補に入れない。
    magick: { names: win ? ['magick'] : ['magick', 'convert'], places: brew('magick') },
    // 絵を読み直す道具。ImageMagick 7 は `magick identify`、6 は `identify` という
    // 別の実行ファイル。**6 の convert に identify を渡すと落ちる**（Linux で踏んだ）
    identify: { names: ['identify'], places: brew('identify') },
    ffmpeg: { names: ['ffmpeg'], places: brew('ffmpeg') },
    ffprobe: { names: ['ffprobe'], places: brew('ffprobe') },
    pandoc: { names: ['pandoc'], places: brew('pandoc') },
    weasyprint: { names: ['weasyprint'], places: brew('weasyprint') },
    qpdf: { names: ['qpdf'], places: brew('qpdf') },
    img2pdf: { names: ['img2pdf'], places: brew('img2pdf') },
    'yt-dlp': { names: ['yt-dlp'], places: brew('yt-dlp') },
    assimp: { names: ['assimp'], places: brew('assimp') },
    duckdb: { names: ['duckdb'], places: brew('duckdb') },
    // Ghostscript は Windows だけ実行ファイルの名前が違う
    gs: { names: win ? ['gswin64c', 'gswin32c', 'gs'] : ['gs'], places: brew('gs') },
    // LibreOffice は「入っているのに PATH に無い」の代表。アプリの中に隠れている
    soffice: {
      names: win ? ['soffice.exe', 'soffice'] : ['soffice', 'libreoffice'],
      places: mac
        ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice',
          posix.join(home, 'Applications/LibreOffice.app/Contents/MacOS/soffice')]
        : win
          ? [win32.join('C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
            win32.join('C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe')]
          : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/snap/bin/libreoffice'],
    },
  };
  return table[tool] ?? null;
};

export const TOOL_NAMES = [
  'magick', 'identify', 'ffmpeg', 'ffprobe', 'pandoc', 'weasyprint', 'qpdf',
  'img2pdf', 'yt-dlp', 'assimp', 'duckdb', 'gs', 'soffice',
];

// Windows は拡張子を補って探す（PATHEXT に「何を実行できるか」が入っている）
const extsFor = (os) =>
  (os === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']);

const runnable = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// PATH を自分でたどる。`which` を呼ぶと OS ごとに違ううえ、道具の数だけ
// プロセスを起こすことになる（立ち上がりが遅くなる）。
const fromPath = (name) => {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of extsFor(HERE)) {
      const p = join(dir, name + ext);
      if (runnable(p)) return p;
    }
  }
  return null;
};

// 「その道具が無い機械」を、この機械の上で試すための仕掛け。
// 例: KAERU_WITHOUT=soffice,duckdb node server.js --doctor
const pretendMissing = new Set((process.env.KAERU_WITHOUT ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const found = new Map();

export const bin = (tool) => {
  if (found.has(tool)) return found.get(tool);
  const s = spec(tool);
  let path = null;
  if (s && !pretendMissing.has(tool)) {
    for (const name of s.names) {
      path = fromPath(name);
      if (path) break;
    }
    if (!path) path = s.places.find((p) => existsSync(p)) ?? null;
  }
  found.set(tool, path);
  return path;
};

export const has = (...tools) => tools.every((t) => bin(t) !== null);

// ── 道具の「版」まで見る ─────────────────────────────────────────
// 道具が入っていても、その版が対応しているとは限らない。
// Linux の pandoc 2 系は typst も djot も知らない（2026-08-18 実機で 270件落ちた）。
// **道具に直接「何ができるか」を聞いて、できないものは名乗らない。**
const asked = new Map();
const ask = (key, tool, args, parse) => {
  if (asked.has(key)) return asked.get(key);
  let set = null; // null = 聞けなかった（その時は絞り込まない）
  const cmd = bin(tool);
  if (cmd) {
    try {
      set = parse(execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 << 20 }));
    } catch {
      set = null;
    }
  }
  asked.set(key, set);
  return set;
};

const lines = (out) => new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));

// pandoc が読める形式・書ける形式
export const pandocReads = () => ask('pandoc-in', 'pandoc', ['--list-input-formats'], lines);
export const pandocWrites = () => ask('pandoc-out', 'pandoc', ['--list-output-formats'], lines);

// ImageMagick が読み書き**両方**できる形式（6 と 7 で中身が違う）
export const magickFormats = () =>
  ask('magick', 'magick', ['-list', 'format'], (out) => {
    const set = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9]+)\*?\s+\S+\s+rw/);
      if (m) set.add(m[1].toLowerCase());
    }
    return set;
  });

// ImageMagick には「この形式は触らせない」という取り決め（policy）がある。
// Debian の既定は PDF と PS を禁じている（2026-08-18 実機で踏んだ）。
// 入っていても**使わせてもらえない**ので、これも聞いて外す。
export const magickBlocked = () =>
  ask('magick-policy', 'magick', ['-list', 'policy'], (out) => {
    const blocked = new Set();
    let pattern = null;
    for (const line of out.split('\n')) {
      const p = line.match(/^\s*pattern:\s*(\S+)/);
      if (p) { pattern = p[1].toLowerCase(); continue; }
      const r = line.match(/^\s*rights:\s*(\S+)/);
      if (r && pattern && /^none$/i.test(r[1])) blocked.add(pattern);
    }
    return blocked;
  });

// 聞けた時だけ絞る。聞けなかった時は今までどおり（黙って減らさない）
export const keepSupported = (list, supported, alias = (x) => x) =>
  (supported ? list.filter((x) => supported.has(alias(x))) : list);

// 何が見つかって何が無いかの一覧（`--doctor` と画面が使う）
export const inventory = () => TOOL_NAMES.map((tool) => ({ tool, path: bin(tool) }));

// 道具ごとの「入れ方」。無い時にこれを見せる
export const install = (tool, os = HERE) => {
  const mac = {
    magick: 'brew install imagemagick', identify: 'brew install imagemagick', ffmpeg: 'brew install ffmpeg', ffprobe: 'brew install ffmpeg',
    pandoc: 'brew install pandoc', weasyprint: 'brew install weasyprint', qpdf: 'brew install qpdf',
    img2pdf: 'brew install img2pdf', 'yt-dlp': 'brew install yt-dlp', assimp: 'brew install assimp',
    duckdb: 'brew install duckdb', gs: 'brew install ghostscript',
    soffice: 'brew install --cask libreoffice',
  };
  const win = {
    magick: 'winget install ImageMagick.ImageMagick', identify: 'winget install ImageMagick.ImageMagick',
    ffmpeg: 'winget install Gyan.FFmpeg',
    ffprobe: 'winget install Gyan.FFmpeg', pandoc: 'winget install JohnMacFarlane.Pandoc',
    weasyprint: 'pip install weasyprint', qpdf: 'winget install QPDF.QPDF',
    img2pdf: 'pip install img2pdf', 'yt-dlp': 'winget install yt-dlp.yt-dlp',
    assimp: 'winget install Assimp.Assimp', duckdb: 'winget install DuckDB.cli',
    gs: 'winget install ArtifexSoftware.GhostScript',
    soffice: 'winget install TheDocumentFoundation.LibreOffice',
  };
  const linux = {
    magick: 'apt install imagemagick', identify: 'apt install imagemagick', ffmpeg: 'apt install ffmpeg', ffprobe: 'apt install ffmpeg',
    pandoc: 'apt install pandoc', weasyprint: 'pip install weasyprint', qpdf: 'apt install qpdf',
    img2pdf: 'apt install img2pdf', 'yt-dlp': 'apt install yt-dlp', assimp: 'apt install assimp-utils',
    duckdb: 'https://duckdb.org/docs/installation/', gs: 'apt install ghostscript',
    soffice: 'apt install libreoffice',
  };
  return (os === 'win32' ? win : os === 'darwin' ? mac : linux)[tool] ?? tool;
};
