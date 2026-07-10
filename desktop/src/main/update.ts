import { app, dialog, shell, type BrowserWindow } from "electron"
import { spawn, spawnSync } from "node:child_process"
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Update checks, both distribution flavors (default OFF, Settings → General):
 *
 * - Packaged (installed/portable exe): compare the app's version against the
 *   latest GitHub release tag. Tags look like `vX.X.X(y)(-description)` —
 *   e.g. v1.1.2, v1.1.2b, v1.1.2b-tray-hotfix. package.json can't hold
 *   "1.1.2b", so the letter lives in an optional `"hotfix"` field there and
 *   release tags are parsed with the same rule (numbers compared numerically,
 *   then suffix letter: none < a < b < …; the -description is ignored).
 *   When a newer release exists, a dialog offers the releases page.
 *
 * - Dev (`npm run dev` inside the repo): spawn script/dev-updater.py — a tiny
 *   stdlib-only Python GUI (tkinter, console fallback) that checks how far
 *   HEAD is behind origin, and on confirmation closes Aria, `git pull`s, and
 *   relaunches `npm run dev`.
 */

const REPO = "gabrieljamh/Aria-Chat"

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Hotfix letter suffix; "" sorts before "a". */
  suffix: string
}

const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)([a-z])?(?:-.*)?$/i

export function parseVersionTag(tag: string): ParsedVersion | null {
  const m = TAG_RE.exec(tag.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), suffix: (m[4] ?? "").toLowerCase() }
}

/** > 0 when a is newer than b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // "" < "a" < "b" — a missing letter is the base release of that version.
  return a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0
}

/** The running build's version: package.json `version` + optional `hotfix` letter. */
export function currentVersion(): ParsedVersion | null {
  let hotfix = ""
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))
    if (typeof pkg.hotfix === "string") hotfix = pkg.hotfix.toLowerCase()
  } catch {
    /* no readable package.json — version alone still works */
  }
  const base = parseVersionTag(app.getVersion())
  if (!base) return null
  return { ...base, suffix: hotfix || base.suffix }
}

const fmt = (v: ParsedVersion) => `${v.major}.${v.minor}.${v.patch}${v.suffix}`

/**
 * Packaged-mode check. Returns a status string the Settings page can show.
 * `interactive` also reports "up to date" / errors via dialog.
 */
export async function checkReleaseUpdate(win: BrowserWindow | null, interactive: boolean): Promise<string> {
  const current = currentVersion()
  if (!current) return "error: cannot parse app version"
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "aria-desktop-update-check" },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const release = (await res.json()) as {
      tag_name?: string
      html_url?: string
      name?: string
      assets?: ReleaseAsset[]
    }
    const latest = release.tag_name ? parseVersionTag(release.tag_name) : null
    if (!latest) throw new Error(`unrecognized release tag: ${release.tag_name}`)

    if (compareVersions(latest, current) > 0) {
      const asset = findPortableAsset(release.assets ?? [])
      const buttons = asset ? ["Download & install", "Open releases page", "Later"] : ["Open releases page", "Later"]
      const { response } = await dialog.showMessageBox(win!, {
        type: "info",
        title: "Update available",
        message: `Aria ${fmt(latest)} is available (you have ${fmt(current)}).`,
        detail:
          (release.name ? `Latest release: ${release.name}\n` : "") +
          (asset ? `Installing replaces the app files in place and restarts Aria. Your chats and settings are kept.` : ""),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      })
      const pageUrl = release.html_url ?? `https://github.com/${REPO}/releases/latest`
      if (asset && response === 0) {
        return downloadAndInstall(win, asset)
      }
      if ((asset && response === 1) || (!asset && response === 0)) {
        void shell.openExternal(pageUrl)
      }
      return `update available: ${fmt(latest)}`
    }
    if (interactive) {
      await dialog.showMessageBox(win!, {
        type: "info",
        title: "Up to date",
        message: `Aria ${fmt(current)} is the latest release.`,
        buttons: ["OK"],
      })
    }
    return "up to date"
  } catch (err) {
    const msg = `update check failed: ${String((err as Error)?.message ?? err)}`
    console.warn("[update]", msg)
    if (interactive) {
      await dialog.showMessageBox(win!, { type: "warning", title: "Update check failed", message: msg, buttons: ["OK"] })
    }
    return msg
  }
}

