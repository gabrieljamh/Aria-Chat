/**
 * Deterministic, AI-free blocklist for catastrophic ("PC-extinction") operations.
 *
 * WHY THIS EXISTS
 * ---------------
 * A model (any model — this is provider-agnostic) can emit a destructive command
 * either directly (a `bash` call) or, more insidiously, *embedded inside a file it
 * writes* — e.g. `os.system("rm -rf ~/")` buried in an otherwise-benign Python
 * script. The script is written by `write`/`edit`, then later run by `bash python
 * calc.py`, at which point the bash command is only "python calc.py" and a
 * command-only filter never sees the payload. So the guard runs at BOTH the
 * command boundary (bash) AND the file-content boundary (write/edit).
 *
 * WHY A BLOCKLIST AND NOT A CLASSIFIER
 * ------------------------------------
 * Probabilistic / model-based safety scoring can be defeated by dilution: bury one
 * lethal line in 95% benign code and the aggregate risk score stays low, so the
 * response streams through. A deterministic substring/pattern match cannot be
 * diluted — either the lethal pattern is present or it is not. This is a hard
 * backstop, intentionally independent of the permission system: it fires even when
 * a directory is "allowed", because "allowed to touch this folder" is not the same
 * as "allowed to wipe the filesystem root".
 *
 * SCOPE (deliberately narrow to keep false positives at ~zero)
 * ------------------------------------------------------------
 * Only genuinely irreversible, whole-machine-destroying operations are blocked:
 * recursive-force deletion of the filesystem root / a bare top-level system dir /
 * the entire home dir; disk-wiping (dd/mkfs/shred/wipefs/redirect to a raw block
 * device); fork bombs; and the Windows equivalents (format a drive, del/rd a drive
 * root, Remove-Item -Recurse -Force on a drive root). Targeted deletes like
 * `rm -rf node_modules`, `rm -rf ./build`, `rm -rf ~/.cache`, or `rm -rf
 * /home/me/project/dist` are NOT blocked — they are normal, reversible-ish work.
 *
 * LIMITATIONS (be honest about them)
 * ----------------------------------
 * A static blocklist does not defeat heavy obfuscation (base64-piped-to-sh,
 * variable indirection that assembles the string at runtime, non-ASCII homoglyphs).
 * It catches the plain-text lethal forms — which is exactly the class that slips
 * past a diluted risk score. Extend RULES below as new plain-text forms surface.
 */

export class DestructiveCommandError extends Error {
  readonly blocked: true = true
  readonly rule: string
  readonly snippet: string
  readonly source: string
  constructor(rule: string, snippet: string, source: string) {
    super(
      `BLOCKED by destructive-operation guard (rule: ${rule}). ` +
        `The ${source} contains an irreversible, whole-machine-destroying pattern and was not executed:\n\n` +
        `    ${snippet.trim()}\n\n` +
        `This is a hard safety backstop that is independent of directory permissions and cannot be worked around by ` +
        `rephrasing — if this operation is genuinely intended, the human operator must run it themselves. ` +
        `If this is a false positive, the blocklist lives in tool/destructive-guard.ts.`,
    )
    this.name = "DestructiveCommandError"
    this.rule = rule
    this.snippet = snippet
    this.source = source
  }
}

// Bare top-level system directories: recursively deleting any ONE of these wipes
// the machine. Deleting something DEEPER (e.g. /usr/local/lib/x) is normal work
// and is NOT matched.
const CRIT_DIRS =
  "bin|boot|dev|etc|lib|lib32|lib64|libx32|opt|proc|root|run|sbin|srv|sys|usr|var|home"

// A boundary that can precede a path argument: start, whitespace, or one of the
// quote/paren/assignment/separator characters that show up when the command is
// embedded in code (e.g. `os.system("rm -rf ~/")` or `["rm","-rf","/"]`).
const B = "(?:^|[\\s\"'`(=,|&;])"
// Characters that legitimately END a bare target (so we don't match a longer path).
const END = "(?=$|[\\s\"'`)*;|&])"

