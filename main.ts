// main.ts is mend, the CLI SPEC.md specifies. It reads an edit an AI model wrote, in one of four formats
// (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON), and applies it to
// the tree in the working directory: every file is changed, or nothing is. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// The file follows SPEC.md section by section: the command line and the exit codes (sections 1 and 2), files,
// lines and safe paths (section 3), format detection (section 4), three-tier line matching (section 5), the
// four readers (sections 6 to 9) and the all-or-nothing write (section 10). In a trial the grader runs
// `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts (the last lines
// below): that hand-over and runner.ts stay as the kit wrote them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer, decided before any file is looked at: the one line standard output holds. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns (SPEC.md section 2). */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

/** A patch's lines (section 3): split at `\n`, one trailing `\r` removed from each, no empty final piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, `.` or `..` segment. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file taken apart the way section 3 reads it: its own line break, its lines, whether it ends with one. */
interface FileParts {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

/** The text of a file with these lines: a file of no lines is written empty. */
function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.finalBreak ? parts.br : '');
}

// Section 5: matching lines at three tiers.

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at or after `from` where the old lines match the file's lines at this tier; they may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  // Two lines are equal at a tier exactly when their tier transforms are equal, so each line is
  // transformed once here instead of once per comparison.
  const shape = tier === 1 ? stripTrail : tier === 2 ? stripBoth : (s: string): string => s;
  const fileShape = lines.map(shape);
  const oldShape = oldLines.map(shape);
  const at: number[] = [];
  outer: for (let i = from; i + oldLines.length <= lines.length; i += 1) {
    for (let j = 0; j < oldLines.length; j += 1) {
      if (fileShape[i + j] !== oldShape[j]) continue outer;
    }
    at.push(i);
  }
  return at;
}

/** The first tier at which the old lines occur at or after `from`, and every position there. */
function findTier(lines: string[], oldLines: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, oldLines, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: a context line (written as the file's own matched line) or a written line. */
interface NewLine {
  text: string;
  ctx: boolean;
  at: number; // for a context line, its index within the old lines; -1 otherwise
}

/**
 * The lines a match is replaced by. A context line is the file's own matched line, never the patch's. At
 * tier 2 every other line is re-indented: with F the leading spaces and tabs of the file's first matched
 * line and P those of the old lines' first, a line that is not empty and not only whitespace and starts
 * with P has that P replaced by F; any other line is written as it is.
 */
function renderNew(lines: string[], pos: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const fileLead = tier === 2 ? leadWs(lines[pos]!) : '';
  const patchLead = tier === 2 ? leadWs(oldLines[0]!) : '';
  return newLines.map((e) => {
    if (e.ctx) return lines[pos + e.at]!;
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(patchLead)) {
      return fileLead + e.text.slice(patchLead.length);
    }
    return e.text;
  });
}

/** One body line of a unified hunk or a V4A chunk. `fromEmpty` marks a line that was empty in the patch. */
interface BodyEntry {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  fromEmpty?: boolean;
}

/** The old lines and the replacement lines a hunk's or chunk's body entries name, in body order. */
function bodySides(entries: BodyEntry[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      oldLines.push(e.text);
      newLines.push({ text: e.text, ctx: true, at: oldLines.length - 1 });
    } else if (e.kind === 'del') {
      oldLines.push(e.text);
    } else if (e.kind === 'add') {
      newLines.push({ text: e.text, ctx: false, at: -1 });
    }
  }
  return { oldLines, newLines };
}

/**
 * The tree as the edits leave it: the paths an edit has decided in `now` (null: deleted), everything else
 * read from disk as it was before the patch. `moves` records the move edits that succeeded, in order, for
 * the `R` lines of section 2.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Section 4: the format of a patch read as `auto`, the first of the four tests that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Section 9: JSON edits.

/** One JSON edit object, or null when it is not one (a parse fault). Keys the commands do not name are ignored. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const parts = splitFile(before);
      const crlf = parts.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(parts));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array of edit objects, or JSON Lines with one object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Section 6: unified diffs.

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  hdrOld?: string;
  hdrNew?: string;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to a tab, spaces removed, prefix removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) return null;
  return [rest.slice(2, cut), rest.slice(cut + 3)];
}

/** Whether a `\` line follows the hunk's last context or `+` line (the final-break rule of section 6). */
function noBreakAfter(entries: BodyEntry[]): boolean {
  let last = -1;
  entries.forEach((e, k) => {
    if (e.kind === 'ctx' || e.kind === 'add') last = k;
  });
  return last >= 0 && entries[last + 1]?.kind === 'bs';
}

