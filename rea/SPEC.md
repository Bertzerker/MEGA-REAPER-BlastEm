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
