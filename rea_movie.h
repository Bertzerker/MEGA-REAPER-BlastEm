/* GPL-3.0-or-later. Frame-latched controller movies for REA. */
#ifndef REA_MOVIE_H
#define REA_MOVIE_H
#include "vdp.h"
void rea_movie_poll(void);
void rea_movie_service(void);
void rea_movie_frame(void);
void rea_movie_capture(vdp_context *v, unsigned width);
int rea_movie_input(unsigned port, unsigned button, int down);
const char *rea_movie_metadata(void);
int rea_movie_active(void);
void rea_movie_reset(void);
#endif