/* ------------------------- portable self-update ------------------------- */

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

/**
 * Pick the release asset matching this build, per pack-portable naming:
 *   aria-chat-portable-win32-<arch>[suffix].zip
 *   aria-chat-portable-darwin-<arch>.zip
 *   aria-chat-portable-linux-<arch>.tar.gz
 */
function findPortableAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const prefix = `aria-chat-portable-${process.platform}-${process.arch}`
  return assets.find((a) => a.name.toLowerCase().startsWith(prefix.toLowerCase())) ?? null
}

/**
 * Download the archive (taskbar progress on the main window), drop a
 * platform-native helper script in temp, then quit. The helper waits for this
 * process to exit, extracts the archive over the install folder, and
 * relaunches the app. PowerShell / sh are used instead of Python because end
 * users of the portable build can't be assumed to have Python installed.
 */
async function downloadAndInstall(win: BrowserWindow | null, asset: ReleaseAsset): Promise<string> {
  const tmp = app.getPath("temp")
  const archive = join(tmp, asset.name)
  try {
    const res = await fetch(asset.browser_download_url, {
      headers: { "user-agent": "aria-desktop-update" },
      signal: AbortSignal.timeout(30 * 60_000),
    })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get("content-length")) || asset.size || 0
    const out = createWriteStream(archive)
    const reader = res.body.getReader()
    let received = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (total > 0 && win && !win.isDestroyed()) win.setProgressBar(received / total)
      await new Promise<void>((resolve, reject) => out.write(value, (e) => (e ? reject(e) : resolve())))
    }
    await new Promise<void>((resolve, reject) => out.end((e: unknown) => (e ? reject(e) : resolve())))
  } catch (err) {
    if (win && !win.isDestroyed()) win.setProgressBar(-1)
    const msg = `update download failed: ${String((err as Error)?.message ?? err)}`
    console.error("[update]", msg)
    if (win) await dialog.showMessageBox(win, { type: "error", title: "Update failed", message: msg, buttons: ["OK"] })
    return msg
  }
  if (win && !win.isDestroyed()) win.setProgressBar(-1)

  const installDir = dirname(process.execPath)
  const helper = writeSwapHelper(tmp, archive, installDir, process.execPath, process.pid)

  if (win) {
    await dialog.showMessageBox(win, {
      type: "info",
      title: "Ready to install",
      message: "Update downloaded. Aria will close, install the update and restart.",
      buttons: ["Install now"],
    })
  }
  if (process.platform === "win32") {
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref()
  } else {
    spawn("sh", [helper], { detached: true, stdio: "ignore" }).unref()
  }
  app.quit()
  return "installing update"
}

