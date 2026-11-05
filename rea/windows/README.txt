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
game window with keyboard/gamepad interaction. The REA page includes movie
controls and an optional keyboard controller. The launcher does not choose another browser.
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

Investigation movies and comments:
Enter a title and choose "Record new movie" on the REA page. Use Play, Pause,
Step frame and Speed (0.25x to 4x) to control emulation. Stop recording before
replay or ZIP export. Replay starts at the saved checkpoint and requires the
same ROM, emulator executable and configuration. The original release build
should be preserved alongside important movies.

"Comment on displayed frame" freezes inspection and saves that exact render,
six-view atlas and memory/register snapshot as a draft. Write Markdown and use
the JSON/Mermaid insertion buttons, Preview, then Save comment. Movie + notes
ZIP export includes the checkpoint, inputs, comments, PNGs and snapshot JSON.
Movies and comments persist locally in rea\session\; no ROM is exported.
Offline preview libraries and their license notices are in rea\public\vendor\.

Sprite & tile catalog:
Pick a sprite or plane pixel and choose "Add to catalog" to name a match or
append an animation variant. Show all matches or follow one captured instance.
"Attach to comment" saves the original capture and catalog revision during live
play or replay. Comments and movie exports include the saved isolation image
and catalog definition. See README.md for the illustrated guide.

Elemental Master (USA) collision helper:
Open Collision, enable "Overlay on Composite", and choose All views or Focus
Composite. Filter player, contact and pickup boxes and inspect the matching
RAM operands in live play, replay, or saved evidence. The player and a Stage 1
type-22 enemy were verified with a replayed near miss and a damaging hit.
See rea\COLLISION.md for the ROM identity, evidence and profile scope.

Project attribution:
BlastEm was created by Mike Pavone, with contributions from the BlastEm community.
Original project: https://www.retrodev.com/blastem/
Official Mercurial source: https://www.retrodev.com/repos/blastem
MEGA REAPER builds on ulalume's debugging fork (GDB remote, scriptable control
socket and embedded UI font): https://github.com/ulalume/blastem
The REA capture, inspector and Windows launcher/package are MEGA REAPER additions.
MEGA REAPER is independently maintained from the original BlastEm project.
