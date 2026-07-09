#!/usr/bin/env python3
"""Aria dev-mode updater (spawned by the Electron main process on startup when
"Check for updates" is enabled and the app runs from the repo via `npm run dev`).

Stdlib only. Flow:
  1. `git fetch`, count how far HEAD is behind its upstream.
  2. Up to date -> exit silently (or a small "up to date" note with --interactive).
  3. Behind -> ask via a tiny tkinter dialog (console prompt when tkinter is
     unavailable). On confirm: kill the running Aria, `git pull --ff-only`,
     `npm install` if the desktop lockfile changed, relaunch `npm run dev`.
"""

import argparse
import os
import signal
import subprocess
import sys
import time

def run(args, cwd, timeout=120):
    return subprocess.run(
        args, cwd=cwd, timeout=timeout,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

def git(repo, *args, timeout=120):
    return run(["git", *args], cwd=repo, timeout=timeout)

# ---------------------------------------------------------------- UI helpers

def ask_gui(title, message):
    """Yes/No dialog. Returns True/False, or None if no GUI is available."""
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        return None
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        answer = messagebox.askyesno(title, message, parent=root)
        root.destroy()
        return bool(answer)
    except Exception:
        return None

def info_gui(title, message):
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        print(f"[aria-updater] {title}: {message}")
        return
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        messagebox.showinfo(title, message, parent=root)
        root.destroy()
    except Exception:
        print(f"[aria-updater] {title}: {message}")

def ask(title, message):
    got = ask_gui(title, message)
    if got is not None:
        return got
    try:
        return input(f"{title}\n{message} [y/N] ").strip().lower().startswith("y")
    except Exception:
        return False

# ------------------------------------------------------------- process utils

def kill_pid(pid):
    """Terminate the Aria electron process (electron-vite/npm exit with it)."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    for _ in range(20):  # up to 10s of graceful shutdown
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
        except OSError:
            return
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass

def relaunch(desktop_dir):
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    if sys.platform == "win32":
        # New console window so the dev logs stay visible.
        subprocess.Popen([npm, "run", "dev"], cwd=desktop_dir,
                         creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:
        subprocess.Popen([npm, "run", "dev"], cwd=desktop_dir,
                         start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# --------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--desktop", required=True)
    ap.add_argument("--interactive", action="store_true",
                    help="also report 'up to date' / errors instead of exiting silently")
    args = ap.parse_args()

    fetch = git(args.repo, "fetch", "--quiet")
    if fetch.returncode != 0:
        if args.interactive:
            info_gui("Aria updater", f"git fetch failed:\n{fetch.stdout.strip()[:600]}")
        return

    upstream = git(args.repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if upstream.returncode != 0:
        if args.interactive:
            info_gui("Aria updater", "Current branch has no upstream to compare against.")
        return
    upstream = upstream.stdout.strip()

    behind = git(args.repo, "rev-list", "--count", f"HEAD..{upstream}")
    count = int(behind.stdout.strip() or "0") if behind.returncode == 0 else 0
    ahead_r = git(args.repo, "rev-list", "--count", f"{upstream}..HEAD")
    ahead = int(ahead_r.stdout.strip() or "0") if ahead_r.returncode == 0 else 0

    if count <= 0:
        # Purely ahead (local work upstream doesn't have) is NOT an update —
        # a developer's build is expected to lead the repo.
        if args.interactive:
            note = f" (you are {ahead} commit(s) ahead)" if ahead > 0 else ""
            info_gui("Aria updater", "Aria is up to date with " + upstream + note + ".")
        return

    if ahead > 0:
        # Diverged: pulling would need a merge/rebase over local commits.
        # Never kill the app or auto-pull in this state — just report it.
        if args.interactive:
            info_gui("Aria updater",
                     f"Branch has diverged from {upstream}: {ahead} commit(s) ahead, "
                     f"{count} behind.\n\nResolve manually (git pull --rebase or merge) — "
                     "the auto-updater only fast-forwards.")
        return

    old_head = git(args.repo, "rev-parse", "HEAD").stdout.strip()
    if not ask("Aria update available",
               f"Your Aria checkout is {count} commit(s) behind {upstream}.\n\n"
               "Update now? Aria will close, pull the latest changes and restart."):
        return

    kill_pid(args.pid)

    pull = git(args.repo, "pull", "--ff-only", timeout=600)
    if pull.returncode != 0:
        info_gui("Aria updater",
                 "git pull failed (local changes or diverged branch?):\n\n"
                 + pull.stdout.strip()[:600]
                 + "\n\nAria was closed — restart it manually with `npm run dev`.")
        return

    # Reinstall only when the desktop dependency set changed.
    diff = git(args.repo, "diff", "--name-only", f"{old_head}..HEAD")
    changed = diff.stdout if diff.returncode == 0 else ""
    if "desktop/package-lock.json" in changed or "desktop/package.json" in changed:
        npm = "npm.cmd" if sys.platform == "win32" else "npm"
        run([npm, "install", "--no-audit", "--no-fund"], cwd=args.desktop, timeout=900)

    relaunch(args.desktop)

if __name__ == "__main__":
    main()
