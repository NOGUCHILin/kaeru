# Security

kaeru runs converters on your machine. That is the point — and it is also where the risks are.
This file lists what we fixed, and what is still true. Nothing here is hidden.

## What this protects against

kaeru runs real converters on your machine, so it is worth being explicit about **who the
adversary is**:

1. **A misled agent.** kaeru is a tool an AI drives. If the AI is talked into it by a poisoned
   document or web page, it could be told to write over `~/.ssh/authorized_keys`, or to fetch
   `http://169.254.169.254/`. The overwrite guard and the address checks exist for this.
2. **A file somebody sent you.** Converting a stranger's PDF, HTML or spreadsheet must not
   leak your data into the output, and must not let the file steer the converter's arguments.
3. **A web page open in your browser.** A hostile site must not be able to reach the local
   web UI (DNS rebinding), read results, or use it to write files.

**What it does not protect against**, deliberately:

- **Someone already logged in as you.** They can run the converters directly; kaeru adds nothing.
- **`overwrite: true`.** You asked for it. Existing files will be replaced.

## Reporting

Open a GitHub issue. If it is sensitive, write "security" in the title and I will
follow up. **One-person project: no response time is promised.**

## What kaeru does and does not do

- **No network requests**, except when *you* pass a video-site URL.
- **No telemetry.** None, not even anonymous.
- The web UI listens on `127.0.0.1` only, **and rejects requests whose `Host` header is not
  localhost** (this blocks DNS-rebinding, where a hostile site points its domain at 127.0.0.1).
- Uploads are streamed to a private temp directory (`0700`), never buffered in memory,
  and deleted when the server stops.
- Results are handed back by an unguessable id, never by path.
- **Existing files are not overwritten** unless you pass `overwrite: true`.

## Reviewed 2026-08-18

Three independent models (GPT-5.6, Gemini 3.1 Pro, Grok 4.5) reviewed the source.
Everything they rated exploitable was fixed the same day:

| Issue | Severity | Status |
|---|---|---|
| `pages` was passed to `qpdf` unchecked — `--file=/secret.pdf` could splice in another PDF | high | **fixed** (strict allowlist) |
| Agents could overwrite any file, e.g. `~/.ssh/authorized_keys` | high | **fixed** (refuses existing files unless `overwrite: true`) |
| A URL like `http://127.0.0.1:…` or `192.168.…` could be fetched (SSRF) | high | **fixed** (loopback / private / link-local rejected) |
| Uploads were buffered in RAM — 2 GB could crash the process | high | **fixed** (streamed to disk) |
| DNS rebinding: `Host` was not checked | medium | **fixed** |
| LibreOffice profile dir was `…/kaeru-lo-<pid>` — another user could pre-create a symlink | medium | **fixed** (`mkdtemp`) |

They found **no** shell injection, no `-`/`@`/`MSL:` argument injection (paths are resolved
absolute and passed via `execFile` without a shell), no SQL injection in the DuckDB path,
no id guessing, and no ordinary CSRF.

## Second review, 2026-08-18 (same day)

The same three models were then asked to **break the fixes**. They did — six more holes,
all closed:

| Issue | Severity | Status |
|---|---|---|
| The SSRF check compared *strings*, so `0x7f.0.0.1`, `2130706433`, `[::ffff:7f00:1]` and any domain that merely *resolves* to 127.0.0.1 (e.g. `localtest.me`) walked through | high | **fixed** — the hostname is resolved and the **returned addresses** are checked |
| `pandocToPdf` was the one branch without `--sandbox` | high | **fixed** |
| IPv6 link-local was matched as `fe80:` only, so `fe90…`–`febf…` passed | medium | **fixed** (`fe80::/10`) |
| The overwrite guard was skipped entirely on the URL path | medium | **fixed** |
| A partial upload and its directory were left on disk after a failure; no concurrency cap | medium | **fixed** (cleaned on error, 4 at a time) |
| `Host: localhost:99999` made `new URL()` throw **outside** a try — the server could die | low | **fixed** |
| `pages` still accepted a leading `-` | low | **fixed** (must start with a digit, `r` or `z`) |

