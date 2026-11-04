#include "rea_raster.h"
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>

int main(void)
{
	vdp_context *v = calloc(1, sizeof(*v) + VRAM_SIZE);
	v->rea_raster = calloc(1, sizeof(rea_raster));
	pixel_t output[LINEBUF_SIZE] = {0}; v->output = output;
	v->regs[REG_MODE_2] = BIT_MODE_5;
	const unsigned x=13, row=4, offset=row*LINEBUF_SIZE+x;
	rea_raster_line(v, row);
	v->colors[1]=0xFFFF0000; v->colors[2]=0xFF0000FF; v->colors[3]=0xFF00FF00;
	v->compositebuf[x]=1; v->layer_debug_buf[x]=DBG_SRC_A;
	rea_raster_inputs(v,x,0,1,2); rea_raster_emit(v,x,1,1);
	assert(v->rea_raster->rgba[REA_A][offset*4]==255);
	assert(v->rea_raster->rgba[REA_A][offset*4+1]==0);
	assert(v->rea_raster->rgba[REA_B][offset*4+2]==255);
	/* Same palette index changes in the next output slot. The previous pixel
	 * must retain its raster-time color, regardless of end-of-frame memory. */
	v->colors[1]=0xFF00FF00; v->vdpmem[0]=0xFF;
	v->compositebuf[x+1]=1; v->layer_debug_buf[x+1]=DBG_SRC_A;
	rea_raster_inputs(v,x+1,0,1,2); rea_raster_emit(v,x+1,1,1);
	assert(v->rea_raster->rgba[REA_A][offset*4]==255);
	assert(v->rea_raster->rgba[REA_A][(offset+1)*4+1]==255);
	/* Window owns the A input; do not invent a simultaneous A pixel. */
	v->flags |= FLAG_WINDOW;
	rea_raster_inputs(v,x,0,3,2); rea_raster_emit(v,x,1,1);
	assert(v->rea_raster->samples[REA_A][offset]==0);
	assert(v->rea_raster->samples[REA_WINDOW][offset]==3);
	assert((v->rea_raster->flags[offset]&7)==DBG_SRC_W);
	assert(v->rea_raster->rgba[REA_WINDOW][offset*4+1]==255);
	/* S/H operators must not become ordinary colored sprite texels. */
	v->flags=0;v->regs[REG_MODE_4]=BIT_HILIGHT;
	v->colors[HIGHLIGHT_OFFSET+1]=0xFFFF8080;
	v->compositebuf[x]=HIGHLIGHT_OFFSET+1;v->layer_debug_buf[x]=DBG_SRC_B;
	rea_raster_inputs(v,x,0x3E,0,0x41);rea_raster_emit(v,x,1,1);
	assert(v->rea_raster->samples[REA_SPRITES][offset]==0x3E);
	assert(v->rea_raster->rgba[REA_SPRITES][offset*4+3]==0);
	assert(v->rea_raster->rgba[REA_B][offset*4+1]==128);
	assert((v->rea_raster->flags[offset]&0x28)==0x28);
	rea_raster_emit(v,x,1,0);
	assert(v->rea_raster->rgba[REA_B][offset*4+3]==0);
	assert(v->rea_raster->flags[offset]&0x40);
	rea_raster_dot(v,x);
	assert(v->rea_raster->flags[offset]&0x80);
	assert(v->rea_raster->rgba[REA_SOURCE][offset*4]==255);
	assert(v->rea_raster->rgba[REA_SOURCE][offset*4+2]==255);
	v->test_regs[0]=0x40;rea_raster_emit(v,x,1,1);assert(v->rea_raster->unsupported);
	rea_raster_clear(v);assert(v->rea_raster->row==-1);assert(!v->rea_raster->flags[offset]);
	assert(!v->rea_raster->rgba[REA_SOURCE][offset*4+3]);
	/* Dirty-row reset covers sparse/out-of-order/interlaced fields, and a
	 * following shorter/partial frame must never expose old pixels. */
	v->test_regs[0]=0;
	for(unsigned row=0;row<512;row+=511){
		rea_raster_line(v,row);rea_raster_inputs(v,x,1,1,1);rea_raster_emit(v,x,1,1);
	}
	rea_raster_clear(v);
	for(unsigned layer=0;layer<5;layer++) for(unsigned i=0;i<REA_RASTER_PIXELS*4;i++) assert(!v->rea_raster->rgba[layer][i]);
	for(unsigned layer=0;layer<4;layer++) for(unsigned i=0;i<REA_RASTER_PIXELS;i++) assert(!v->rea_raster->samples[layer][i]);
	for(unsigned i=0;i<REA_RASTER_PIXELS;i++) assert(!v->rea_raster->flags[i]);
	rea_raster_line(v,20);rea_raster_emit(v,x,1,0);rea_raster_clear(v);
	assert(!v->rea_raster->have_rows);
	free(v->rea_raster);free(v);
	puts("PASS: DAC-time colors, retained inputs, Window selection, S/H controls, priority, blanking, CRAM artifacts and resets");
	return 0;
}
