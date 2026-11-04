/* Opt-in host CPU benchmark; no emulated state or timing is advanced. */
#include "rea_raster.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void)
{
	vdp_context *v = calloc(1, sizeof(*v) + VRAM_SIZE);
	v->rea_raster = calloc(1, sizeof(rea_raster));
	pixel_t output[LINEBUF_SIZE] = {0};
	v->output = output; v->regs[REG_MODE_2] = BIT_MODE_5;
	for (unsigned i=0;i<256;i++) v->colors[i] = 0xFF000000 | (i*0x12345 & 0xFFFFFF);
	for (unsigned x=0;x<LINEBUF_SIZE;x++) {
		v->flags = x & 16 ? FLAG_WINDOW : 0;
		rea_raster_inputs(v,x,x%5 ? x&127 : 0,x&127,(x+1)&127);
		v->compositebuf[x] = x&63; v->layer_debug_buf[x] = x%5;
	}
	for (unsigned batch=0;batch<2;batch++) {
		clock_t start = clock();
		for (unsigned frame=0;frame<1000;frame++) {
			v->regs[REG_MODE_4] = frame&1 ? BIT_HILIGHT : 0;
			for (unsigned row=0;row<240;row++) {
				rea_raster_line(v,row);
				if (batch) rea_raster_emit(v,0,LINEBUF_SIZE,1);
				else for (unsigned x=0;x<LINEBUF_SIZE;x+=2) rea_raster_emit(v,x,2,1);
			}
		}
		double ms = (double)(clock()-start)*1000/CLOCKS_PER_SEC/1000;
		unsigned checksum=0;
		for(unsigned layer=0;layer<5;layer++) for(unsigned x=0;x<LINEBUF_SIZE*240*4;x++) checksum=checksum*33+v->rea_raster->rgba[layer][x];
		printf("%s: %.3f ms/frame, checksum %u\n",batch?"row batch":"two-pixel slots",ms,checksum);
	}
	free(v->rea_raster);free(v);return 0;
}