One of the fixes had also broken something: the old string check blocked every domain
starting with `fc`/`fd` — `fc2.com`, `fda.gov`. Resolving addresses instead of matching names
removed that too. Verified: those domains pass again.

## Third review, 2026-08-18

Round three. Two more real holes, plus two bugs the earlier fixes had introduced.

| Issue | Severity | Status |
|---|---|---|
| A **dangling symlink** at the output path was followed — `access()` looks through the link, so kaeru created the file at the link's target | high | **fixed** (`lstat`) |
| The "produced files" list was collected by filename prefix, so **unrelated pre-existing files** (`report-secret.png`) were returned as outputs — a filename leak, and a wrong count | medium | **fixed** (only files written during this run) |
| Downloadable results were kept forever (memory and disk) | low | **fixed** (last 50, older ones deleted) |

**Two things the earlier fixes had broken — both found here, both fixed:**

- **`--sandbox` silently dropped images from documents.** `![picture](pic.png)` produced a
  docx with zero images. It has been **removed**: it costs a core feature and does not close
  the real hole anyway (the PDF engine does its own fetching, outside pandoc).
- **Same-format compression was broken in the web UI** (`png → png` failed with "output is the
  same as input") because the result was written beside the upload. Outputs now go to their
  own directory.

Chasing that second one uncovered a third bug that had **nothing to do with security**:
converters were not run in the input file's directory, so **relative images were never
embedded at all**. Now they are.

## Fourth review, 2026-08-18

Round four. **Gemini found no security holes.** Grok found one, Codex found four; three were
real and are fixed. Two of the four were logic bugs that the round-three fixes had introduced.

| Issue | Severity | Status |
|---|---|---|
| The overwrite guard only checked the **main** output. Converters that write extra files — `page-0.png`, `page-1.png` from a multi-page PDF, or the `.mtl`/`.bin` that goes with a 3D model — **silently replaced existing files** even with `overwrite: false` (both Grok and Codex reproduced it) | medium | **fixed** — every conversion now runs in a private temp directory and each produced file is checked before it is moved out |
| "Produced files" were identified by modification time, so a file with a future timestamp could be smuggled into the result list | medium | **fixed** by the same change (nothing in your directory is scanned any more) |
| The result cache counted files but deleted whole directories — a 51-page PDF wiped its own siblings' download links | medium | **fixed** (evicts by conversion, not by file) |
| **LibreOffice conversions could no longer run in parallel** — one shared profile directory per process meant 2 of 3 simultaneous conversions failed | medium (bug) | **fixed** — a fresh profile per conversion (costs ~0 s single, and 3 parallel now all succeed) |

## Fifth review, 2026-08-18

Round five. Nothing new was found in the conversion table or the network paths. What came
back was about the round-four rewrite itself, plus one thing this project had previously
written off as "won't fix" and then closed anyway.

| Issue | Severity | Status |
|---|---|---|
| **Two conversions aimed at the same output both succeeded** — one silently replaced the other. This was the documented TOCTOU race | medium | **fixed** — the final move is now a single atomic "create only if absent" (`link`), so exactly one wins and the others are told the path is taken |
| Temp directories leaked: the recipe was built outside the `try`, so an invalid `pages` left one behind every time; so did an empty result and any failure while moving | low | **fixed** (`finally` — nothing survives a failure) |
| If a multi-file result failed halfway, **the files already moved stayed behind**, leaving a half-written result | low | **fixed** (moved files are removed again on failure) |
| Copying across filesystems wrote straight to the destination, so a half-copied file was briefly visible | low | **fixed** (copy to a temp name, then one atomic step) |
| Downloading a video without naming an output could overwrite an existing file | low | **fixed** (`--no-overwrites`) |

The TOCTOU line has been removed from the list below: it is closed.

## Sixth review, 2026-08-18

Round six. **No new security holes.** All three reviewers instead converged on the same two
*functional* bugs that round five had introduced, plus two portability problems.

| Issue | Severity | Status |
|---|---|---|
| **`overwrite: true` stopped working for downloads** — `--no-overwrites` was hardcoded, so yt-dlp skipped and an old file could be returned as the new result | bug | **fixed** (the flag now follows `overwrite`) |
| **The rollback could delete your data.** With `overwrite: true`, files already moved were files that had *replaced* something. Removing them on a later failure destroyed the original as well | bug (data loss) | **fixed** (rollback only when kaeru created the files) |
| `link()` does not exist on FAT/exFAT/SMB shares, so "create only if absent" failed outright there | portability | **fixed** (falls back to an exclusive copy — verified on a real FAT volume) |
| A failed rename could leave a `*.part-…` file behind | low | **fixed** |

Verified on a FAT disk image: conversion succeeds, a second conversion to the same name is
refused, and no temporary files are left.

## Seventh review, 2026-08-18

Round seven. **No security findings from any of the three.** One reviewer replied simply
"none" for the second round running. What remained were three durability details:

| Issue | Severity | Status |
|---|---|---|
| The exclusive copy used on hardlink-less disks was not atomic, and a half-written file was briefly readable under its final name | low | **fixed** — the destination is now created exclusively first (`wx`) and then filled |
| `ENOSYS` (some older Linux and FUSE mounts) was not in the fallback list, so those disks failed outright | low | **fixed** |
| A cross-disk copy that ran out of space left a `*.part-…` file behind | low | **fixed** |

A flaky test also exposed a real weakness: PDF conversion did not tell pandoc the **input**
format, so pandoc guessed from the extension and warned for unusual ones. It is now explicit.

**Seven rounds, 38 fixes.** The last two rounds produced no new security holes.

## Known, not fixed — read this before converting files you did not write

**Converting an untrusted document can pull in local files.**

This is the one that matters. It applies to **any input format that can reference another
file** — HTML, SVG, Markdown, reStructuredText, LaTeX and friends — and to **any output that
can embed one**, including DOCX, ODT, EPUB and PDF.

- `weasyprint` (PDF) and ImageMagick (SVG) resolve `<img src="file:///etc/passwd">` and remote
  URLs. A reviewer reproduced it, watching WeasyPrint fetch `http://127.0.0.1:…`.
- pandoc resolves relative paths like `![](../../.ssh/id_rsa.pub)` from the input file's
  directory, because kaeru runs converters there — that is what makes ordinary
  `![](picture.png)` work at all.

If you convert a document somebody sent you and then share the result, **the output can
contain data from your machine**. Do not convert documents you do not trust, or run kaeru as
a user that cannot read anything sensitive.

- pandoc runs with `--sandbox`, which stops *pandoc* reading extra files — but the PDF engine
  is a separate program and does its own fetching.
- Mitigation for now: **do not convert HTML/SVG from an untrusted source**, or run kaeru as a
  user that cannot read anything sensitive.
- ImageMagick users can also restrict this system-wide in `policy.xml`
  (kaeru already respects that policy and hides conversions it forbids).

This is a real limitation, not a theoretical one — a reviewer reproduced it, watching
WeasyPrint fetch `http://127.0.0.1:…` from an `<img>` tag. It will be addressed by isolating
the PDF engine; until then it is documented rather than glossed over.

**Two smaller ones, also open:**

- **Redirects.** kaeru checks the address you give it, but `yt-dlp` follows redirects, and a
  hostile server can redirect to an internal address. Only pass URLs you trust.
- **DNS between check and fetch.** kaeru resolves the host and checks the addresses, but
  `yt-dlp` resolves again when it connects. A hostile DNS server can answer differently the
  second time. Same class as the redirect issue above: only pass URLs you trust.
- **No resource ceiling beyond a timeout.** A deliberately hostile document can keep a
  converter busy until the 2-minute (or 10-minute) limit. There is no memory or output-size cap.

## Other limits worth knowing

- **The MCP tool can read and write anywhere the user can.** That is inherent to a file
  conversion tool an agent drives. The overwrite guard is the safety net; there is no jail.
- Very large or deliberately malformed media can still make a converter spin. Conversions are
  killed after 2 minutes (10 minutes for video and downloads).
