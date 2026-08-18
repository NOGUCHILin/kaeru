// OS ごとの分かれ道だけを確かめる試験。
//
// ここで見るのは「OS ごとに何を探しに行くか」だけ。
// **通っても、その OS の実機で動く保証にはならない。**
//
//   node test/platforms.mjs

import { spec, install, TOOL_NAMES } from '../tools.js';

let ng = 0;
const ok = (label, cond) => {
  if (!cond) ng++;
  console.log(`${cond ? '○' : '×'} ${label}`);
};

const HOME = { win32: 'C:\\Users\\someone', darwin: '/Users/someone', linux: '/home/someone' };
const OSES = ['darwin', 'win32', 'linux'];

// 1. どの OS でも、全部の道具に居場所の当てがある
for (const os of OSES) {
  const missing = TOOL_NAMES.filter((t) => !spec(t, os, HOME[os]));
  ok(`${os}: 12個の道具すべてに探し方がある`, missing.length === 0);
}

// 2. Windows で `convert` を探しに行かない（Windows の convert.exe は別物で、危ない）
ok('win32: magick の候補に convert を入れない',
  !spec('magick', 'win32', HOME.win32).names.includes('convert'));
ok('darwin: magick の候補に convert を入れる（ImageMagick 6 のため）',
  spec('magick', 'darwin', HOME.darwin).names.includes('convert'));

// 3. Ghostscript は Windows だけ名前が違う
ok('win32: gs を gswin64c から探す',
  spec('gs', 'win32', HOME.win32).names[0] === 'gswin64c');
ok('linux: gs は gs のまま',
  spec('gs', 'linux', HOME.linux).names[0] === 'gs');

// 4. LibreOffice は「PATH に無い」ので、OS ごとの置き場所を知っている必要がある
const so = (os) => spec('soffice', os, HOME[os]);
ok('darwin: LibreOffice をアプリの中から探す',
  so('darwin').places.some((p) => p.includes('LibreOffice.app')));
ok('win32: LibreOffice を Program Files から探す',
  so('win32').places.some((p) => p.includes('Program Files') && p.endsWith('soffice.exe')));
ok('linux: LibreOffice を /usr/bin から探す',
  so('linux').places.some((p) => p.startsWith('/usr/bin')));
ok('win32: 置き場所が Windows の区切り（\\）になっている',
  so('win32').places.every((p) => p.includes('\\') && !p.includes('/')));
ok('darwin: 置き場所が Unix の区切り（/）になっている',
  so('darwin').places.every((p) => p.startsWith('/')));

// 5. 入れ方の案内が OS ごとに変わる
ok('darwin: 入れ方が brew', install('soffice', 'darwin').startsWith('brew'));
ok('win32: 入れ方が winget', install('soffice', 'win32').startsWith('winget'));
ok('linux: 入れ方が apt', install('soffice', 'linux').startsWith('apt'));
ok('全 OS・全道具に入れ方がある',
  OSES.every((os) => TOOL_NAMES.every((t) => install(t, os) !== t)));

// 6. Homebrew の置き場所を Windows / Linux に持ち込まない
ok('win32: /opt/homebrew を探さない',
  TOOL_NAMES.every((t) => spec(t, 'win32', HOME.win32).places.every((p) => !p.includes('homebrew'))));

console.log(ng ? `\n${ng}件だめ` : '\n全部とおった');
process.exitCode = ng ? 1 : 0;
