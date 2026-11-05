/* GPL-3.0-or-later. Movies are local checkpoints + frame-latched pad masks.
 * State serialization/deserialization ONLY runs from the outer paused loop,
 * never recursively from an executing CPU/VDP callback. */
#include "rea_movie.h"
#ifdef IS_LIB
void rea_movie_poll(void){}
void rea_movie_service(void){}
void rea_movie_frame(void){}
void rea_movie_capture(vdp_context *v,unsigned width){}
int rea_movie_input(unsigned port,unsigned button,int down){return 0;}
const char *rea_movie_metadata(void){return "null";}
int rea_movie_active(void){return 0;}
void rea_movie_reset(void){}
void rea_movie_published(uint64_t sequence,unsigned frame){}
#else
#include "blastem.h"
#include "genesis.h"
#include "io.h"
#include "net.h"
#include "render.h"
#include "kit_script.h"
#include "hash.h"
#include "config.h"
#include "rea_raster.h"
#include "rea_stream.h"
#include "zlib/zlib.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#include <winsock2.h>
#include <windows.h>
typedef SOCKET movie_socket;
#define BAD_SOCKET INVALID_SOCKET
#define close_socket closesocket
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <fcntl.h>
typedef int movie_socket;
#define BAD_SOCKET -1
#define close_socket close
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
static movie_socket listener=BAD_SOCKET,client=BAD_SOCKET;
static unsigned initialized,speed=100,position,total,mode,applying,servicing;
static unsigned short held[2],latched[2];
static unsigned crc,desync;
static FILE *recording;
static unsigned char *playback;
static char movie_id[65],pending[128],error_text[128];
static const char *modes[]={"idle","recording","playback","ended"};
static unsigned char rom_hash[20],build_hash[20];
static int identified;
static unsigned rom_generation,execution_generation,run_remaining,run_completed,run_total,last_capture_frame,run_p1,run_p2;
static uint64_t last_capture_sequence;
static unsigned char config_identity[20];
static unsigned get32(const unsigned char *b){return b[0]|b[1]<<8|b[2]<<16|(unsigned)b[3]<<24;}
static void put32(unsigned char *b,unsigned n){for(unsigned i=0;i<4;i++)b[i]=n>>(i*8);}
static FILE *open_file(const char *name,const char *access)
{
#ifdef _WIN32
    wchar_t wide[4096],flags[8];
    if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,name,-1,wide,4096))return NULL;
    MultiByteToWideChar(CP_UTF8,0,access,-1,flags,8);return _wfopen(wide,flags);
#else
    return fopen(name,access);
