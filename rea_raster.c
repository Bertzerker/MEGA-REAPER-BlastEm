/* GPL-3.0-or-later. Tap actual compositor inputs, then resolve their colors at
 * the same output slots as the normal VDP DAC lookup. No VRAM re-rendering. */
#include "rea_raster.h"
#include <stdlib.h>
#include <string.h>

static void rgba(uint8_t *dst, pixel_t p, uint8_t alpha)
{
#ifdef USE_RGB565
	dst[0] = ((p >> 11) & 31) * 255 / 31; dst[1] = ((p >> 5) & 63) * 255 / 63; dst[2] = (p & 31) * 255 / 31;
#elif defined(USE_GLES)
	dst[0] = p; dst[1] = p >> 8; dst[2] = p >> 16;
#else
	dst[0] = p >> 16; dst[1] = p >> 8; dst[2] = p;
#endif
	dst[3] = alpha;
}
static void source_color(uint8_t *dst, unsigned source)
{
	static const uint8_t colors[5][4] = {{48,48,56,255},{0,208,255,255},{192,96,255,255},{64,224,112,255},{255,176,48,255}};
	if (source > 4) source = 0;
	memcpy(dst, colors[source], 4);
}
void rea_raster_init(vdp_context *v)
{
	const char *stream = getenv("BLASTEM_REA_STREAM_PORT");
	if (v->type == VDP_GENESIS && stream && *stream) {
		v->rea_raster = calloc(1, sizeof(rea_raster));
		if (v->rea_raster) v->rea_raster->row = -1;
	}
}
void rea_raster_clear(vdp_context *v)
{
	if (!v->rea_raster) return;
	/* Called after publication, and after a state load. Old frame/row data must
	 * not leak into borders, display-disabled lines or a new scene. */
	rea_raster *r = v->rea_raster;
	/* Only rows visited since the last reset can contain evidence. Clear that
	 * range in every plane, including gaps, rather than touching 512 rows per
	 * frame. Untouched rows were already zeroed by calloc/the previous reset. */
	if (r->have_rows) {
		unsigned start = r->first_row * LINEBUF_SIZE;
		unsigned count = (r->last_row - r->first_row + 1) * LINEBUF_SIZE;
		for (unsigned layer=0;layer<5;layer++) memset(r->rgba[layer]+start*4,0,count*4);
		for (unsigned layer=0;layer<4;layer++) memset(r->samples[layer]+start,0,count);
		memset(r->flags+start,0,count);
	}
	memset(r->inputs,0,sizeof(r->inputs));
	r->row = -1; r->have_rows = r->unsupported = 0;
}
void rea_raster_line(vdp_context *v, int row)
{
	if (!v->rea_raster) return;
	v->rea_raster->row = row;
	if (row >= 0 && row < 512) {
		rea_raster *r = v->rea_raster;
		if (!r->have_rows) { r->first_row = r->last_row = row; r->have_rows = 1; }
		else { if (row < r->first_row) r->first_row = row; if (row > r->last_row) r->last_row = row; }
	}
	if (!(v->regs[REG_MODE_2] & BIT_MODE_5) || v->s32x_vid || (v->test_regs[0] & 0x1C0)) v->rea_raster->unsupported = 1;
}
void rea_raster_inputs(vdp_context *v, unsigned x, uint8_t sprite, uint8_t a, uint8_t b)
{
	rea_raster *r = v->rea_raster;
	if (!r || x >= LINEBUF_SIZE) return;
	r->inputs[REA_SPRITES][x] = sprite;
	r->inputs[REA_B][x] = b;
	r->inputs[REA_A][x] = v->flags & FLAG_WINDOW ? 0 : a;
	r->inputs[REA_WINDOW][x] = v->flags & FLAG_WINDOW ? a : 0;
}
void rea_raster_emit(vdp_context *v, unsigned x, unsigned count, int composite)
{
	rea_raster *r = v->rea_raster;
	if (!r || r->row < 0 || r->row >= 512 || !v->output) return;
	if (!(v->regs[REG_MODE_2] & BIT_MODE_5) || (v->test_regs[0] & 0x1C0)) { r->unsupported = 1; return; }
	const int highlight = v->regs[REG_MODE_4] & BIT_HILIGHT;
	for (unsigned end = x + count; x < end && x < LINEBUF_SIZE; x++) {
		unsigned offset = r->row * LINEBUF_SIZE + x;
		uint8_t source = composite ? v->layer_debug_buf[x] & DBG_SRC_MASK : DBG_SRC_BG;
		if (source == DBG_SRC_A && r->inputs[REA_WINDOW][x]) source = DBG_SRC_W;
		uint8_t intensity = composite ? v->compositebuf[x] & 0xC0 : 0;
		uint8_t flags = source | (intensity == SHADOW_OFFSET ? 0x10 : intensity == HIGHLIGHT_OFFSET ? 0x20 : 0);
		if (!composite) flags |= 0x40;
		/* Specialize the four fixed planes. Source/priority selection and S/H
		 * control checks previously ran through a four-way loop for every dot. */
		uint8_t sprite = composite ? r->inputs[REA_SPRITES][x] : 0;
		uint8_t a = composite ? r->inputs[REA_A][x] : 0;
		uint8_t b = composite ? r->inputs[REA_B][x] : 0;
		uint8_t window = composite ? r->inputs[REA_WINDOW][x] : 0;
		uint8_t winner = source == DBG_SRC_S ? sprite : source == DBG_SRC_A ? a : source == DBG_SRC_B ? b : source == DBG_SRC_W ? window : 0;
		flags |= (winner >> 3) & 8;
#define EMIT_LAYER(layer, sample, control) do { \
		uint8_t *out = r->rgba[layer] + offset * 4; \
		r->samples[layer][offset] = sample; \
		if ((sample & 15) && !(control)) rgba(out, v->colors[(sample & 63) | intensity], 255); \
		else memset(out, 0, 4); \
	} while (0)
		/* Palette-3 E/F sprite pixels are S/H operators, never colored texels. */
		EMIT_LAYER(REA_SPRITES, sprite, highlight && (sprite & 0x3E) == 0x3E);
		EMIT_LAYER(REA_A, a, 0);
		EMIT_LAYER(REA_B, b, 0);
		EMIT_LAYER(REA_WINDOW, window, 0);
#undef EMIT_LAYER
		r->flags[offset] = flags;
		source_color(r->rgba[REA_SOURCE] + offset * 4, source);
	}
}
void rea_raster_dot(vdp_context *v, unsigned x)
{
	rea_raster *r = v->rea_raster;
	if (!r || r->row < 0 || r->row >= 512 || x >= LINEBUF_SIZE) return;
	unsigned offset = r->row * LINEBUF_SIZE + x;
	r->flags[offset] |= 0x80;
	uint8_t *out = r->rgba[REA_SOURCE] + offset * 4;
	out[0] = 255; out[1] = 0; out[2] = 255; out[3] = 255;
}