// Matches a catastrophic *target* argument: filesystem root, a bare top-level
// system dir, or the entire home directory. Deeper paths deliberately do not match.
const ROOT_HOME_TARGET = new RegExp(
  B +
    "(?:" +
    // "/" (root), optionally "/*"
    "\\/(?:\\*)?" +
    END +
    // "/etc", "/etc/", "/var", ... (bare top-level system dir only)
    "|\\/(?:" +
    CRIT_DIRS +
    ")\\/?" +
    END +
    // "~", "~/", "$HOME", "${HOME}", "$HOME/" — whole home only, NOT ~/subpath
    "|(?:~|\\$\\{?HOME\\}?)\\/?" +
    END +
    ")",
  "i",
)

// The literal "disarm the safety" flag — no legitimate use in agent-run code.
const NO_PRESERVE_ROOT = /--no-preserve-root/i

// Recursive flag: short cluster containing r/R (-rf, -R, -fr, -rvf) or --recursive.
// The boundary tolerates quotes/commas/parens so the flag is still found when the
// command is embedded in code, e.g. `["rm","-rf","/"]`.
const RECURSIVE_FLAG = /(?:^|[\s"'`(,])-{1,2}[a-z0-9]*r/i
// Force flag: short cluster containing f (-f, -rf, -fr) or --force.
const FORCE_FLAG = /(?:^|[\s"'`(,])-{1,2}[a-z0-9]*f|--force/i

// Real, whole-disk block devices (and their partitions). Loop/null/zero/random are
// intentionally excluded — they are used in legitimate tests and are not the machine.
const DISK_DEVICE =
  "\\/dev\\/(?:sd[a-z]\\d*|nvme\\d+n\\d+(?:p\\d+)?|hd[a-z]\\d*|vd[a-z]\\d*|xvd[a-z]\\d*|mmcblk\\d+(?:p\\d+)?|disk\\d+)(?![a-z])"

type Rule = {
  name: string
  /** Return the matched snippet if the segment is lethal, else undefined. */
  test: (segment: string) => string | undefined
}

// A snippet of context around an index, for the error message.
function snippet(text: string, at: number): string {
  const start = Math.max(0, at - 12)
  const end = Math.min(text.length, at + 96)
  return text.slice(start, end)
}

// rm / chmod / chown are "verb + recursive + (force) + catastrophic target" —
// evaluated in code so the three parts can appear in any order and tolerate the
// quoting/comma noise of an embedded call like `subprocess.run(["rm","-rf","/"])`.
function verbRecursiveTarget(verb: RegExp, requireForce: boolean): Rule["test"] {
  return (segment: string) => {
    const m = verb.exec(segment)
    if (!m) return
    const tail = segment.slice(m.index)
    if (!RECURSIVE_FLAG.test(tail)) return
    if (requireForce && !FORCE_FLAG.test(tail)) return
    if (!ROOT_HOME_TARGET.test(tail)) return
    return snippet(segment, m.index)
  }
}

function regexRule(name: string, re: RegExp): Rule {
  return {
    name,
    test: (segment: string) => {
      const m = re.exec(segment)
      return m ? snippet(segment, m.index) : undefined
    },
  }
}

// SEGMENT rules bind a target to a specific command, so they must be scanned per
// command segment — otherwise `rm file.txt && cd /` would wrongly pair `rm` with a
// far-away `/`. verbRecursiveTarget only looks from the verb to the end of ITS
// segment.
const SEGMENT_RULES: Rule[] = [
  // POSIX: recursive-force delete of root / a bare system dir / the whole home.
  { name: "rm-rf-root", test: verbRecursiveTarget(/\brm\b/i, true) },
  // chmod/chown -R on root/home bricks the OS irrecoverably.
  { name: "chmod-recursive-root", test: verbRecursiveTarget(/\bchmod\b/i, false) },
  { name: "chown-recursive-root", test: verbRecursiveTarget(/\bchown\b/i, false) },
]

// FULL rules are self-anchored (they carry their own boundaries and use [^\n] to
// stay on one line), so they scan the whole normalized text. This is required for
// patterns like the fork bomb whose structure spans the `;` that segment-splitting
// would cut.
const FULL_RULES: Rule[] = [
  // rm with --no-preserve-root is unambiguously an attempt to nuke root.
  regexRule("rm-no-preserve-root", new RegExp("\\brm\\b[^\\n]*" + NO_PRESERVE_ROOT.source, "i")),

  // ----- Disk destruction -----
  regexRule("dd-to-disk", new RegExp("\\bdd\\b[^\\n]*\\bof=" + DISK_DEVICE, "i")),
  regexRule("mkfs-on-disk", new RegExp("\\bmkfs(?:\\.[a-z0-9]+)?\\b[^\\n]*" + DISK_DEVICE, "i")),
  regexRule("shred-disk", new RegExp("\\b(?:shred|wipefs)\\b[^\\n]*" + DISK_DEVICE, "i")),
  regexRule("redirect-to-disk", new RegExp("(?:^|\\s)>\\s*" + DISK_DEVICE, "i")),

  // ----- Fork bomb -----
  regexRule("fork-bomb", /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/),
  regexRule("fork-bomb-generic", /\b[\w.]+\s*\(\s*\)\s*\{[^}]*\|[^}]*\b[\w.]+\s*&[^}]*\}\s*;\s*[\w.]+/),

  // ----- Windows: format / del / rd a drive root -----
  regexRule("win-format-drive", /\bformat\b(?:\s+\/[a-z:?]+)*\s+[a-z]:\s*(?:$|[\s&|])/i),
  regexRule(
    "win-del-drive-root",
    /\bdel\b(?=[^\n]*\s\/s\b)(?=[^\n]*\s\/q\b)[^\n]*\s(?:[a-z]:\\?|%systemdrive%|%systemroot%|%userprofile%)/i,
  ),
  regexRule(
    "win-rd-drive-root",
    /\b(?:rd|rmdir)\b(?=[^\n]*\s\/s\b)[^\n]*\s(?:[a-z]:\\?|%systemdrive%|%systemroot%|%userprofile%)/i,
  ),
  // PowerShell Remove-Item -Recurse -Force on a drive root / home / system dir.
  // The trailing (?![\w.$\\/]) requires the target be a BARE root (e.g. C:\ or
  // $HOME), not a deeper path like C:\Users\me\proj\dist.
  regexRule(
    "win-remove-item-root",
    /\bremove-item\b(?=[^\n]*-recurse)(?=[^\n]*-force)[^\n]*\s(?:[a-z]:\\?|%system(?:root|drive)%|%userprofile%|\$env:system(?:root|drive)|\$env:userprofile|\$home|~|\/)(?![\w.$\\/])/i,
  ),
]

/** Normalize away line-continuation noise so a wrapped command reads as one line. */
function normalize(text: string): string {
  return text.replace(/\\\r?\n/g, " ")
}

/**
 * Split into scan segments: one per line, further split on shell command
 * separators. Keeps an embedded call (`os.system("rm -rf ~/")`) intact on its line
 * while still isolating chained commands (`a && rm -rf / && b`).
 */
function segments(text: string): string[] {
  const out: string[] = []
  for (const line of normalize(text).split(/\r?\n/)) {
    for (const seg of line.split(/&&|\|\||;/)) {
      if (seg.trim()) out.push(seg)
    }
  }
  return out
}

/**
 * Scan arbitrary text (a shell command, or a file's contents) for a catastrophic
 * pattern. Returns the first match, or undefined if clean.
 */
export function scanDestructive(text: string): { rule: string; snippet: string } | undefined {
  if (!text) return
  const full = normalize(text)
  for (const rule of FULL_RULES) {
    const hit = rule.test(full)
    if (hit) return { rule: rule.name, snippet: hit }
  }
  for (const seg of segments(text)) {
    for (const rule of SEGMENT_RULES) {
      const hit = rule.test(seg)
      if (hit) return { rule: rule.name, snippet: hit }
    }
  }
  return
}

/**
 * Throw DestructiveCommandError if `text` contains a catastrophic pattern.
 * `source` labels where it came from (e.g. "bash command", "file content") for
 * the operator-facing message.
 */
export function assertNotDestructive(text: string, source: string): void {
  const hit = scanDestructive(text)
  if (hit) throw new DestructiveCommandError(hit.rule, hit.snippet, source)
}
