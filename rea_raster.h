/* GPL-3.0-or-later. Observation buffers; never read by emulated hardware. */
#ifndef REA_RASTER_H
#define REA_RASTER_H
#include "vdp.h"
#define REA_RASTER_PLANES 5
#define REA_RASTER_PIXELS (LINEBUF_SIZE * 512)
enum { REA_SPRITES, REA_A, REA_B, REA_WINDOW, REA_SOURCE };
typedef struct rea_raster {
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
#endif
