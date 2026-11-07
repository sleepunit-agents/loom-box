// Labels for a body's steps, and the redaction every label goes through (loom docs/specs/comms.md, section 3; t-1944).
//
// A step's label is one plain line: what a command did, which file, what was searched for, who was messaged. It's made
// here by fixed rules from what the harness recorded (a Bash description is the body's own words, redacted like the
// rest; nothing is asked of a model to make one), and never carries a tool's output, a file's contents or an
// environment value. Its shapes (the contract, as decided 2026-11-07):
//   - a shell command: its description (through the gate as a whole), else a closed vocabulary: `Ran <program>` for a
//     program on PLAIN or SUBS, and for one on SUBS one subcommand from its list and one id (a number, #N, t-N). No
//     file, pattern, host or value from a raw command line ever shows; a program on neither list is "Ran a command".
//   - Read, Grep, Glob, NotebookEdit and file changes (structured arguments, activity.mjs) show a file by its base name
//     only (never a folder, a home or ~/.config) and the line range or the pattern; a file under ~/.config, an env file,
//     a key, a token or a credentials file is "a private file" (privateFile).
// THE GATE: every variable part of every label (a file name, a pattern, a host, an id, a count, a subcommand, a first
// line) passes `part(kind, value)` before it's put in: redacted, on one printable line, and of its kind's length and
// characters, or "…". The finished label is redacted once more as a whole.
//
// What redaction costs (accepted): a long token-like run goes even when it's harmless, so a 40-hex commit SHA or a
// content-hashed file name (`main.a1b2c3d4e5f6a7b8c9d0.js`) shows as `…`. A label is for seeing what a body is doing,
// and a SHA in it isn't worth a token getting through.
//
// stuck.mjs (the clock's patterns) and watch.mjs (a box's log lines) keep their own `redact` for their own text; one
// shared module for all three is t-1948. Every regex here runs on input cut to INPUT_MAX first, and the open-ended
// ones are bounded, so a long line can't make one backtrack for long.

/** What stands in for anything taken out. */
export const GONE = '…';
/** The most of any text a label is made from, or redaction reads: a label shows 120 at most. */
export const INPUT_MAX = 2000;

/** `s` cut to INPUT_MAX, and then back to the last whole word, so a cut never leaves half a token. */
export function cutInput(s) {
  const t = String(s ?? '');
  return t.length <= INPUT_MAX ? t : t.slice(0, INPUT_MAX).replace(/\S*$/, '');
}

// Known secret shapes: GitHub, Anthropic/OpenAI, Slack, AWS, Google, GitLab, npm, age, JWTs, PEM blocks.
const SHAPES = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAGE-SECRET-KEY-1[0-9A-Z]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
];

/** Words that name a secret: a NAME=value's, a flag's, a query parameter's, a `key: value`'s. */
const SECRET_WORDS = 'token|secret|pass(?:w(?:or)?d)?|pwd|key|auth|credential|session|cookie|sig(?:nature)?|login';
const SECRET_NAME = `[A-Za-z0-9_.-]{0,40}(?:${SECRET_WORDS})[A-Za-z0-9_.-]{0,40}`;

/** A long run of key-like characters with one long unbroken part and both letters and digits: likely a token. */
function tokenLike(run) {
  if (run.length < 20 || !/[A-Za-z]/.test(run)) return false;
  // A kebab or snake name (`t-1382-recorder-health-ledger`) or a UUID is many short parts; a token has a long one: 20
  // or more with letters and digits, or 32 or more in both cases, digits or not. Either is a token unless it reads as
  // words (wordsLike). When unsure it goes: a redacted label is better than a leaked key.
  return run.split(/[-_.]/).some((p) => !wordsLike(p) && ((p.length >= 20 && /[A-Za-z]/.test(p) && /[0-9]/.test(p)) || mixedLong(p)));
}
/** 32 or more characters with both capitals and small letters. */
const mixedLong = (p) => p.length >= 32 && /[a-z]/.test(p) && /[A-Z]/.test(p);

/**
 * Whether a part reads as words in CamelCase: every piece between its capitals 3 or more lowercase letters (a piece may
 * end in one or two digits, `Comms2`), and two digits at most in all. `useComms2ThreadActivity` does; a key doesn't.
 */
