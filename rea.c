/* REA inspection extensions, GPL-3.0-or-later.
 * Called before the completed framebuffer is submitted/released. No bus reads,
 * CPU execution, or VDP status-register reads are performed by this exporter.
 */
#include "rea.h"
#include "rea_stream.h"
#include "genesis.h"
#include "util.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

static void hexbyte(FILE *f, unsigned value)
{
	static const char digits[] = "0123456789abcdef";
	/* This FILE belongs exclusively to the emulation thread. Avoid taking a
	 * stdio lock twice per byte when publishing higher-frequency captures. */
#ifdef _WIN32
	_fputc_nolock(digits[(value >> 4) & 15], f);
	_fputc_nolock(digits[value & 15], f);
#else
	putc_unlocked(digits[(value >> 4) & 15], f);
	putc_unlocked(digits[value & 15], f);
#endif
}

static void bytes(FILE *f, const uint8_t *data, unsigned count)
{
	fputc('"', f);
	for (unsigned i = 0; i < count; i++) hexbyte(f, data[i]);
	fputc('"', f);
}

/* CPU words are host integers. Export bus-visible big-endian bytes. */
static void words(FILE *f, const uint16_t *data, unsigned count)
{
	fputc('"', f);
	for (unsigned i = 0; i < count; i++) {
		hexbyte(f, data[i] >> 8);
		hexbyte(f, data[i]);
	}
	fputc('"', f);
}

void rea_capture(vdp_context *v, unsigned width)
{
	const char *dir = getenv("BLASTEM_REA_DIR");
	const char *stream_port = getenv("BLASTEM_REA_STREAM_PORT");
	if ((!dir || !*dir) && (!stream_port || !*stream_port)) return;
	/* The renderer-thread copy has no coherent CPU/RAM context. Fail closed. */
	if (v->renderer || v->is_threaded_renderer || !v->system
		|| v->system->type != SYSTEM_GENESIS || !v->fb) return;
	static uint64_t sequence;
	static time_t session;
	static unsigned captures_until_next;
	static unsigned capture_every;
	if (!capture_every) {
		const char *setting = getenv("BLASTEM_REA_CAPTURE_EVERY");
		char *end;
		long n = setting ? strtol(setting, &end, 10) : (stream_port ? 1 : 2);
		capture_every = n >= 1 && n <= 60 && (!setting || !*end) ? (unsigned)n : 2;
	}
	if (captures_until_next) { captures_until_next--; return; }
	captures_until_next = capture_every - 1;
	if (!session) session = time(NULL);
	genesis_context *g = (genesis_context *)v->system;
	unsigned height = v->output_lines;
	if (!height || height+v->top_offset > 512 || width > LINEBUF_SIZE) return;
	if (stream_port && *stream_port) {
		rea_stream_capture(v, width, height, ++sequence, session);
		return;
	}
	char path[2048], tmp[2048];
	if (snprintf(path, sizeof(path), "%s/snapshot.json", dir) >= sizeof(path)
		|| snprintf(tmp, sizeof(tmp), "%s/snapshot.tmp", dir) >= sizeof(tmp)) return;
	FILE *f = fopen(tmp, "wb");
	if (!f) return;
	setvbuf(f, NULL, _IOFBF, 1024 * 1024);
#ifdef _WIN32
	unsigned pid = GetCurrentProcessId();
#else
	unsigned pid = getpid();
#endif
	fprintf(f, "{\"schema\":1,\"id\":\"%llu-%u-%llu\",\"frame\":%u,"
		"\"vdp_cycles\":%u,\"cpu_cycles\":%u,\"width\":%u,\"height\":%u,"
		"\"border_left\":%u,\"border_top\":%u,\"active_height\":%u,"
		"\"mode5\":%s,\"interlace\":%s,\"sprite_collision_flag\":%s,\"regs\":",
		(unsigned long long)session, pid, (unsigned long long)++sequence,
		v->frame, v->cycles, g->m68k->cycles, width, height, BORDER_LEFT,
		v->border_top, v->inactive_start,
		(v->regs[REG_MODE_2] & BIT_MODE_5) ? "true" : "false",
		(v->regs[REG_MODE_4] & BIT_INTERLACE) ? "true" : "false",
		(v->flags2 & FLAG2_SPRITE_COLLIDE) ? "true" : "false");
	bytes(f, v->regs, VDP_REGS);
	fputs(",\"vram\":", f); bytes(f, v->vdpmem, VRAM_SIZE);
	fputs(",\"cram\":", f); words(f, v->cram, CRAM_SIZE);
	fputs(",\"vsram\":", f); words(f, v->vsram, v->vsram_size);
	fputs(",\"ram\":", f); words(f, g->work_ram, RAM_WORDS);
	fputs(",\"zram\":", f); bytes(f, g->zram, Z80_RAM_BYTES);
	fputs(",\"rgb\":\"", f);
	for (unsigned y = 0; y < height; y++) {
		/* The core stores uncropped top-border rows before its displayed image. */
		pixel_t *row = (pixel_t *)((char *)v->fb + (y + v->top_offset) * v->output_pitch);
		for (unsigned x = 0; x < width; x++) {
			pixel_t p = row[x];
#ifdef USE_RGB565
			hexbyte(f, ((p >> 11) & 31) * 255 / 31);
			hexbyte(f, ((p >> 5) & 63) * 255 / 63);
			hexbyte(f, (p & 31) * 255 / 31);
#elif defined(USE_GLES)
			hexbyte(f, p); hexbyte(f, p >> 8); hexbyte(f, p >> 16);
#else
			hexbyte(f, p >> 16); hexbyte(f, p >> 8); hexbyte(f, p);
#endif
		}
	}
	fputs("\"}\n", f);
	int ok = !ferror(f);
	if (fclose(f)) ok = 0;
	if (ok) {
#ifdef _WIN32
		ok = MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
#else
		ok = rename(tmp, path) == 0;
#endif
	}
	/* Windows readers/antivirus may briefly deny replacement. Inspection must
	 * never pause the machine with warning()'s modal UI. Keep the last good file
	 * and retry at the next capture boundary. Report only the first failure in
	 * a streak to avoid flooding stderr if a directory remains unavailable. */
	static unsigned publish_failures;
	if (!ok) {
		if (!publish_failures++) fprintf(stderr, "REA: snapshot publication busy or failed; will retry\n");
		remove(tmp);
	} else publish_failures = 0;
}