#endif
}
static FILE *new_file(const char *name)
{
#ifdef _WIN32
    wchar_t wide[4096];
    if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,name,-1,wide,4096))return NULL;
    HANDLE handle=CreateFileW(wide,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
    if(handle==INVALID_HANDLE_VALUE)return NULL;
    int fd=_open_osfhandle((intptr_t)handle,_O_BINARY|_O_WRONLY);
    if(fd<0){CloseHandle(handle);return NULL;}
    FILE *file=_fdopen(fd,"wb");if(!file)_close(fd);return file;
#else
    int fd=open(name,O_CREAT|O_EXCL|O_WRONLY,0666);if(fd<0)return NULL;
    FILE *file=fdopen(fd,"wb");if(!file)close(fd);return file;
#endif
}
static int storage_path(char *out,size_t size,const char *group,const char *id,const char *file)
{
    const char *root=getenv("BLASTEM_REA_DIR");
#ifdef _WIN32
    wchar_t wide[4096];char utf8[8192];
    if(GetEnvironmentVariableW(L"BLASTEM_REA_DIR",wide,4096)&&WideCharToMultiByte(CP_UTF8,0,wide,-1,utf8,sizeof(utf8),NULL,NULL))root=utf8;
#endif
    if(!root||!*root||!id||!id[0]||strlen(id)>64)return 0;
    for(const char *p=id;*p;p++)if(!isalnum((unsigned char)*p)&&*p!='-')return 0;
    return snprintf(out,size,"%s/%s/%s/%s",root,group,id,file)<(int)size;
}
static int movie_path(char *out,size_t size,const char *id,const char *file){return storage_path(out,size,"movies",id,file);}
static unsigned char *read_all(FILE *f,size_t *size)
{
    if(!f)return NULL;
    if(fseek(f,0,SEEK_END)||ftell(f)<0){fclose(f);return NULL;}
    long n=ftell(f);rewind(f);
    if(n>32*1024*1024){fclose(f);return NULL;}
    unsigned char *data=malloc(n?n:1);
    if(!data||fread(data,1,n,f)!=(size_t)n){free(data);fclose(f);return NULL;}
    fclose(f);*size=n;return data;
}
static int identify(void)
{
    if(identified)return 1;
    const system_media *media=current_media();
    if(!media||!media->buffer)return 0;
    sha1(media->buffer,media->size,rom_hash);
    FILE *f=NULL;
#ifdef _WIN32
    wchar_t executable[4096];
    if(GetModuleFileNameW(NULL,executable,4096))f=_wfopen(executable,L"rb");
#else
    f=fopen("/proc/self/exe","rb");
#endif
    size_t size;unsigned char *bytes=read_all(f,&size);
    if(!bytes)return 0;
    sha1(bytes,size,build_hash);free(bytes);identified=1;return 1;
}
static void configuration_hash(unsigned char *out)
{
    unsigned char inputs[48]={0};uint32_t size;
    char *text=serialize_config(config,&size);sha1((unsigned char *)text,size,inputs);free(text);
    text=serialize_config(get_model(config,SYSTEM_GENESIS),&size);sha1((unsigned char *)text,size,inputs+20);free(text);
    genesis_context *g=(genesis_context *)current_system;
    put32(inputs+40,g->normal_clock);inputs[44]=g->version_reg;inputs[45]=g->io.ports[0].device_type;inputs[46]=g->io.ports[1].device_type;inputs[47]=g->mapper_type;
    sha1(inputs,sizeof(inputs),out);
}
static void finish(void)
{
    if(recording){fflush(recording);fclose(recording);recording=NULL;}
    free(playback);playback=NULL;
}
int rea_movie_active(void){return mode!=0||run_remaining!=0;}
void rea_movie_reset(void)
{
    finish();mode=position=total=desync=identified=0;movie_id[0]=error_text[0]=0;
    rom_generation++;execution_generation++;run_remaining=run_completed=run_total=0;last_capture_sequence=0;
    memset(held,0,sizeof(held));memset(latched,0,sizeof(latched));
}
void rea_movie_published(uint64_t sequence,unsigned frame){last_capture_sequence=sequence;last_capture_frame=frame;}
static int supported(void);
const char *rea_movie_metadata(void)
{
    static char json[2048];char rom[41]={0},build[41]={0},configuration[41]={0},name[128]="Genesis / Mega Drive";
    unsigned frame=0;
    if(current_system&&current_system->type==SYSTEM_GENESIS){
        frame=((genesis_context *)current_system)->vdp->frame;
        if(identify())for(unsigned i=0;i<20;i++){sprintf(rom+i*2,"%02x",rom_hash[i]);sprintf(build+i*2,"%02x",build_hash[i]);sprintf(configuration+i*2,"%02x",config_identity[i]);}
        const char *title=current_system->info.name;if(title){unsigned i=0;for(;title[i]&&i<sizeof(name)-1;i++)name[i]=(title[i]>=32&&title[i]<127&&title[i]!='"'&&title[i]!='\\')?title[i]:'?';name[i]=0;}
    }
    snprintf(json,sizeof(json),"{\"protocol\":2,\"id\":\"%s\",\"mode\":\"%s\",\"frame\":%u,\"length\":%u,\"paused\":%s,\"speed\":%u,\"desync\":%s,\"error\":\"%s\",\"rom_name\":\"%s\",\"rom_sha1\":\"%s\",\"build_sha1\":\"%s\",\"configuration_sha1\":\"%s\",\"rom_generation\":%u,\"generation\":%u,\"machine_frame\":%u,\"capture_frame\":%u,\"capture_sequence\":%llu,\"experiment_remaining\":%u,\"experiment_completed\":%u,\"experiment_total\":%u}",
        movie_id,modes[mode],position,total,current_system&&current_system->paused?"true":"false",speed,desync?"true":"false",error_text,name,rom,build,configuration,rom_generation,execution_generation,frame,last_capture_frame,(unsigned long long)last_capture_sequence,run_remaining,run_completed,run_total);
    return json;
}
static void reply(const char *error)
{
    char output[4096];
    int n=snprintf(output,sizeof(output),"{\"ok\":%s,\"error\":\"%s\",\"state\":%s}\n",error?"false":"true",error?error:"",rea_movie_metadata());
    if(client!=BAD_SOCKET){send(client,output,n,MSG_NOSIGNAL);close_socket(client);client=BAD_SOCKET;}
}
static void pause_machine(void)
{
    current_system->paused=1;system_request_exit(current_system,1);
}
int rea_movie_input(unsigned port,unsigned button,int down)
{
    if(port<1||port>2||button<DPAD_UP||button>BUTTON_MODE)return mode!=0;
    if(applying)return 0;
    if(run_remaining)return 1;
    if(mode==2||mode==3)return 1;
    unsigned short bit=1u<<button;
    if(down)held[port-1]|=bit;else held[port-1]&=~bit;
    return mode==1;
}
static void apply_masks(const unsigned short *masks)
{
    applying=1;
    for(unsigned p=0;p<2;p++)for(unsigned b=DPAD_UP;b<=BUTTON_MODE;b++){
        if(masks[p]&(1u<<b))current_system->gamepad_down(current_system,p+1,b);
        else current_system->gamepad_up(current_system,p+1,b);
    }
    applying=0;memcpy(latched,masks,sizeof(latched));
}
void rea_movie_capture(vdp_context *v,unsigned width)
{
    if(!mode||servicing)return;
    genesis_context *g=(genesis_context *)v->system;
    crc=crc32(0,(const unsigned char *)g->work_ram,RAM_WORDS*2);
    crc=crc32(crc,v->vdpmem,65536);
    crc=crc32(crc,(const unsigned char *)v->cram,sizeof(v->cram));
    crc=crc32(crc,g->zram,Z80_RAM_BYTES);
    crc=crc32(crc,v->regs,VDP_REGS);
    crc=crc32(crc,(const unsigned char *)v->vsram,v->vsram_size*2);
    /* Frame zero can contain pixels from before the checkpoint. Subsequent
     * complete RGB frames are checked as well as RAM/VRAM/CRAM. */
    if(position)for(unsigned y=0;y<v->output_lines;y++){
        const pixel_t *row=(const pixel_t *)((char *)v->fb+(y+v->top_offset)*v->output_pitch);
        crc=crc32(crc,(const unsigned char *)row,width*sizeof(pixel_t));
    }
    if(mode==2&&position<total&&crc!=get32(playback+56+position*8+4)){
        desync=1;strcpy(error_text,"Replay differs from recorded render or memory");pause_machine();
    }
}
void rea_movie_frame(void)
{
    if(servicing||!current_system||current_system->type!=SYSTEM_GENESIS)return;
    if(mode==1){
        unsigned char row[8]={held[0],held[0]>>8,held[1],held[1]>>8};put32(row+4,crc);
        if(fwrite(row,1,8,recording)!=8){strcpy(error_text,"Movie write failed");finish();mode=3;pause_machine();return;}
        if(!(position%60))fflush(recording);
        apply_masks(held);total=++position;
    }else if(mode==2){
        if(desync||position+1>=total){mode=3;pause_machine();return;}
        unsigned char *row=playback+56+position*8;
        unsigned short masks[2]={row[0]|row[1]<<8,row[2]|row[3]<<8};
        apply_masks(masks);position++;
    }
    if(run_remaining){run_remaining--;run_completed++;if(!run_remaining){apply_masks((unsigned short[2]){0,0});pause_machine();}}
}
static int supported(void)
{
    if(!current_system||current_system->type!=SYSTEM_GENESIS||!current_system->serialize||!current_system->deserialize)return 0;
    genesis_context *g=(genesis_context *)current_system;
    if(current_media()&&current_media()->chain)return 0;
    if(g->expansion||g->mars||g->mapper_type==MAPPER_JCART)return 0;
    for(unsigned i=0;i<3;i++)if(g->io.ports[i].device_type!=IO_NONE&&g->io.ports[i].device_type!=IO_GAMEPAD3&&g->io.ports[i].device_type!=IO_GAMEPAD6)return 0;
    return identify();
}
static void restore_checkpoint(unsigned char *data,size_t size)
{
    current_system->deserialize(current_system,data+20,size-20);
    genesis_context *g=(genesis_context *)current_system;
    /* Native save states omit host-side frame assembly and scheduling caches.
     * Normalize them identically for recording and replay, and discard the
     * pre-checkpoint partial presentation instead of shifting the movie a frame. */
    g->last_frame=g->vdp->frame;g->last_flush_cycle=g->m68k->cycles;
    g->int_latency_prev1=g->int_latency_prev2=0;
    g->frame_end=vdp_cycles_to_frame_end(g->vdp);
    g->m68k->sync_cycle=g->m68k->target_cycle=g->m68k->cycles+1;
    g->vdp->output_lines=g->vdp->h40_lines=0;g->vdp->pushed_frame=1;
    g->vdp->output=g->vdp->fb=NULL;rea_raster_clear(g->vdp);
    execution_generation++;
}
void rea_movie_service(void)
{
    if(!pending[0])return;
    char operation[16]={0},id[65]={0},filename[4096];
    sscanf(pending,"%15s %64s",operation,id);pending[0]=0;
    if(!strcmp(operation,"capture")){rea_stream_poll();reply(last_capture_sequence?NULL:"No completed REA capture is available yet");return;}
    if(!supported()){reply("Movies require a standard Genesis cartridge and 3/6-button pads");return;}
    if(!strcmp(operation,"run")){
        if(mode){reply("Stop the movie before running a controlled experiment");return;}
        unsigned count,p1,p2;if(sscanf(id,"%u",&count)!=1||count<1||count>3600){reply("Invalid bounded experiment");return;}
        p1=run_p1;p2=run_p2;
        run_remaining=run_total=count;run_completed=0;apply_masks((unsigned short[2]){p1,p2});
        current_system->frame_advance=0;current_system->paused=0;reply(NULL);return;
    }
    if(!strcmp(operation,"cp_save")||!strcmp(operation,"cp_restore")){
        if(mode){reply("Stop the movie before saving or restoring an experiment checkpoint");return;}
        if(!storage_path(filename,sizeof(filename),"checkpoints",id,"checkpoint.rmc")){reply("Invalid checkpoint ID");return;}
        servicing=1;
        if(!strcmp(operation,"cp_save")){
            FILE *file=new_file(filename);if(!file){servicing=0;reply("Checkpoint exists or is not writable");return;}
            size_t core_size;unsigned char *core=current_system->serialize(current_system,&core_size),*data=malloc(core_size+20);
            if(!data){free(core);fclose(file);servicing=0;reply("Checkpoint allocation failed");return;}
            configuration_hash(data);memcpy(config_identity,data,20);memcpy(data+20,core,core_size);free(core);
            unsigned char header[56]={0};memcpy(header,"RMCP0001",8);memcpy(header+8,rom_hash,20);memcpy(header+28,build_hash,20);put32(header+48,core_size+20);put32(header+52,crc32(0,data,core_size+20));
            int ok=fwrite(header,1,56,file)==56&&fwrite(data,1,core_size+20,file)==core_size+20;if(fclose(file))ok=0;
            if(ok)restore_checkpoint(data,core_size+20);free(data);servicing=0;current_system->paused=1;reply(ok?NULL:"Checkpoint write failed");return;
        }
        size_t size;unsigned char *data=read_all(open_file(filename,"rb"),&size),configuration[20];configuration_hash(configuration);
        int ok=data&&size>76&&!memcmp(data,"RMCP0001",8)&&!memcmp(data+8,rom_hash,20)&&!memcmp(data+28,build_hash,20)&&get32(data+48)==size-56&&get32(data+52)==crc32(0,data+56,size-56)&&!memcmp(data+56,configuration,20);
        if(ok){restore_checkpoint(data+56,size-56);memcpy(config_identity,configuration,20);memset(held,0,sizeof(held));movie_id[0]=error_text[0]=0;position=total=desync=0;}
        free(data);servicing=0;current_system->paused=1;reply(ok?NULL:"Checkpoint is incompatible or damaged");return;
    }
    if(!movie_path(filename,sizeof(filename),id,"inputs.rmt")){reply("Invalid movie ID");return;}
    if(mode==1){reply("Stop recording before starting another movie");return;}
    servicing=1;
    if(!strcmp(operation,"record")){
        FILE *f=new_file(filename);
        if(!f){servicing=0;reply("Movie exists or is not writable");return;}
        size_t core_size;unsigned char *core=current_system->serialize(current_system,&core_size);
        size_t size=core_size+20;unsigned char *state=malloc(size);
        if(!state){free(core);fclose(f);servicing=0;reply("Checkpoint allocation failed");return;}
        configuration_hash(state);memcpy(config_identity,state,20);memcpy(state+20,core,core_size);free(core);
        unsigned char header[56]={0};memcpy(header,"RMTAS001",8);memcpy(header+8,rom_hash,20);memcpy(header+28,build_hash,20);put32(header+48,size);put32(header+52,crc32(0,state,size));
        movie_path(filename,sizeof(filename),id,"start.state");FILE *start=new_file(filename);
        int ok=start&&fwrite(state,1,size,start)==size;
        if(start&&fclose(start))ok=0;
        if(ok)restore_checkpoint(state,size);
        free(state);
        if(fwrite(header,1,56,f)!=56)ok=0;
        if(!ok){fclose(f);servicing=0;reply("Could not write movie checkpoint");return;}
        finish();recording=f;mode=1;position=total=desync=0;error_text[0]=0;strcpy(movie_id,id);
        kit_script_load(NULL);memcpy(latched,held,sizeof(held));
    }else{
        size_t size;unsigned char *data=read_all(open_file(filename,"rb"),&size);
        if(!data||size<64||(size-56)%8||memcmp(data,"RMTAS001",8)||memcmp(data+8,rom_hash,20)||memcmp(data+28,build_hash,20)){
            free(data);servicing=0;reply("Movie is empty or requires the exact recorded ROM and emulator build");return;
        }
        movie_path(filename,sizeof(filename),id,"start.state");size_t state_size;
        unsigned char *state=read_all(open_file(filename,"rb"),&state_size);
        unsigned char config_hash[20];configuration_hash(config_hash);
        if(!state||state_size<=20||state_size!=get32(data+48)||crc32(0,state,state_size)!=get32(data+52)||memcmp(state,config_hash,20)){
            free(state);free(data);servicing=0;reply("Movie checkpoint is damaged or emulator configuration differs");return;
        }
        finish();kit_script_load(NULL);
        restore_checkpoint(state,state_size);free(state);
        playback=data;total=(size-56)/8;position=desync=0;mode=2;error_text[0]=0;strcpy(movie_id,id);
    }
    servicing=0;current_system->frame_advance=0;current_system->paused=0;reply(NULL);
}
static void command(char *line)
{
    if(!current_system){reply("No active emulator");return;}
    if(!strcmp(line,"status")){reply(NULL);return;}
    if(!strcmp(line,"describe")){
        if(supported())configuration_hash(config_identity);
        char output[4096];const char *metadata=rea_movie_metadata();int n=snprintf(output,sizeof(output),"{\"ok\":true,\"state\":%.*s,\"movie_supported\":%s,\"movie_reason\":\"%s\"}}\n",(int)strlen(metadata)-1,metadata,supported()?"true":"false",supported()?"":"Movie/checkpoint support requires a standard Genesis cartridge and 3/6-button pads");
        if(client!=BAD_SOCKET){send(client,output,n,MSG_NOSIGNAL);close_socket(client);client=BAD_SOCKET;}return;
    }
    if(!strcmp(line,"pause")||!strcmp(line,"capture")){
        if(run_remaining){run_remaining=0;apply_masks((unsigned short[2]){0,0});}
        pause_machine();if(!strcmp(line,"capture"))strcpy(pending,"capture");else reply(NULL);return;
    }
    if(!strcmp(line,"play")||!strcmp(line,"step")){
        if(desync||mode==3){reply("Restart replay or stop the movie first");return;}
        current_system->frame_advance=!strcmp(line,"step");current_system->paused=0;reply(NULL);return;
    }
    if(!strcmp(line,"stop")){
        pause_machine();finish();mode=run_remaining=desync=0;error_text[0]=0;apply_masks((unsigned short[2]){0,0});memset(held,0,sizeof(held));reply(NULL);return;
    }
    unsigned value,port,down,button;
    if(sscanf(line,"speed %u",&value)==1){
        if(value!=25&&value!=50&&value!=100&&value!=200&&value!=400){reply("Invalid speed");return;}
        speed=value;current_system->set_speed_percent(current_system,value);render_set_speed_percent(value);reply(NULL);return;
    }
    if(sscanf(line,"pad %u %u %u",&port,&button,&down)==3&&port>=1&&port<=2&&button>=DPAD_UP&&button<=BUTTON_MODE&&down<=1){
        if(mode==2||mode==3){reply("Controller input is locked during playback");return;}
        if(down)current_system->gamepad_down(current_system,port,button);else current_system->gamepad_up(current_system,port,button);reply(NULL);return;
    }
    unsigned count,p1,p2;
    if(sscanf(line,"run %u %u %u",&count,&p1,&p2)==3){
        if(!count||count>3600||p1>8190||p2>8190||(p1&1)||(p2&1)){reply("Invalid experiment bounds or controller masks");return;}
        run_p1=p1;run_p2=p2;
        snprintf(pending,sizeof(pending),"run %u",count);pause_machine();return;
    }
    if(!strncmp(line,"record ",7)||!strncmp(line,"replay ",7)||!strncmp(line,"cp_save ",8)||!strncmp(line,"cp_restore ",11)){
        if(run_remaining){reply("Pause the bounded experiment before changing its starting state");return;}
        strncpy(pending,line,sizeof(pending)-1);pause_machine();return;
    }
    reply("Unknown movie command");
}
void rea_movie_poll(void)
{
    rea_stream_poll();
    static char buffer[256];static unsigned used;
    static uint32_t client_started;
    if(!initialized){
        initialized=1;const char *setting=getenv("BLASTEM_REA_CONTROL_PORT");if(!setting)return;
        unsigned port=atoi(setting);if(!port||port>65535)return;
        socket_init();listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(listener==BAD_SOCKET)return;
        struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);addr.sin_port=htons(port);
        if(bind(listener,(struct sockaddr *)&addr,sizeof(addr))||listen(listener,4)){close_socket(listener);listener=BAD_SOCKET;return;}
#ifdef _WIN32
        u_long flag=1;ioctlsocket(listener,FIONBIO,&flag);
#else
        fcntl(listener,F_SETFL,fcntl(listener,F_GETFL,0)|O_NONBLOCK);
#endif
    }
    if(listener==BAD_SOCKET||pending[0])return;
    if(client==BAD_SOCKET){client=accept(listener,NULL,NULL);used=0;if(client==BAD_SOCKET)return;client_started=render_elapsed_ms();
#ifdef _WIN32
        u_long flag=1;ioctlsocket(client,FIONBIO,&flag);
#else
        fcntl(client,F_SETFL,fcntl(client,F_GETFL,0)|O_NONBLOCK);
#endif
    }
    if(render_elapsed_ms()-client_started>5000){reply("Incomplete command timed out");return;}
    int n=recv(client,buffer+used,sizeof(buffer)-1-used,0);
    if(n>0){used+=n;buffer[used]=0;char *end=strchr(buffer,'\n');if(end){*end=0;command(buffer);}else if(used==sizeof(buffer)-1)reply("Command too long");}
    else if(!n||(n<0&&!socket_error_is_wouldblock())){close_socket(client);client=BAD_SOCKET;}
}
#endif