function wordsLike(p) {
  if ((p.match(/[0-9]/g) ?? []).length > 2) return false;
  const pieces = p.split(/(?=[A-Z])/);
  return pieces.every((x) => /^[A-Za-z][a-z]{2,}[0-9]{0,2}$/.test(x));
}

/**
 * A run of base64 (`/` and `+` in it) with a digit, any of whose slash-parts holds two capitals and doesn't read as
 * words. An AWS secret key (`wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`) is; a CamelCase path
 * (`web/src/ui/useComms2ThreadActivity`) isn't.
 */
function base64Like(run) {
  const parts = run.split(/[/+=]/);
  if (parts.some((p) => mixedLong(p) && !wordsLike(p))) return true;
  // One case, but letters and digits mixed through a long part: `wjalrxutnfemi/k7mdeng/bpxrficyexamplekey`.
  if (/[/+]/.test(run) && parts.some((p) => p.length >= 6 && /[a-z][0-9]|[0-9][a-z]/i.test(p) && !wordsLike(p)) && (run.match(/[0-9]/g) ?? []).length >= 1 && parts.join('').length >= 24) return true;
  if (!/[0-9]/.test(run)) return false;
  return parts.some((p) => (p.match(/[A-Z]/g) ?? []).length >= 2 && !wordsLike(p));
}

/**
 * `s` with anything that looks secret taken out: known token shapes, credentials in URLs, Authorization and cookie
 * headers, values of `NAME=value` assignments, values of secret-named flags and query parameters, and long token-like
 * runs. A label is made from words a body chose, so this runs on every one of them, last.
 */
