/* GPL-3.0-or-later. Observation buffers; never read by emulated hardware. */
#ifndef REA_RASTER_H
#define REA_RASTER_H
#include "vdp.h"
#define REA_RASTER_PLANES 5
#define REA_RASTER_PIXELS (LINEBUF_SIZE * 512)
enum { REA_SPRITES, REA_A, REA_B, REA_WINDOW, REA_SOURCE };
#define REA_CATALOG_RUN_BYTES 12
#define REA_CATALOG_MAX_RUNS 32768
typedef struct {
	uint64_t sprite[LINEBUF_SIZE], draw[MAX_SPRITES_LINE];
	uint64_t scroll[2][SCROLL_BUFFER_SIZE], inputs[4][LINEBUF_SIZE];
	uint16_t name[2];
	uint8_t links[MAX_SPRITES_LINE];
	uint8_t scan_valid[MAX_SPRITES_LINE], name_valid;
	uint8_t runs[REA_CATALOG_MAX_RUNS][REA_CATALOG_RUN_BYTES];
	uint64_t last[4];
	uint32_t generation;
	unsigned run_count, last_run[4], dropped;
	uint8_t partial, mode;
} rea_catalog;
typedef struct rea_raster {
	rea_catalog *catalog;
	uint8_t rgba[REA_RASTER_PLANES][REA_RASTER_PIXELS * 4];
	uint8_t samples[4][REA_RASTER_PIXELS];
	uint8_t flags[REA_RASTER_PIXELS];
	uint8_t inputs[4][LINEBUF_SIZE];
	int row;
	int first_row, last_row;
	uint8_t have_rows;
	uint8_t unsupported;
} rea_raster;
void rea_raster_init(vdp_context *v);
void rea_raster_clear(vdp_context *v);
void rea_raster_line(vdp_context *v, int row);
void rea_raster_inputs(vdp_context *v, unsigned x, uint8_t sprite, uint8_t a, uint8_t b);
void rea_raster_emit(vdp_context *v, unsigned x, unsigned count, int composite);
void rea_raster_dot(vdp_context *v, unsigned x);
void rea_catalog_discontinuity(vdp_context *v);

static inline uint64_t rea_catalog_key(uint16_t attr, uint16_t address, uint8_t slot, uint8_t link)
{
	return (1ull << 48) | ((uint64_t)link << 40) | ((uint64_t)slot << 32)
		| ((uint64_t)address << 16) | attr;
}
#endif