/**
 * A section's hunks applied in order, each to the result of the ones before it. `d` is the sum over the
 * hunks applied so far of (the replacement's length minus the old lines' length); a hunk takes the
 * occurrence nearest to A - 1 + d, an empty old side is inserted after the first A + d lines, and a hunk
 * whose match runs to the end of the file decides its final break by the `\` rule.
 */
function applyHunks(parts: FileParts, hunks: Hunk[], path: string, strict: boolean): FileParts {
  const lines = parts.lines.slice();
  let finalBreak = parts.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = bodySides(h.entries);
    if (oldLines.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const toEnd = at === lines.length;
      lines.splice(at, 0, ...newLines.map((e) => e.text));
      if (toEnd) finalBreak = !noBreakAfter(h.entries);
      d += newLines.length;
      continue;
    }
    const found = findTier(lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
    const written = renderNew(lines, at, oldLines, newLines, found.tier);
    const toEnd = at + oldLines.length === lines.length;
    lines.splice(at, oldLines.length, ...written);
    if (toEnd) finalBreak = !noBreakAfter(h.entries);
    d += newLines.length - oldLines.length;
  }
  return { br: parts.br, lines, finalBreak };
}

/** One unified section as an edit: a creation, a deletion, a move, or a change of the one path. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.hdrOld ?? sec.renOld ?? sec.diffOld;
  const newPath = sec.hdrNew ?? sec.renNew ?? sec.diffNew;
  const creation = oldPath === '/dev/null' || sec.newFile;
  const deletion = newPath === '/dev/null' || sec.delFile;
  return (tree) => {
    // Every path the edit names is checked for safety before anything else about it (section 10).
    if (oldPath !== undefined && oldPath !== '/dev/null' && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== undefined && newPath !== '/dev/null' && newPath !== oldPath && !safePath(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const target = newPath!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const flat: BodyEntry[] = [];
      for (const h of sec.hunks) flat.push(...h.entries);
      const plus: string[] = [];
      let lastAdd = -1;
      flat.forEach((e, k) => {
        if (e.kind === 'add') {
          plus.push(e.text);
          lastAdd = k;
        }
      });
      const noBreak = lastAdd >= 0 && flat[lastAdd + 1]?.kind === 'bs';
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      const target = oldPath!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldPath!;
    const to = newPath!;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const done = applyHunks(splitFile(before), sec.hunks, from, strict);
    const text = joinFile(done);
    if (to !== from) {
      tree.now.set(to, text);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, text);
    }
  };
}

/**
 * The edits of a unified patch. Sections start at `diff --git` lines and at `--- `/`+++ ` pairs that are
 * not already part of a section's header; outside hunk bodies, lines that are not part of a section header
 * are ignored (prose, code fences).
 */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const open = (): Section => {
    const s: Section = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const gp = gitPaths(line);
      if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = open();
      s.diffOld = gp[0];
      s.diffNew = gp[1];
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: BodyEntry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') entries.push({ kind: 'ctx', text: '', fromEmpty: true });
        else if (b[0] === ' ') entries.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') entries.push({ kind: 'del', text: b.slice(1) });
        else if (b[0] === '+') entries.push({ kind: 'add', text: b.slice(1) });
        else if (b[0] === '\\') entries.push({ kind: 'bs', text: '' });
        else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (entries.length > 0 && entries[entries.length - 1]!.fromEmpty === true) entries.pop();
      cur.hunks.push({ a: Number(m[1]), entries });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.hdrOld === undefined) {
          cur.hdrOld = headerPath(line);
          cur.hdrNew = headerPath(next);
        } else {
          const s = open();
          s.hdrOld = headerPath(line);
          s.hdrNew = headerPath(next);
        }
        i += 2;
        continue;
      }
      // A `--- ` line not followed by a `+++ ` line, inside a section's header, names the line after it.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = trimSpaces(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renNew = trimSpaces(line.slice('rename to '.length));
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** One block as an edit: an empty old side creates the file; otherwise the old lines occur exactly once. */
function blockEdit(b: Block, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.at[0]!;
    const newLines: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: false, at: -1 }));
    const written = renderNew(parts.lines, at, b.oldLines, newLines, found.tier);
    parts.lines.splice(at, b.oldLines.length, ...written);
    tree.now.set(b.path, joinFile(parts));
  };
}