export function redact(s) {
  let t = cutInput(s);
  for (const re of SHAPES) t = t.replace(re, GONE);
  // A URL's user and password: scheme://user:pass@host → scheme://…@host.
  t = t.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${GONE}@`);
  // Headers that carry a credential, quoted or not: their whole value.
  t = t.replace(/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|private-token|cookie|set-cookie)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^'"\n]+)/gi, `$1$2${GONE}`);
  t = t.replace(/\b(Bearer|Basic|Token)\s{1,500}[A-Za-z0-9._~+/=-]{8,500}/gi, `$1 ${GONE}`);
  // `password: hunter2`, `api_key: "x"`: a secret-named key and its value.
  // ... and `password = x`, `"token" => "x"`: the same with = or => and spaces.
  t = t.replace(new RegExp(`\\b(${SECRET_NAME})(["']?\\s{0,500}(?:=>|=|:)\\s{0,500})(?:"[^"]{0,500}"|'[^']{0,500}'|[^\\s,;'"]{1,500})`, 'gi'), `$1$2${GONE}`);
  // A netrc line or prose: `password S3cret`, `token abc123` — the word after, when it has a digit or a sign in it, or
  // is 12 or longer (a plain word like "for" stays).
  t = t.replace(/\b(password|passwd|passphrase|secret|token|apikey|api_key|pass)(\s{1,500})(?![:=])([^\s'"]{1,500})/gi, (m, k, sp, v) => (v === GONE || (!/[0-9\W_]/.test(v) && v.length < 12) ? m : `${k}${sp}${GONE}`));
  // A password given to -p: `mysql -pS3cret`, `sshpass -p S3cret`.
  t = t.replace(/(\s-p)([^\s'"-][^\s'"]{2,500})/g, `$1${GONE}`);
  t = t.replace(/(\bsshpass(?:\s{1,50}-[A-Za-z]{1,5}){0,5}\s{1,50}-p)\s{1,50}\S{1,500}/g, `$1 ${GONE}`);
  // A UUID, and hex split by dashes: a Heroku-style key or a token in parts. When unsure, it goes.
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, GONE);
  t = t.replace(/\b[0-9a-f]{6,64}(?:-[0-9a-f]{4,64}){2,8}\b/gi, (m) => (/[0-9]/.test(m) && /[a-f]/i.test(m) ? GONE : m));
  // Query parameters named like a secret.
  t = t.replace(new RegExp(`([?&;#]${SECRET_NAME}=)[^&\\s"'#]+`, 'gi'), `$1${GONE}`);
  // Assignments: FOO=bar, --flag=value, key="a b". The name stays; the value goes.
  t = t.replace(/(^|[\s;&|('"`{,?#])((?:--?)?[A-Za-z_][A-Za-z0-9_.-]*)=(?:"[^"]*"|'[^']*'|[^\s;&|)'"`]+)/g, `$1$2=${GONE}`);
  // A secret-named flag's separate value: --token abc, -H is handled above as a header.
  t = t.replace(new RegExp(`((?:^|\\s)--?${SECRET_NAME})\\s{1,500}(?:"[^"]{0,500}"|'[^']{0,500}'|[^\\s"']{1,500})`, 'gi'), `$1 ${GONE}`);
  // curl -u user:pass.
  t = t.replace(/(\s(?:-u|--user))\s+(?:"[^"]*"|'[^']*'|\S+)/g, `$1 ${GONE}`);
  // Whatever's left that looks like a token: a long mixed run, or base64 (with `/` and `+`) in both cases and digits;
  // an AWS secret key, `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, is runs of 13, 7 and 18 between its slashes.
  t = t.replace(/[A-Za-z0-9_+=.-]{20,}/g, (run) => (tokenLike(run) ? GONE : run));
  // A path in CamelCase is words between slashes; base64 is both cases inside its parts, and digits, or 40 long.
  t = t.replace(/[A-Za-z0-9+/=]{30,}/g, (run) => (base64Like(run) ? GONE : run));
  return t;
}

// ─── A shell command's short form ──────────────────────────────────────────────

/** Words that run what follows them (and the options they take before it). */
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'ionice', 'timeout', 'time', 'command', 'exec', 'nohup', 'stdbuf', 'flock', 'xargs', 'watch', 'unbuffer', 'chronic']);
/** Steps that don't say what a command is for: moving about, setting things. */
const QUIET = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', ':', 'shopt', 'umask', 'trap', 'local', 'declare', 'eval', 'mkdir', 'sleep', 'echo', 'printf', 'exit', 'wait']);
/**
 * The subcommands a label may name, per program: one (`git push`) or a fixed pair (`gh pr checks`). Anything else a
 * command line holds after the program shows only if it's an id (the gate's `id` kind), and only right after the
 * subcommand. (`gh-art` and `gh-jbarket` are Art's gh wrappers.)
 */
const GH = ['pr checks', 'pr view', 'pr create', 'pr merge', 'pr list', 'pr diff', 'pr edit', 'pr comment', 'pr review', 'pr close', 'pr checkout', 'issue view', 'issue list', 'issue create', 'issue comment', 'issue close', 'run view', 'run list', 'run watch', 'run rerun', 'repo view', 'repo clone', 'release view', 'release list', 'api', 'search', 'workflow run', 'workflow list'];
const SUBS = {
  git: ['status', 'diff', 'log', 'show', 'add', 'commit', 'push', 'pull', 'fetch', 'switch', 'checkout', 'branch', 'merge', 'rebase', 'worktree', 'stash', 'restore', 'reset', 'clone', 'tag', 'remote', 'cherry-pick', 'blame', 'rev-parse', 'ls-files', 'init', 'mv', 'rm', 'revert', 'apply', 'am', 'bisect', 'clean', 'config'],
  gh: GH, 'gh-art': GH, 'gh-jbarket': GH,
  npm: ['test', 'ci', 'install', 'i', 'run build', 'run test', 'run lint', 'run typecheck', 'run check', 'run dev', 'run start', 'run format', 'ls', 'outdated', 'audit', 'pack', 'version', 'exec', 'run'],
  pnpm: ['test', 'install', 'i', 'build', 'run build', 'run test', 'run lint', 'run'], yarn: ['test', 'install', 'build', 'run build', 'run test', 'lint'],
  npx: ['vitest', 'tsc', 'eslint', 'prettier', 'playwright', 'jest', 'tsx', 'vite'], bun: ['test', 'install', 'run'],
  cargo: ['build', 'test', 'run', 'check', 'clippy', 'fmt'], go: ['build', 'test', 'run', 'vet', 'mod'],
  docker: ['ps', 'images', 'build', 'run', 'exec', 'logs', 'pull', 'inspect', 'compose'], podman: ['ps', 'images', 'build', 'run', 'exec', 'logs', 'pull', 'inspect', 'rmi', 'system'],
  systemctl: ['status', 'start', 'stop', 'restart', 'reload', 'list-timers', 'list-units', 'is-active', 'is-enabled', 'daemon-reload', 'cat', 'show'],
  kubectl: ['get', 'describe', 'logs', 'apply', 'rollout'], pip: ['install', 'list', 'show'], pip3: ['install', 'list', 'show'], uv: ['run', 'sync', 'pip', 'add'],
  make: ['test', 'build', 'check', 'lint', 'all', 'install', 'clean'],
  loom: ['runtime trace', 'runtime status', 'pieces update', 'pieces list', 'note read', 'note list', 'note write', 'note attach', 'tasks show', 'status', 'doctor', 'logs'],
  'loom-runtime': ['trace', 'status', 'send', 'body-host'],
  taskstore: ['show', 'create', 'claim', 'unclaim', 'close', 'reopen', 'comment', 'link', 'unlink', 'update', 'list', 'ready', 'report'],
  approvals: ['rule', 'request', 'tell', 'use', 'list'], wake: ['in', 'park', 'list'],
  vitest: ['run'], codex: ['exec'],
};

/** `s` without a shell wrapper: `/bin/bash -lc "…"` (Codex runs every command so) → what's inside. */
function unwrap(s) {
  const m = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(s);
  if (!m) return s;
  return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2].replace(/'\\''/g, "'");
}

/** A command's lines without heredoc bodies (they're data: a script, a file's contents). */
function dropHeredocs(s) {
  const out = [];
  const queue = []; // the delimiters of the heredocs a line opened, in order: their bodies follow it one after another
  for (const line of s.split('\n')) {
    if (queue.length) { if (line.trim() === queue[0]) queue.shift(); continue; }
    out.push(line);
    // <<EOF, <<-EOF, <<'EOF', <<"EOF", <<\EOF, delimiters like EOF-1; every one on the line, a here-string (<<<) not.
    for (const m of line.matchAll(/(<{2,})-?\s*(?:\\|(['"]))?([A-Za-z0-9_.-]+)\2?/g)) if (m[1].length === 2) queue.push(m[3]);
  }
  return out.join('\n');
}

/**
 * A command line's simple commands, each a list of words (quotes taken off), split at `&&`, `||`, `;`, `|`, `&` and
 * line breaks; `pipe` marks one fed by a pipe. Redirections and `$(…)` are left out.
 */
export function commands(line) {
  const cmds = [];
  let cur = [], w = '', has = false, q = null, pipe = false;
  const word = () => { if (has) cur.push(w); w = ''; has = false; };
  const end = (nextPipe) => { word(); if (cur.length) cmds.push({ words: cur, pipe }); cur = []; pipe = nextPipe; };
  const s = dropHeredocs(unwrap(line));
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) w += s[++i]; else w += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { if (s[i + 1] !== '\n') { w += s[i + 1]; has = true; } i++; continue; }
    if (c === '#' && !has) { while (i < s.length && s[i] !== '\n') i++; i--; continue; }
    if (c === '\n' || c === ';') { end(false); continue; }
    if (c === '&') { if (s[i + 1] === '&') i++; else if (s[i - 1] === '>' || s[i + 1] === '>') { w += c; has = true; continue; } end(false); continue; }
    if (c === '|') { if (s[i + 1] === '|') { i++; end(false); } else end(true); continue; }
    if (c === '$' && s[i + 1] === '(') { // $(…): skip it whole
      let depth = 0;
      for (; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) break; }
      w += GONE; has = true; continue;
    }
    if (c === ' ' || c === '\t') { word(); continue; }
    w += c; has = true;
  }
  end(false);
  // Redirections: `2>&1`, `> out`, `<in`, `>>log`.
  return cmds.map((c) => {
    const out = [];
    for (let i = 0; i < c.words.length; i++) {
      const x = c.words[i];
      if (/^\d*(?:>>?|<<?<?|&>)$/.test(x)) { i++; continue; }
      if (/^\d*(?:>>?|<|&>)/.test(x)) continue;
      out.push(x);
    }
    return { words: out, pipe: c.pipe };
  }).filter((c) => c.words.length);
}

const base = (p) => String(p).split('/').filter(Boolean).pop() ?? p;

/** What a private file shows as: its name says nothing of what's in it, or whose. */
export const PRIVATE_FILE = 'a private file';

/**
 * A file under ~/.config (any home's), an env file (`.env`, `.env.local`, `.envrc`, `.env-prod`, `prod.env`), a key or
 * token (`*.token`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa`…), or a credentials file (`.netrc`, `.pgpass`,
 * `credentials`). Its name shows as PRIVATE_FILE.
 */
export function privateFile(p) {
  const s = String(p ?? '').replace(/^["'`(<]+|["'`)>,;:]+$/g, '');
  const b = base(s);
  return /(?:^|\/)\.config(?:\/|$)/.test(s) || /^\.env/.test(b) || /\.env$/.test(b) || /\.(?:token|key|pem|p12|pfx|keystore|jks)$/i.test(b)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(b) || /^(?:\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|\.npmrc|\.pypirc)$/.test(b);
}

/**
 * A file as a label shows it: its base name, never the folders above it (no home, no ~/.config), and a private file
 * (privateFile) as PRIVATE_FILE.
 */
export function fileName(p) {
  const s = String(p ?? '');
  if (!s) return 'a file';
  if (s.length > INPUT_MAX) return GONE;
  if (privateFile(s)) return PRIVATE_FILE;
  // The whole path is checked before its base name is taken: a secret with a / in it would otherwise show its last part.
  if (redact(s) !== s) return GONE;
  return part('file', base(s));
}

// ─── The gate: every variable part of a label passes here ──────────────────────

/**
 * Characters a label never holds: C0 and C1 controls (U+0085 is a line break to some), line and paragraph separators,
 * zero-width and filler characters, bidi controls (U+061C, U+200E/F, U+202A–E, U+2066–9), invisible format and tag
 * characters (U+206A–F, U+E0000–FF), variation selectors, the soft hyphen, the byte-order mark, specials (U+FFF0–B)
 * and a lone surrogate. `UNPRINTABLE_ONE` is the same, unflagged, for a test (`.test` on a /g regex keeps state between calls).
 */
export const UNPRINTABLE = /(?:[\x00-\x1f\x7f-\x9f\xad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|\udb40[\udc00-\udcff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])+/g;
export const UNPRINTABLE_ONE = new RegExp(UNPRINTABLE.source);

/** Each kind of part: its longest, and the characters it may hold. A `text` part is any printable words. */
const KINDS = {
  file: [60, /^[A-Za-z0-9._+@#,=() -]+$/], // a base name
  host: [80, /^[A-Za-z0-9.-]+$/],
  id: [12, /^(?:#?\d{1,9}|t-\d{1,9})$/],
  count: [9, /^\d{1,9}$/],
  word: [48, /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,47}$/], // a subcommand, a skill: no path in it
  who: [40, /^[A-Za-z0-9_.@:-]+$/], // a message's recipient
  text: [120, null], // a pattern, a query, a message's first line, a description, a plan's item
};

/**
 * `s` cut to `n` UTF-16 units (what core counts, `.length`), never between a surrogate pair, with … when cut. Exported
 * for activity.mjs `clean`.
 */
export function cutTo(s, n) {
  const max = Math.max(1, n);
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) { if (out.length + ch.length > max - 1) break; out += ch; }
  return `${out}…`;
}

/** Any word of `s` that names a private file (privateFile) shows as PRIVATE_FILE: in a description, a pattern. */
const privateWords = (s) => s.split(/(\s+)/).map((w) => (/[/.]/.test(w) && privateFile(w) ? PRIVATE_FILE : w)).join('');

/**
 * The one gate (t-1944): a variable part of a label, as it may be shown, or GONE. It's redacted; on one printable line;
 * then a part of a fixed shape (file, host, id, count, word, who) must still be itself after redaction and fit its
 * kind's length and characters, and a `text` part is cut to `n` (its kind's longest at most). Whatever fails is GONE:
 * a "…" label is better than a leaked key.
 */
export function part(kind, v, n) {
  const [max, re] = KINDS[kind] ?? KINDS.text;
  const s = cutInput(v).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return GONE;
  const r = redact(s);
  if (!re) return cutTo(privateWords(r), Math.min(n ?? max, max));
  return r === s && s.length <= max && re.test(s) && !privateFile(s) ? s : GONE;
}

/**
 * Programs a label may name by themselves (`Ran rg`): only these, from this list, and the SUBS keys. A word on neither
 * list says nothing, so a body word read as a program (a heredoc's, a quoted script's) never shows.
 */
const PLAIN = new Set(['cat', 'head', 'tail', 'less', 'sed', 'awk', 'jq', 'yq', 'rg', 'grep', 'egrep', 'find', 'fd', 'ls', 'tree', 'wc',
  'diff', 'curl', 'wget', 'node', 'python', 'python3', 'bash', 'sh', 'zsh', 'deno', 'tsx', 'perl', 'ruby', 'cp', 'mv', 'rm', 'ln',
  'chmod', 'touch', 'sort', 'uniq', 'cut', 'tr', 'tar', 'unzip', 'zip', 'gzip', 'ps', 'kill', 'pkill', 'df', 'du', 'free', 'date',
  'which', 'whoami', 'hostname', 'uname', 'ssh', 'scp', 'rsync', 'sqlite3', 'psql', 'mysql', 'openssl', 'journalctl', 'tsc',
  'jest', 'pytest', 'eslint', 'prettier', 'deploy-loom', 'claude', 'stat', 'file', 'realpath', 'readlink', 'basename',
  'dirname', 'tee', 'test', 'xxd', 'sha256sum', 'md5sum', 'pgrep', 'lsof', 'ss', 'ping', 'dig', 'nslookup', 'htop', 'top',
  'patch', 'gunzip', 'unxz', 'nproc', 'id', 'groups', 'env', 'printenv', 'crontab', 'at', 'mise', 'just', 'tmux', 'brew',
  'apt', 'apt-get', 'dnf', 'yum', 'rclone', 'restic', 'ffmpeg', 'convert', 'pandoc', 'sqlite']);

/** The program a command runs, past env assignments and wrappers (with their options); null when it isn't plain. */
function program(ws) {
  let i = 0;
  while (i < ws.length) {
    const x = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) { i++; continue; }
    const b = base(x);
    if (WRAPPERS.has(b)) {
      i++;
      // Their options, and the ones that take a value: nice -n 19, timeout 30 / -s KILL 30, flock /tmp/x.lock.
      while (i < ws.length && (ws[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || (b === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(ws[i])) || (b === 'flock' && /\//.test(ws[i])))) {
        if (/^-[A-Za-z]$/.test(ws[i]) && i + 1 < ws.length && !/^-/.test(ws[i + 1])) i++;
        i++;
      }
      continue;
    }
    break;
  }
  return { prog: i < ws.length ? base(ws[i]) : null, args: ws.slice(i + 1) };
}

/**
 * One simple command's short form (t-1944, closed vocabulary): `Ran <program>` for a program on PLAIN or SUBS, and for
 * one on SUBS its subcommand from the program's list and one id after it (a number, #12, t-1929). Nothing else of the
 * line shows: no file, no pattern, no host, no value. null for a program on neither list (and cd, export…).
 */
function shortForm(ws) {
  const { prog, args } = program(ws);
  if (!prog || QUIET.has(prog)) return null;
  if (!Object.hasOwn(SUBS, prog)) return PLAIN.has(prog) ? `Ran ${prog}` : null;
  let a = args;
  // git -C <dir> / -c k=v, npm --prefix <dir>: options before the subcommand, with their values.
  if (prog === 'git') { const r = []; for (let i = 0; i < a.length; i++) { if (a[i] === '-C' || a[i] === '-c') { i++; continue; } r.push(a[i]); } a = r; }
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn') { const r = []; for (let i = 0; i < a.length; i++) { if (a[i] === '--prefix' || a[i] === '-C' || a[i] === '--dir') { i++; continue; } r.push(a[i]); } a = r; }
  const pos = a.filter((x) => !x.startsWith('-'));
  const allowed = SUBS[prog];
  const two = pos.length >= 2 ? `${pos[0]} ${pos[1]}` : null;
  const sub = two && allowed.includes(two) ? two : pos.length && allowed.includes(pos[0]) ? pos[0] : null;
  if (!sub) return `Ran ${prog}`;
  const next = pos[sub.split(' ').length];
  const id = next ? part('id', next) : GONE;
  return `Ran ${prog} ${sub}${id !== GONE ? ` ${id}` : ''}`;
}

/**
 * A command line's label: the short form of each command that names a known program (cd, export and the like don't,
 * and a pipe's later stages are filters), at most three. `null` when none does. A command given as a list (argv) is
 * named by its first element only.
 */
export function commandLabel(line) {
  if (Array.isArray(line)) {
    const p = typeof line[0] === 'string' ? base(line[0]) : null;
    return p && (PLAIN.has(p) || Object.hasOwn(SUBS, p)) && !QUIET.has(p) ? `Ran ${p}` : null;
  }
  const s = cutInput(line);
  let cmds;
  try { cmds = commands(s); } catch { return null; }
  const forms = [];
  for (const c of cmds) {
    if (c.pipe) continue;
    const f = shortForm(c.words);
    if (f && !forms.includes(f)) forms.push(f);
  }
  if (!forms.length) return null;
  // After the first, the "Ran" goes: `Ran git add, git commit, git push`.
  const shown = forms.slice(0, 3).map((f, i) => (i === 0 ? f : f.replace(/^Ran /, '')));
  return redact(`${shown.join(', ')}${forms.length > 3 ? ` and ${forms.length - 3} more` : ''}`);
}

// ─── Why a step failed ─────────────────────────────────────────────────────────

/** Fixed phrases a failure's output can earn; the output itself is never shown, only these and a count. */
const WHY = [
  [/^[#\u2139] fail (\d{1,6})\s*$/m, (m) => (m[1] !== '0' ? `${m[1]} test${m[1] === '1' ? '' : 's'} failed` : null)],
  [/\bTests?:\s{1,10}(\d{1,6}) failed/, (m) => `${m[1]} test${m[1] === '1' ? '' : 's'} failed`],
  [/\b(\d{1,6}) (?:tests? )?(?:failed|failing)\b/, (m) => (m[1] !== '0' ? `${m[1]} test${m[1] === '1' ? '' : 's'} failed` : null)],
  [/\berror TS\d+/, () => 'type errors'],
  [/command not found/, () => 'command not found'],
  [/No such file or directory|ENOENT|File does not exist/, () => 'no such file'],
  [/File has not been read yet/, () => 'file not read first'],
  [/String to replace not found|old_string.{0,200}not found/i, () => 'text to replace not found'],
  [/Permission denied|EACCES|permission to use|requires approval|doesn't want to proceed|was rejected|Hook .* denied|blocked by/i, () => 'not allowed'],
  [/timed out|ETIMEDOUT|Timeout of \d+/i, () => 'timed out'],
  [/\bCONFLICT\b|merge conflict/, () => 'merge conflict'],
  [/non-fast-forward|\[rejected\]/, () => 'push rejected'],
  [/Could not resolve host|ECONNREFUSED|ENOTFOUND|Connection refused|network is unreachable/i, () => 'network error'],
  [/HTTP 404|404 Not Found|Not Found \(HTTP 404\)/, () => 'not found (404)'],
  [/HTTP 40[13]|401 Unauthorized|403 Forbidden|Bad credentials/, () => 'not authorized'],
  [/npm ERR!|npm error/, () => 'npm error'],
  [/SyntaxError/, () => 'syntax error'],
  [/Traceback \(most recent call last\)/, () => 'Python error'],
];

/** `exit 1: 3 tests failed`, `exit 127: command not found`, `no such file`, or null. */
export function failWhy({ exit, output } = {}) {
  const tail = String(output ?? '').slice(-INPUT_MAX);
  let why = null;
  for (const [re, f] of WHY) { const m = re.exec(tail); if (m) { why = f(m); if (why) break; } }
  const code = Number.isInteger(exit) && exit !== 0 && Math.abs(exit) < 1e6 ? `exit ${exit}` : null;
  return [code, why].filter(Boolean).join(': ') || null;
}