/** Generate the wait-extract-relaunch script; returns its path. */
function writeSwapHelper(tmp: string, archive: string, installDir: string, exe: string, pid: number): string {
  if (process.platform === "win32") {
    const file = join(tmp, "aria-update-helper.ps1")
    // robocopy overlays new files over the install dir without purging
    // anything the archive doesn't contain. Both $stage and $installDir are
    // quoted because TEMP and the install path commonly contain spaces
    // (e.g. "C:\Users\John Doe\AppData\Local\Programs\Aria Chat"). An earlier
    // build left $stage unquoted and robocopy silently mis-parsed it as two
    // arguments when the username had a space, so the update failed silently
    // after the user confirmed the close-to-unzip prompt.
    //
    // If the install dir is under Program Files (or anywhere the current user
    // lacks write perms), the first robocopy attempt fails with access-denied.
    // We detect that and re-launch the helper elevated via Start-Process -Verb
    // RunAs so the user gets a UAC prompt and the update completes.
    // Pre-escape the file path for the Start-Process -ArgumentList inside the
    // elevated re-launch (PowerShell needs the embedded quotes doubled as `").
    // Done outside the script body so the JS template literal doesn't have to
    // embed a backtick (which would close the JS string prematurely).
    const fileEscapedForPsArg = file.replace(/"/g, '`"')
    writeFileSync(
      file,
      [
        `$ErrorActionPreference = "Stop"`,
        `try {`,
        `  while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }`,
        `  Start-Sleep -Seconds 1`,
        `  $stage = Join-Path $env:TEMP "aria-update-stage"`,
        `  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }`,
        `  Expand-Archive -LiteralPath "${archive}" -DestinationPath $stage -Force`,
        `  robocopy "$stage" "${installDir}" /E /R:3 /W:1 | Out-Null`,
        `  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }`,
        `  Start-Process -FilePath "${exe}"`,
        `  Remove-Item "${archive}" -Force -ErrorAction SilentlyContinue`,
        `  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue`,
        `} catch {`,
        `  Add-Type -AssemblyName PresentationFramework`,
        `  $msg = $_.Exception.Message`,
        `  # Permission/access-denied: retry elevated via UAC — but only ONCE.`,
        `  # The elevated re-launch sets ARIA_UPDATE_ELEVATED so we don't loop if`,
        `  # even admin can't write the install dir (corrupted install, antivirus, etc).`,
        `  $alreadyElevated = [bool]$env:ARIA_UPDATE_ELEVATED`,
        `  $needElevate = -not $alreadyElevated -and (($msg -match "Access is denied|permission|denied|Unauthorized") -or ($LASTEXITCODE -eq 5))`,
        `  if ($needElevate) {`,
        `    try {`,
        `      $env:ARIA_UPDATE_ELEVATED = "1"`,
        `      Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","${fileEscapedForPsArg}")`,
        `      exit 0`,
        `    } catch {`,
        `      [System.Windows.MessageBox]::Show("Aria update needs elevated permissions but the UAC prompt was dismissed.\`n\`nError: $msg\`n\`nThe downloaded archive is at:\`n${archive}\`n\`nYou can extract it over the install folder manually as administrator.", "Aria updater") | Out-Null`,
        `      exit 1`,
        `    }`,
        `  }`,
        `  [System.Windows.MessageBox]::Show("Aria update failed: $msg\`n\`nThe downloaded archive is at:\`n${archive}\`n\`nYou can extract it over the install folder manually.", "Aria updater") | Out-Null`,
        `}`,
        "",
      ].join("\r\n"),
    )
    return file
  }
  const file = join(tmp, "aria-update-helper.sh")
  const extract = archive.endsWith(".tar.gz")
    ? `tar -xzf "${archive}" -C "${installDir}"`
    : `unzip -o -q "${archive}" -d "${installDir}"`
  writeFileSync(
    file,
    [
      `#!/bin/sh`,
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done`,
      `sleep 1`,
      extract + ` || { echo "Aria update failed; archive kept at ${archive}" >&2; exit 1; }`,
      `chmod +x "${exe}" 2>/dev/null || true`,
      `rm -f "${archive}"`,
      `nohup "${exe}" >/dev/null 2>&1 &`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return file
}

/** Walk up from cwd looking for the repo root (same heuristic as server.ts). */
function findRepoRoot(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "opencode", "src", "index.ts"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function findPython(): string | null {
  for (const cmd of ["python3", "python", "py"]) {
    try {
      const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", windowsHide: true })
      if (probe.status === 0) return cmd
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Dev-mode check: hand off to the Python updater. It exits silently when up
 * to date (unless `interactive`), otherwise shows its GUI and — on confirm —
 * kills this process, pulls, and relaunches `npm run dev`.
 */
export function spawnDevUpdater(interactive: boolean): string {
  const repoRoot = findRepoRoot()
  if (!repoRoot) return "error: repo root not found"
  const script = join(repoRoot, "desktop", "script", "dev-updater.py")
  if (!existsSync(script)) return "error: dev-updater.py missing"
  const py = findPython()
  if (!py) return "error: python not found on PATH"
  const args = [script, "--repo", repoRoot, "--pid", String(process.pid), "--desktop", join(repoRoot, "desktop")]
  if (interactive) args.push("--interactive")
  spawn(py, args, { cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: false }).unref()
  return "updater launched — dialog appears once git fetch finishes (can take a moment)"
}
