#ifndef REA_STREAM_H
#define REA_STREAM_H
#include "vdp.h"
#include <time.h>
void rea_stream_capture(vdp_context *v, unsigned width, unsigned height, uint64_t sequence, time_t session);
#endif
