#!/usr/bin/env python3
# Drive the real terminal app over a pty; emulate screen with pyte; assert MVP flow.
# Tab order (document order): Entities summary → name input → add → [per-entity: ent
# button/del…] → Field summary → field input → type select → PK/NULL/UQ → add →
# Relations summary → … → save/load/sql.
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
import tty

import pyte  # type: ignore[import-not-found]  # provided by `uv run --with pyte`

node = sys.argv[1]
m, s = pty.openpty()
fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
tty.setraw(m)
p = subprocess.Popen([node, "/home/afman42/repo/erd-creator/dist/app.mjs"],
                     stdin=s, stdout=s, stderr=s,
                     cwd="/home/afman42/repo/erd-creator",
                     env={**os.environ, "TERM": "xterm-256color"})
os.close(s)
screen = pyte.Screen(120, 30)
stream = pyte.Stream(screen)


def drain(t=0.4):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([m], [], [], 0.05)
        if r:
            try:
                d = os.read(m, 65536)
            except OSError:
                return
            if not d:
                return
            stream.feed(d.decode("utf-8", "replace"))


def tab(n=1):
    for _ in range(n):
        send(b"\t")


def send(data):
    os.write(m, data)
    drain(0.25)


def disp():
    return "\n".join(screen.display)


R = []


def check(name, cond):
    R.append((name, bool(cond)))
    print(f"{name}: {'OK' if cond else 'FAIL'}")


drain(2.5)
if p.poll() is not None:
    print("EXITED code=", p.returncode)
    sys.exit(1)
check("BOOT", "ERD CREATOR" in disp())

# tab 1 = Entities summary (open, Enter toggles), tab 2 = table_name input
tab(2)
send(b"users")
check("TYPED", "users" in disp())
send(b"\r")
drain(1.0)
check("ENTITY_ADDED", "users" in disp() and "Entities (1)" in disp())

# now focusables: summary(1) input(2) add(3) users-del-x(4) [field section if sel]
# after add, users selected → Field panel appears. tab to its name input:
# from input(2): add(3), x(4), del?(0 fields), Field summary(5), field input(6)
tab(4)
send(b"id")
send(b"\r")
drain(1.0)
check("FIELD_ADDED", "id INT PK" in disp() or "id INT" in disp())
if not R[-1][1]:
    print("--- after field ---")
    for i, line in enumerate(screen.display):
        if line.strip():
            print(i, repr(line[:118]))

# add second entity: tab back to name input (position shifts after field add;
# click-focus via tab from current: field-add(7) then rel summary etc. —
# simplest: Shift+Tab back or just click. Use: many tabs then retry)
tab(1)
send(b"\x1b[Z")  # Shift+Tab ×1 to field add button, keep probing with explicit path:
# probe: walk focus printing status line
p.kill()
os.close(m)
fails = [n for n, ok in R if not ok]
print("DONE fails=" + ",".join(fails) if fails else "ALL OK")
sys.exit(1 if fails else 0)
