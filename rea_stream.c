/* GPL-3.0-or-later. Opt-in, loopback-only, nonblocking frame transport.
 * A partial packet is completed before another is built. There is no unbounded
 * frame queue, no disk serialization and no wait for an inspector on the CPU thread.
 */
#include "rea_stream.h"
#include "rea_raster.h"
#include "rea_movie.h"
#include "genesis.h"
#include "blastem.h"
#include "net.h"
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
typedef SOCKET rea_socket;
#define REA_INVALID INVALID_SOCKET
#define rea_close closesocket
#define rea_pid GetCurrentProcessId
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
typedef int rea_socket;
#define REA_INVALID -1
#define rea_close close
#define rea_pid getpid
#endif

static rea_socket stream = REA_INVALID;
static unsigned retry, connecting;
static uint8_t packet[8*1024*1024];
static unsigned pending, sent;

static void disconnect_stream(void)
{
	if (stream != REA_INVALID) rea_close(stream);
	stream = REA_INVALID; connecting = pending = sent = 0; retry = 60;
}

static int ready_stream(void)
{
	if (stream == REA_INVALID) {
		if (retry) { retry--; return 0; }
		const char *setting = getenv("BLASTEM_REA_STREAM_PORT");
		char *end;
		long port = setting ? strtol(setting, &end, 10) : 0;
		if (port < 1 || port > 65535 || *end) return 0;
		socket_init();
		stream = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		if (stream == REA_INVALID) { retry = 60; return 0; }
#ifdef _WIN32
		u_long nonblocking = 1; ioctlsocket(stream, FIONBIO, &nonblocking);
#else
		fcntl(stream, F_SETFL, fcntl(stream, F_GETFL, 0) | O_NONBLOCK);
#endif
		int flag = 1;
		setsockopt(stream, IPPROTO_TCP, TCP_NODELAY, (const char *)&flag, sizeof(flag));
		int capacity = 4*1024*1024;
		setsockopt(stream, SOL_SOCKET, SO_SNDBUF, (const char *)&capacity, sizeof(capacity));
#if !defined(_WIN32) && defined(SO_NOSIGPIPE)
		setsockopt(stream, SOL_SOCKET, SO_NOSIGPIPE, &flag, sizeof(flag));
#endif
		struct sockaddr_in address;
		memset(&address, 0, sizeof(address));
		address.sin_family = AF_INET; address.sin_port = htons((unsigned short)port);
		address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		connect(stream, (struct sockaddr *)&address, sizeof(address));
		connecting = 1;
	}
	if (connecting) {
		fd_set writable, errors;
		FD_ZERO(&writable); FD_ZERO(&errors); FD_SET(stream, &writable); FD_SET(stream, &errors);
		struct timeval timeout = {0, 0};
		if (select((int)stream+1, NULL, &writable, &errors, &timeout) <= 0) return 0;
		int error = 0;
#ifdef _WIN32
		int length = sizeof(error);
#else
		socklen_t length = sizeof(error);
#endif
		if (getsockopt(stream, SOL_SOCKET, SO_ERROR, (char *)&error, &length) || error || FD_ISSET(stream, &errors)) {
			disconnect_stream(); return 0;
		}
		connecting = 0;
	}
	return 1;
}

static int flush_packet(void)
{
	while (sent < pending) {
#ifdef _WIN32
		int n = send(stream, (const char *)packet+sent, pending-sent, 0);
#else
		int n = send(stream, packet+sent, pending-sent, MSG_NOSIGNAL);
#endif
		if (n > 0) { sent += n; continue; }
#ifdef _WIN32
		if (n < 0 && WSAGetLastError() == WSAEWOULDBLOCK) return 0;
#else
		if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
#endif
		disconnect_stream(); return 0;
	}
	pending = sent = 0;
	return 1;
}

