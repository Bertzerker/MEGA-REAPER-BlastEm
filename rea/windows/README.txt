MEGA REAPER - BlastEm
Portable Windows x64 build

1. Extract the entire ZIP to a writable folder.
2. Double-click "MEGA REAPER.exe" and select your own Genesis / Mega Drive ROM.
   You can also drag one ROM onto the launcher.
3. Copy the inspector URL from the launcher and open it in the Codex in-app
   browser. The default URL is http://127.0.0.1:8765/.
4. Click "Stop and close", or close the launcher, to stop both the emulator
   and the REA server. No second BlastEm instance is permitted.

Node.js, the REA interface, its production dependencies and SDL2 are included.
No installation, npm command, administrator access or PowerShell policy change
is needed. No commercial ROM or local capture is included. ROMs stay local.

Optional command line:
  "MEGA REAPER.exe" --rom "C:\Games\My Game.md" --port 8890
  "MEGA REAPER.exe" --native-window "C:\Games\My Game.md"

Browser-only display is the default. --native-window enables a separate native
game window with keyboard/gamepad interaction. The browser inspector remains
read-only. The native launcher does not automatically choose another browser.
An existing BlastEm process or occupied port prevents another launch.

The PowerShell alternative is rea\Start-REA.ps1; it uses runtime\node.exe when
present. logs\server.log and logs\emulator.log contain startup diagnostics.

All six views share each real capture. The tested configuration sustained the
Genesis NTSC rate (about 59.92 updates/s); see rea\README.md for the measured
configuration, supported modes and the approximately 100-ms buffering tradeoff.

This is a Windows x64 package. It is not a Windows ARM64-native build.

License: GPL-3.0-or-later. See COPYING and COPYING.fork. Third-party license
texts are in licenses\, including the complete Node.js license notices.
build-manifest.json identifies the source commit and component versions.
The corresponding source is available at the same release tag:
https://github.com/Bertzerker/MEGA-REAPER-BlastEm/releases

Development documentation and original emulator manual are also included.