/**
 * The edits of a SEARCH/REPLACE patch. A block's path is the nearest line before its SEARCH line, after
 * the previous block, that is not blank and does not start with three backticks; with none, the block
 * takes the previous block's path. Lines outside blocks are ignored.
 */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let bound = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k >= bound; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let j = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        j = k;
        break;
      }
    }
    if (j < 0) throw new Exit2(`error: parse ${s + 1}`);
    let m = -1;
    for (let k = j + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        m = k;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, j), newLines: lines.slice(j + 1, m) });
    prevPath = path;
    bound = m + 1;
    i = m + 1;
  }
  return blocks.map((b) => blockEdit(b, strict));
}

// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface RawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  atLine: number;
  raw: { text: string; no: number }[];
}

/** An Update File section's edit: its chunks applied in order behind a cursor that only moves forward. */
function updateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    const lines = parts.lines.slice();
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (tierEq(lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines } = bodySides(chunk.entries);
      if (oldLines.length === 0) {
        const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...newLines.map((e) => e.text));
        cursor = at + newLines.length;
        continue;
      }
      let hit: { tier: number; at: number } | null = null;
      for (const tier of tiers) {
        const all = occurrences(lines, oldLines, tier, cursor);
        const ok = chunk.eof ? all.filter((p) => p + oldLines.length === lines.length) : all;
        if (ok.length > 0) {
          hit = { tier, at: ok[0]! };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', path);
      const written = renderNew(lines, hit.at, oldLines, newLines, hit.tier);
      lines.splice(hit.at, oldLines.length, ...written);
      cursor = hit.at + written.length;
    }
    const text = joinFile({ br: parts.br, lines, finalBreak: parts.finalBreak });
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** One V4A section, read as its kind demands; anything else in it is a parse fault at that line. */
function v4aSection(r: RawSection, strict: boolean): Edit {
  const raw = r.raw.slice();
  // Blank lines at the end of a section are not part of it.
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  if (r.kind === 'add') {
    const content: string[] = [];
    for (const { text, no } of raw) {
      if (text.startsWith('+')) content.push(text.slice(1));
      else if (text === '') content.push('');
      else throw new Exit2(`error: parse ${no}`);
    }
    return (tree) => {
      if (!safePath(r.path)) throw new Fail('unsafe', r.path);
      if (tree.get(r.path) !== null) throw new Fail('exists', r.path);
      tree.now.set(r.path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (r.kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return (tree) => {
      if (!safePath(r.path)) throw new Fail('unsafe', r.path);
      if (tree.get(r.path) === null) throw new Fail('missing', r.path);
      tree.now.set(r.path, null);
    };
  }
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(raw[0]!.text.slice('*** Move to: '.length));
    start = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = start; k < raw.length; k += 1) {
    const { text, no } = raw[k]!;
    if (text.startsWith('@@')) {
      cur = { anchor: trimSpaces(text.slice(2)) || null, eof: false, entries: [] };
      chunks.push(cur);
    } else if (text.startsWith('***') && text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
    } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        // Only the first chunk of a section may start at a body line.
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, entries: [] };
        chunks.push(cur);
      }
      if (text === '') cur.entries.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') cur.entries.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') cur.entries.push({ kind: 'del', text: text.slice(1) });
      else cur.entries.push({ kind: 'add', text: text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.atLine}`);
  return updateEdit(r.path, moveTo, chunks, strict);
}

/**
 * The edits of a V4A patch: `*** Begin Patch`, sections, `*** End Patch`. The first and last non-blank
 * lines are the two markers; between them, sections start at the Add, Delete and Update File lines, and
 * blank lines between sections are ignored.
 */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: [string, RawSection['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'delete'],
    ['*** Update File: ', 'update'],
  ];
  const raws: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let k = first + 1; k < last; k += 1) {
    const line = lines[k]!;
    const head = heads.find(([prefix]) => line.startsWith(prefix));
    if (head !== undefined) {
      cur = { kind: head[1], path: trimSpaces(line.slice(head[0].length)), atLine: k + 1, raw: [] };
      raws.push(cur);
    } else if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${k + 1}`);
    } else {
      cur.raw.push({ text: line, no: k + 1 });
    }
  }
  return raws.map((r) => v4aSection(r, strict));
}

// Sections 1, 2 and 10: the command line, the run of the edits, and the write.

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // The edits run in the patch's order, each on the tree as the ones before it left it; a failed edit
  // changes nothing, and the edits after it still run, so every failure is reported.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line for each path whose state changed, in byte order of the paths; a successful move replaces
  // its pair's `D` and `A` lines with one `R` line that sorts by the new path.
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