static void u32le(uint8_t *p, uint32_t value)
{
	for (unsigned i=0; i<4; i++) p[i] = value >> (i*8);
}
void rea_stream_poll(void){if(stream!=REA_INVALID&&pending)flush_packet();}
static uint8_t *copy_words(uint8_t *p, const uint16_t *src, unsigned count)
{
	for (unsigned i=0; i<count; i++) { *p++ = src[i] >> 8; *p++ = src[i]; }
	return p;
}
void rea_stream_capture(vdp_context *v, unsigned width, unsigned height, uint64_t sequence, time_t session)
{
	if (!ready_stream() || !flush_packet()) return;
	genesis_context *g = (genesis_context *)v->system;
	char header[4096], extras[384], catalog_extra[80] = "";
	rea_raster *r = v->rea_raster;
	rea_catalog *catalog = r ? r->catalog : NULL;
	int raster_valid = r && !r->unsupported;
	unsigned covered = 0, pixels = width * height;
	if (raster_valid) {
		for (unsigned y=0; y<height; y++) for (unsigned x=0; x<width; x++) {
			if (r->rgba[REA_SOURCE][((y+v->top_offset)*LINEBUF_SIZE+x)*4+3]) covered++;
		}
	}
	const system_media *media = current_media();
	int catalog_content = v->system->type == SYSTEM_GENESIS && media && !media->chain && !g->expansion && !g->mars;
	int catalog_supported = catalog && catalog_content && raster_valid
		&& catalog->mode == (width == LINEBUF_SIZE ? 2 : 1)
		&& !(v->regs[REG_MODE_4] & BIT_INTERLACE);
	unsigned catalog_bytes = catalog_supported ? catalog->run_count * REA_CATALOG_RUN_BYTES : 0;
	const char *catalog_state = !catalog ? "disabled" : !catalog_supported ? "unsupported"
		: catalog->partial || catalog->dropped || covered != pixels ? "partial" : "complete";
	if (catalog_supported) snprintf(catalog_extra, sizeof(catalog_extra),
		",{\"name\":\"catalog_runs\",\"length\":%u}", catalog_bytes);
	if (raster_valid) snprintf(extras, sizeof(extras),
		"[{\"name\":\"raster_rgba\",\"length\":%u},{\"name\":\"raster_samples\",\"length\":%u},{\"name\":\"raster_flags\",\"length\":%u}%s]",
		pixels*20,pixels*4,pixels,catalog_extra);
	else strcpy(extras, "[]");
	int length = snprintf(header, sizeof(header),
		"{\"metadata\":{\"schema\":1,\"id\":\"%llu-%u-%llu\",\"frame\":%u,"
		"\"vdp_cycles\":%u,\"cpu_cycles\":%u,\"width\":%u,\"height\":%u,"
		"\"nominal_hz\":%.6f,\"movie\":%s,"
		"\"border_left\":%u,\"border_top\":%u,\"active_height\":%u,"
		"\"mode5\":%s,\"interlace\":%s,\"sprite_collision_flag\":%s,"
		"\"catalog\":{\"version\":1,\"status\":\"%s\",\"row_origin\":%u,\"dropped_samples\":%u,\"mode\":%u,\"generation\":%u,\"single_cartridge\":%s},"
		"\"raster\":{\"valid\":%s,\"complete\":%s,\"covered_pixels\":%u,\"width\":%u,\"height\":%u,\"field_even\":%s,"
		"\"layers\":[\"sprites\",\"a\",\"b\",\"window\",\"source\"],\"point\":\"compositor inputs resolved at DAC slots\"}},"
		"\"lengths\":[24,65536,128,%u,65536,8192,%u],\"extra\":%s}",
		(unsigned long long)session, (unsigned)rea_pid(), (unsigned long long)sequence,
		v->frame, v->cycles, g->m68k->cycles, width, height,
		(double)g->normal_clock / (MCLKS_LINE * (v->flags2 & FLAG2_REGION_PAL ? 313 : 262)), rea_movie_metadata(), BORDER_LEFT,
		v->border_top, v->inactive_start,
		v->regs[REG_MODE_2] & BIT_MODE_5 ? "true":"false",
		v->regs[REG_MODE_4] & BIT_INTERLACE ? "true":"false",
		v->flags2 & FLAG2_SPRITE_COLLIDE ? "true":"false",
		catalog_state, v->top_offset, catalog ? catalog->dropped : 0, catalog ? catalog->mode : 0,
		catalog ? catalog->generation : 0,
		catalog_content ? "true" : "false",
		raster_valid ? "true":"false", raster_valid && covered == pixels ? "true":"false", covered, width,height,
		v->flags2 & FLAG2_EVEN_FIELD ? "true":"false",v->vsram_size*2, width*height*3,extras);
	if (length < 0 || length >= sizeof(header)) return;
	u32le(packet+4, length);
	uint8_t *p = packet+8;
	memcpy(p, header, length); p += length;
	memcpy(p, v->regs, 24); p += 24;
	memcpy(p, v->vdpmem, 65536); p += 65536;
	p = copy_words(p, v->cram, 64); p = copy_words(p, v->vsram, v->vsram_size);
	p = copy_words(p, g->work_ram, RAM_WORDS);
	memcpy(p, g->zram, 8192); p += 8192;
	for (unsigned y=0; y<height; y++) {
		pixel_t *row = (pixel_t *)((char *)v->fb+(y+v->top_offset)*v->output_pitch);
		for (unsigned x=0; x<width; x++) {
			pixel_t color = row[x];
#ifdef USE_RGB565
			*p++ = ((color>>11)&31)*255/31; *p++ = ((color>>5)&63)*255/63; *p++ = (color&31)*255/31;
#elif defined(USE_GLES)
			*p++ = color; *p++ = color>>8; *p++ = color>>16;
#else
			*p++ = color>>16; *p++ = color>>8; *p++ = color;
#endif
		}
	}
	if (raster_valid) {
		for (unsigned layer=0; layer<5; layer++) for (unsigned y=0; y<height; y++) {
			memcpy(p, r->rgba[layer]+(y+v->top_offset)*LINEBUF_SIZE*4, width*4); p+=width*4;
		}
		for (unsigned layer=0; layer<4; layer++) for (unsigned y=0; y<height; y++) {
			memcpy(p, r->samples[layer]+(y+v->top_offset)*LINEBUF_SIZE, width); p+=width;
		}
		for (unsigned y=0; y<height; y++) {
			memcpy(p, r->flags+(y+v->top_offset)*LINEBUF_SIZE, width); p+=width;
		}
	}
	if (catalog_bytes) {
		memcpy(p, catalog->runs, catalog_bytes);
		p += catalog_bytes;
	}
	pending = (unsigned)(p-packet); u32le(packet, pending-4);
	rea_movie_published(sequence,v->frame);
	flush_packet();
}
