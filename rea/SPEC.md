# AI-assisted Genesis reverse-engineering emulator

## Objective

Let a human or AI connect observed game behavior to graphics state, memory and executed code, then reproduce and test that explanation. Emulate once; expose multiple synchronized views. Prefer exact hardware facts and evidence-backed hypotheses over inferred object names presented as facts.

## Architecture

1. Unmodified timing-critical CPU/VDP execution, apart from opt-in bounded capture hooks.
2. An observation boundary captures completed output and device/RAM data on the emulation thread. No observer bus reads with hardware side effects.
3. Immutable, session-qualified snapshot identifiers bind every inspection request to evidence. Capture metadata includes both CPU and device cycle counters.
4. A local structured API serves both the human dashboard and AI clients. Errors distinguish unsupported modes, unavailable history and invalid addresses.
5. Higher-level game adapters interpret verified memory layouts, collision geometry, terrain tables, camera transforms and object composition.

## Delivered increment

The implementation in README.md includes immutable inspection copies and checkpoint-based input movies. Sprite/A/B/Window pixels are captured from actual compositor inputs and resolved using the live output-slot palette and scene intensity. A captured source/priority map is the sixth panel. VRAM tiles and SAT bounds are separate snapshot diagnostics. A persistent nonblocking TCP stream carries captured pixels and metadata; the server only blits them into one atlas, sent as one WebSocket packet and displayed as one WebGL texture. It performs no end-of-frame layer reconstruction in raster mode. Bounded queues prevent unbounded latency. Graphics target 60 Hz; memory/register text updates at 10 Hz with capture labels. Current direct-raster performance and supported/unsupported paths are documented in README.md.

## Delivered: investigation movies and frame comments

- Local checkpoint/input-log recording and replay for standard Genesis cartridges and two controllers; exact ROM/executable checks and per-frame render/memory divergence detection.
- Browser play/pause, single-frame step, 0.25×–4× speed, movie library, optional keyboard controller and ZIP export.
- Persistent Markdown comments, validated JSON blocks and offline Mermaid preview, bound to immutable movie/frame/capture identities and hashed lossless render/atlas PNGs plus memory snapshot JSON.
- Broader determinism validation, rerecording/branching, seeking, reset-event logging and interchange formats remain outside this increment.

## Delivered: review workbench and bridge protocol 2

Selection retains one capture before revealing pixel/memory evidence. Viewer connection, native producer, machine state and live/frozen/saved/invalid evidence are separate states. A bounded evidence lease retains selected and comparison captures across streaming history eviction. Archived comments verify snapshot SHA-256 before the same atlas/memory/pixel interface loads them. Comparison scopes include ROM identity, executable and native producer/ROM generation; incompatible scopes fail explicitly.

The editor journals local drafts separately for each tab, guards note/library changes and requires a base revision on each server save. Conflicts retain both texts; rebasing is an explicit user action. The graphics-left shell uses the same GPU atlas texture for focused regions, preserves source/priority and shadow/highlight semantics, and exposes copied memory/watch data independently from renderer support.

The versioned session descriptor names supported/temporarily unavailable/unsupported actions, reasons, values, bounds and stopping granularity. `/api/control` adds general compatible disk checkpoints, 1–3600-frame input experiments and acknowledged pause/capture. Movie playback remains authoritative and blocks experiment mutation. Frame watches compare bounded copied memory ranges; they stop after the requested capture count or 500 change events and report delivery/capture granularity. They do not claim CPU instruction provenance or gameplay collision knowledge.

## Separate design: rerecording, branches and seek

RMTAS001 remains a strict exact-ROM/executable/configuration replay format. Its row N checks capture N and supplies the two pad masks applied after that capture. A new branch/seek implementation must use a new format/version rather than changing these conventions in place.

1. Identify an immutable movie version by initial checkpoint digest, normalized ROM/executable/configuration identities, controller topology and input-log digest. A branch records its parent version, fork boundary and replacement input suffix; annotations retain their original movie-version/frame/capture references.
2. Checkpoints index execution boundaries, not screenshots. Persist both CPU/device state and capture/scheduling state needed to reproduce the next full frame. Explicitly record reset, power, peripheral and configuration events, or reject them. Never promise another core/build can replay a checkpoint merely because it accepts the file.
3. Seek restores the nearest compatible checkpoint, replays inputs through the target boundary and verifies render/memory digests. Return an acknowledged target capture only on success. Bound replay work in chunks, allow cancellation at a completed-frame boundary and report an unknown outcome if the connection fails. Reviewing archived evidence never invokes seek.
4. Rerecording creates a new immutable movie version. Show whether an annotation is original evidence, a hypothesis for the new branch, or newly recaptured evidence. Do not silently relabel parent observations or replace their PNG/snapshot bytes with a different replay.
5. Acceptance requires repeated short and long DMA/interrupt/raster-sensitive recordings, cold process restarts, controls at multiple speeds, injected corruption and incompatible configuration/builds. A seek result must match direct forward replay for all captured planes, memory domains and declared timing/device-state hashes. Cross-build interchange needs its own explicitly versioned compatibility proof.

