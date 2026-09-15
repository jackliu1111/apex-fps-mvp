"""Exercise a real PTY: menu, inspect, checkbox cancellation and selected export."""
import json
import os
from pathlib import Path
import sys
import pexpect

root = Path(__file__).resolve().parents[1]
result = (root / 'build/真实 分析/clips.json').resolve()
# Take an isolated copy so this test can be repeated without touching previous selection.
folder = root / 'build/终端 验收'
folder.mkdir(exist_ok=True)
(folder / 'clips.json').write_bytes(result.read_bytes())
for name in ('selection.json', 'apex_montage.mp4'):
    (folder / name).unlink(missing_ok=True)
program = sys.argv[1:] or [str(root / '.venv/bin/python'), str(root / 'highlight_cli.py')]
env = os.environ | {'TERM':'xterm-256color', 'PROMPT_TOOLKIT_NO_CPR':'1'}
child = pexpect.spawn('/usr/bin/env', program, encoding='utf-8', timeout=60, env=env, dimensions=(40, 120))
with (folder / 'pty.log').open('w') as log:
    child.logfile = log
    child.expect('主菜单')
    child.send('\x1b[B\x1b[B\r')
    child.expect('clips.json 路径')
    child.send(str(folder / 'clips.json') + '\r')
    child.expect('结果操作')
    child.send('\r')
    child.expect('空格切换')
    # Cancel first default-selected candidate; all other candidates remain checked.
    child.send(' \r')
    child.expect('确认导出 7 个片段')
    child.send('\r')
    child.expect('成片：')
    child.expect('接下来')
    child.send('\x1b')
    child.expect('主菜单')
    child.send('q')
    child.expect(pexpect.EOF)
child.close()
assert child.exitstatus == 0, child.exitstatus
ids = json.loads((folder / 'selection.json').read_text())['clips']
assert ids == list(range(2, 9)), ids
print('PTY menu + default selection + deselect + existing-result export: PASS')

# Empty selection returns to the menu without writing a new selection.
before = (folder / 'selection.json').read_bytes()
child = pexpect.spawn('/usr/bin/env', program, encoding='utf-8', timeout=60, env=env, dimensions=(40, 120))
child.expect('主菜单')
child.send('\x1b[B\x1b[B\r')
child.expect('clips.json 路径')
child.send(str(folder / 'clips.json') + '\r')
child.expect('结果操作')
child.send('\r')
child.expect('空格切换')
child.send('a\r')
child.expect('未选择片段')
child.send('\r')
child.expect('结果操作')
child.send('\x1b')
child.expect('主菜单')
child.send('q')
child.expect(pexpect.EOF)
child.close()
assert child.exitstatus == 0
assert (folder / 'selection.json').read_bytes() == before
print('PTY deselect all + return: PASS')

# A short terminal pages candidates; Escape backs out of paths and error screens.
child = pexpect.spawn('/usr/bin/env', program, encoding='utf-8', timeout=15,
                      env=env, dimensions=(24, 80))
child.expect('主菜单')
assert '\x1b[?1049h' in child.before, 'wizard must use the alternate screen'
child.send('\x1b[B\x1b[B\r')
child.expect('clips.json 路径')
child.send('\x1b')
child.expect('主菜单')
child.send('\x1b[B\x1b[B\r')
child.expect('clips.json 路径')
child.send(str(folder / 'missing.json') + '\r')
child.expect('按任意键')
child.send('\x1b')
child.expect('主菜单')
child.send('\x1b[B\x1b[B\r')
child.expect('clips.json 路径')
child.send(str(folder / 'clips.json') + '\r')
child.expect('结果操作')
child.send('\x1b[B\r')
child.expect('候选 ')
child.expect('结果操作')
# Rich can insert formatting between digits; check after removing ANSI sequences.
import re
plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', child.before)
assert '第 2/8 页' in plain, plain
child.sendcontrol('c')
child.expect(pexpect.EOF)
assert '\x1b[?1049l' in child.before, 'interrupt must restore the shell screen'
child.close()
assert child.exitstatus == 130
assert (folder / 'selection.json').read_bytes() == before
print('PTY 80x24 pagination + Escape + error recovery + Ctrl+C restoration: PASS')