Until those conditions are met, the workbench presents read-only input rows and restart replay rather than an editable timeline or a scrubber.

## Separate native work: instruction traces and collision adapters

Instruction traces need a bounded native ring with ROM/bank identity, instruction address/opcode, cycle/frame timestamps, relevant operands and declared stop timing. Export counts, byte/event limits and truncation. A watch between copied frame captures must never be labeled as every CPU write or instruction. Preserve normal core behavior when tracing is disabled, and measure native speed separately from viewer throughput when enabled.

A game collision adapter must be keyed to a verified ROM/core identity and describe the actual software operands and predicates used by that game. Require source addresses, object identity, coordinate transforms and evidence references; distinguish observed/hypothesized/verified geometry. Validate against a diagnostic collision routine and replayed contact/non-contact cases before displaying a verified collision overlay. SAT rectangles remain a separate hardware diagnostic. No generic game collision profile is included in this increment.

## Delivered: raster-time pixel evidence

- Record actual input samples, output-time RGBA, winning source, priority, intensity, transparent/blank coverage and CRAM output artifacts. Clear capture buffers on frame boundaries and state loads.
- Preserve executed scrolling, Window selection, sprite masking/scanline drops and shadow/highlight operators. Unavailable capture paths must not fall back to memory reconstruction.
- Verified with H40 raster diagnostics, H32 captures and native helper tests. A ROM changes CRAM within a scanline, scroll, tile patterns and Window boundaries, then restores end-of-frame memory; captured images retain the raster history. Winning-source pixels match actual output, excluding explicitly flagged output artifacts.
- Specialized capture writes and touched-row resets reduce host overhead. Browser-only display avoids redundant native GPU presentation. Source-clock metadata drives bounded browser presentation so NTSC/display drift does not gradually drain the jitter buffer. Lossless pixel runs with raw fallback keep atlas encoding cost predictable. Metrics distinguish unique presentations, native frame gaps, backpressure skips and queue underruns; repeated display refreshes do not count as new frames. A three-minute Elemental Master run passed sustained NTSC-rate acceptance with zero delivery loss; measurements, latency tradeoff and the exact workload are in README.md.

## Next: fetch/write provenance

- Add the actual pattern-fetch address, tile attributes and SAT identity to each captured pixel. Current pixel inspection deliberately does not infer these from end-of-frame tables.
- Capture DMA source/destination/length, CPU instruction context when available, and VRAM writes in a bounded ring. Do not equate a decompressed RAM source with its original ROM asset without further evidence.
- Expose `inspect_pixel(snapshot,x,y)` with exact source references or an explicit unavailable field. Reconstructed links must remain labeled as such.
- Acceptance: a diagnostic ROM changing scroll/palette/tiles mid-frame must show matching changes in captured isolated views, and each selected pixel must point to the actual fetched data rather than end-of-frame state.

## Next: experiment control

- Add pause/resume, instruction/frame stepping, checkpoint creation/restoration, bounded trace and memory read/write watchpoints to the structured API.
- Make checkpoints complete: CPUs, devices, mapper/save RAM, timing queues and controller state. Hash the ROM/core/configuration and reject incompatible restores.
- Journal exact input transitions by emulated frame/cycle. Replay from checkpoints, verify state/output hashes, and report divergence instead of claiming determinism.
- Separate execution controls from observation. Bound traces by instructions/events/bytes, with explicit truncation metadata.
- Acceptance: restore/replay the same input log twice; require matching output and selected state hashes over the full replay. Include a game that uses DMA and interrupts.

## Next: collision and durable knowledge

- Hardware bounds, pixel overlap and game collision geometry are separate overlay types.
- A game adapter supplies geometry with object identity, coordinate transform, source addresses, code references and conditions. Multiple hardware sprites may belong to one game object.
- AI findings have status `observed`, `hypothesis` or `verified`, evidence snapshot/trace references and confidence. Scope labels by ROM hash, mapper/bank and context to account for RAM reuse.
- Persist annotations and experiment recipes locally. Never auto-label visual sprite rectangles as hitboxes.
- Acceptance: a known software collision routine must be linked to its operands, branch and resulting damage write; an overlay must match those operands across replayed contacts and non-contacts.

## Platform / correctness constraints

Genesis Mode 5 is first. Other systems require capability discovery rather than pretending their layers/address spaces match Genesis. Unsupported modes must be explicit. Capture off should add only an early opt-in check. Budget and benchmark capture cost; move serialization off-thread only after copying a coherent immutable state. Atomic publication and bounded history prevent partial reads and unbounded memory growth. Retain upstream licenses and document the exact base commit.
