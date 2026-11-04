/* MEGA REAPER - BlastEm portable launcher. GPL-3.0-or-later. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <wchar.h>
#include <strsafe.h>

#define PATH_CAP 32768
#define ID_COPY 101
#define ID_STOP 102
static const wchar_t *title=L"MEGA REAPER - BlastEm";
static wchar_t root[PATH_CAP],rom[PATH_CAP],url[128];
static HWND window,status;
static HANDLE job,mutex,server_log,emulator_log,input;
static PROCESS_INFORMATION server,emulator;
static DWORD startup_at,running_at,duration_ms;
static unsigned port=8765,phase;
static int headless,native_window,result,closing;

static void path(wchar_t *out,const wchar_t *suffix)
{
    if(FAILED(StringCchPrintfW(out,PATH_CAP,L"%s\\%s",root,suffix))) ExitProcess(2);
}
static int active(PROCESS_INFORMATION *p)
{
    DWORD code=0;
    return p->hProcess&&GetExitCodeProcess(p->hProcess,&code)&&code==STILL_ACTIVE;
}
static BOOL CALLBACK request_close(HWND candidate,LPARAM pid)
{
    DWORD owner=0;GetWindowThreadProcessId(candidate,&owner);
    if(owner==(DWORD)pid) PostMessageW(candidate,WM_CLOSE,0,0);
    return TRUE;
}
static void cleanup(void)
{
    if(active(&emulator)){
        EnumWindows(request_close,(LPARAM)emulator.dwProcessId);
        WaitForSingleObject(emulator.hProcess,2000);
    }
    /* Closing this job also covers a launcher crash/abnormal termination. */
    if(job){CloseHandle(job);job=NULL;}
    if(emulator.hProcess){WaitForSingleObject(emulator.hProcess,3000);CloseHandle(emulator.hProcess);emulator.hProcess=NULL;}
    if(server.hProcess){WaitForSingleObject(server.hProcess,3000);CloseHandle(server.hProcess);server.hProcess=NULL;}
    if(server_log){CloseHandle(server_log);server_log=NULL;}
    if(emulator_log){CloseHandle(emulator_log);emulator_log=NULL;}
    if(input){CloseHandle(input);input=NULL;}
}
static void fail(const wchar_t *message)
{
    result=1;
    if(!headless)MessageBoxW(window,message,title,MB_ICONERROR|MB_OK);
    else fwprintf(stderr,L"%s\n",message);
    if(window)PostMessageW(window,WM_CLOSE,0,0);
}
static int file_exists(const wchar_t *suffix)
{
    wchar_t value[PATH_CAP];path(value,suffix);
    DWORD attr=GetFileAttributesW(value);
    return attr!=INVALID_FILE_ATTRIBUTES&&!(attr&FILE_ATTRIBUTE_DIRECTORY);
}
static int another_emulator(void)
{
    HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
    if(snapshot==INVALID_HANDLE_VALUE)return 1;
    PROCESSENTRY32W entry={.dwSize=sizeof(entry)};int found=0;
    if(Process32FirstW(snapshot,&entry))do{
        if(!_wcsnicmp(entry.szExeFile,L"blastem",7)){found=1;break;}
    }while(Process32NextW(snapshot,&entry));
    CloseHandle(snapshot);return found;
}
static int port_free(unsigned number)
{
    SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    if(s==INVALID_SOCKET)return 0;
    int exclusive=1;
    setsockopt(s,SOL_SOCKET,SO_EXCLUSIVEADDRUSE,(char *)&exclusive,sizeof(exclusive));
    struct sockaddr_in address={0};address.sin_family=AF_INET;
    address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons(number);
    int ok=bind(s,(struct sockaddr *)&address,sizeof(address))==0;
    closesocket(s);return ok;
}
static int server_ready(void)
{
    SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    if(s==INVALID_SOCKET)return 0;
    u_long nonblocking=1;ioctlsocket(s,FIONBIO,&nonblocking);
    struct sockaddr_in address={0};address.sin_family=AF_INET;
    address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons(port);
    int ready=connect(s,(struct sockaddr *)&address,sizeof(address))==0;
    if(!ready){
        fd_set writable;FD_ZERO(&writable);FD_SET(s,&writable);
        struct timeval wait={0,1000};
        if(select(0,NULL,&writable,NULL,&wait)>0){
            int error=0,len=sizeof(error);
            ready=!getsockopt(s,SOL_SOCKET,SO_ERROR,(char *)&error,&len)&&!error;
        }
    }
    closesocket(s);return ready;
}
static HANDLE log_file(const wchar_t *name)
{
    wchar_t value[PATH_CAP];path(value,name);
    SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};
    HANDLE handle=CreateFileW(value,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    return handle==INVALID_HANDLE_VALUE?NULL:handle;
}
static int spawn(const wchar_t *executable,const wchar_t *argument,HANDLE log,int visible,PROCESS_INFORMATION *process)
{
    wchar_t filename[PATH_CAP],command[PATH_CAP];path(filename,executable);
    if(FAILED(StringCchPrintfW(command,PATH_CAP,L"\"%s\" %s",filename,argument)))return 0;
    STARTUPINFOW si={.cb=sizeof(si)};
    si.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.wShowWindow=visible?SW_SHOWNORMAL:SW_HIDE;
    si.hStdInput=input;si.hStdOutput=si.hStdError=log;
    if(!CreateProcessW(filename,command,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,root,&si,process))return 0;
    if(!AssignProcessToJobObject(job,process->hProcess)){
        TerminateProcess(process->hProcess,1);WaitForSingleObject(process->hProcess,3000);
        CloseHandle(process->hThread);CloseHandle(process->hProcess);ZeroMemory(process,sizeof(*process));return 0;
    }
    ResumeThread(process->hThread);CloseHandle(process->hThread);process->hThread=NULL;
    return 1;
}
static void copy_url(void)
{
    SIZE_T size=(wcslen(url)+1)*sizeof(wchar_t);HGLOBAL text=GlobalAlloc(GMEM_MOVEABLE,size);
    if(!text)return;
    void *bytes=GlobalLock(text);if(!bytes){GlobalFree(text);return;}
    memcpy(bytes,url,size);GlobalUnlock(text);
    if(OpenClipboard(window)){EmptyClipboard();if(!SetClipboardData(CF_UNICODETEXT,text))GlobalFree(text);CloseClipboard();}
    else GlobalFree(text);
}
static LRESULT CALLBACK procedure(HWND hwnd,UINT message,WPARAM w,LPARAM l)
{
    switch(message){
    case WM_COMMAND:
        if(LOWORD(w)==ID_COPY)copy_url();
        if(LOWORD(w)==ID_STOP)PostMessageW(hwnd,WM_CLOSE,0,0);
        return 0;
    case WM_TIMER:
        if(!active(&server)){fail(L"The REA server stopped. See logs\\server.log.");return 0;}
        if(phase==1){
            if(server_ready()){
                wchar_t argument[PATH_CAP];
                if(another_emulator()){fail(L"BlastEm is already running. Close it before starting MEGA REAPER.");return 0;}
                if(FAILED(StringCchPrintfW(argument,PATH_CAP,L"-g \"%s\"",rom))||!spawn(L"blastem-raster.exe",argument,emulator_log,native_window,&emulator)){
                    fail(L"Could not start BlastEm. Extract the entire ZIP and check logs\\emulator.log.");return 0;
                }
                phase=2;running_at=GetTickCount();
                SetWindowTextW(status,L"Running. Paste the URL below into the Codex in-app browser.\nClose this launcher or click Stop to end both processes.");
            }else if(GetTickCount()-startup_at>10000)fail(L"The REA server did not start in time. See logs\\server.log.");
        }else if(phase==2){
            if(!active(&emulator)){PostMessageW(hwnd,WM_CLOSE,0,0);return 0;}
            if(duration_ms&&GetTickCount()-running_at>=duration_ms)PostMessageW(hwnd,WM_CLOSE,0,0);
        }
        return 0;
    case WM_CLOSE:
        if(closing)return 0;
        closing=1;KillTimer(hwnd,1);SetWindowTextW(status,L"Stopping...");cleanup();DestroyWindow(hwnd);return 0;
    case WM_DESTROY:PostQuitMessage(result);return 0;
    case WM_ENDSESSION:if(w)cleanup();return 0;
    }
    return DefWindowProcW(hwnd,message,w,l);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR command,int show)
{
    (void)previous;(void)command;(void)show;
    int argc;wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
    for(int i=1;i<argc;i++){
        if(!wcscmp(argv[i],L"--headless"))headless=1;
        else if(!wcscmp(argv[i],L"--native-window"))native_window=1;
        else if(!wcscmp(argv[i],L"--port")&&i+1<argc){int n=_wtoi(argv[++i]);if(n<1||n>65534){LocalFree(argv);return 2;}port=n;}
        else if(!wcscmp(argv[i],L"--duration-ms")&&i+1<argc){int n=_wtoi(argv[++i]);if(n<1||n>3600000){LocalFree(argv);return 2;}duration_ms=n;}
        else if(!wcscmp(argv[i],L"--rom")&&i+1<argc)StringCchCopyW(rom,PATH_CAP,argv[++i]);
        else if(argv[i][0]!=L'-'&&!rom[0])StringCchCopyW(rom,PATH_CAP,argv[i]);
        else {LocalFree(argv);return 2;}
    }
    LocalFree(argv);
    if(headless&&(!rom[0]||native_window))return 2;
    if(headless&&!duration_ms)duration_ms=20000;
    if(!GetModuleFileNameW(NULL,root,PATH_CAP))return 2;
    wchar_t *slash=wcsrchr(root,L'\\');if(!slash)return 2;*slash=0;
    mutex=CreateMutexW(NULL,FALSE,L"Local\\MEGA_REAPER_BlastEm_Launcher");
    if(!mutex||GetLastError()==ERROR_ALREADY_EXISTS){if(!headless)MessageBoxW(NULL,L"MEGA REAPER is already running.",title,MB_ICONINFORMATION);if(mutex)CloseHandle(mutex);return 1;}
    if(!file_exists(L"blastem-raster.exe")||!file_exists(L"SDL2.dll")||!file_exists(L"runtime\\node.exe")||!file_exists(L"rea\\server.mjs")||!file_exists(L"rea\\node_modules\\ws\\index.js")){
        if(!headless)MessageBoxW(NULL,L"Required files are missing. Extract the entire Windows ZIP before launching.",title,MB_ICONERROR);
        CloseHandle(mutex);return 1;
    }
    if(!rom[0]){
        OPENFILENAMEW picker={.lStructSize=sizeof(picker),.hInstance=instance,.lpstrFile=rom,.nMaxFile=PATH_CAP,
            .lpstrFilter=L"Genesis / Mega Drive ROMs\0*.md;*.bin;*.gen;*.smd\0All files\0*.*\0",.lpstrTitle=L"Select a local Genesis / Mega Drive ROM",
            .Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR};
        if(!GetOpenFileNameW(&picker)){CloseHandle(mutex);return 0;}
    }
    wchar_t absolute[PATH_CAP];DWORD size=GetFullPathNameW(rom,PATH_CAP,absolute,NULL);
    if(!size||size>=PATH_CAP||GetFileAttributesW(absolute)==INVALID_FILE_ATTRIBUTES){CloseHandle(mutex);return 2;}
    StringCchCopyW(rom,PATH_CAP,absolute);
    WSADATA ws;if(WSAStartup(MAKEWORD(2,2),&ws)){CloseHandle(mutex);return 1;}
    if(another_emulator()||!port_free(port)||!port_free(port+1)){
        if(!headless)MessageBoxW(NULL,L"BlastEm is already running or an inspector port is occupied. Close the existing instance, or use --port NUMBER.",title,MB_ICONINFORMATION);
        WSACleanup();CloseHandle(mutex);return 1;
    }
    job=CreateJobObjectW(NULL,NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){if(job)CloseHandle(job);WSACleanup();CloseHandle(mutex);return 1;}
    wchar_t value[PATH_CAP];path(value,L"logs");CreateDirectoryW(value,NULL);
    server_log=log_file(L"logs\\server.log");emulator_log=log_file(L"logs\\emulator.log");
    SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};input=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(!server_log||!emulator_log||input==INVALID_HANDLE_VALUE){if(input==INVALID_HANDLE_VALUE)input=NULL;cleanup();WSACleanup();CloseHandle(mutex);return 1;}
    StringCchPrintfW(value,PATH_CAP,L"%u",port);SetEnvironmentVariableW(L"PORT",value);
    StringCchPrintfW(value,PATH_CAP,L"%u",port+1);SetEnvironmentVariableW(L"BLASTEM_REA_STREAM_PORT",value);
    SetEnvironmentVariableW(L"BLASTEM_REA_CAPTURE_EVERY",L"1");SetEnvironmentVariableW(L"BLASTEM_REA_BROWSER_ONLY",native_window?L"0":L"1");
    path(value,L"rea\\session");SetEnvironmentVariableW(L"BLASTEM_REA_DIR",value);
    StringCchPrintfW(url,128,L"http://127.0.0.1:%u/",port);
    SetProcessDPIAware();
    WNDCLASSW wc={.lpfnWndProc=procedure,.hInstance=instance,.lpszClassName=L"MEGA_REAPER_Launcher",.hCursor=LoadCursor(NULL,IDC_ARROW),.hbrBackground=(HBRUSH)(COLOR_WINDOW+1)};
    RegisterClassW(&wc);
    window=CreateWindowW(wc.lpszClassName,title,WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,CW_USEDEFAULT,CW_USEDEFAULT,590,235,NULL,NULL,instance,NULL);
    if(!window){cleanup();WSACleanup();CloseHandle(mutex);return 1;}
    status=CreateWindowW(L"STATIC",L"Starting the local REA server...",WS_CHILD|WS_VISIBLE,20,18,545,62,window,NULL,instance,NULL);
    HWND edit=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",url,WS_CHILD|WS_VISIBLE|ES_READONLY|ES_AUTOHSCROLL,20,85,350,29,window,NULL,instance,NULL);
    HWND copy=CreateWindowW(L"BUTTON",L"Copy inspector URL",WS_CHILD|WS_VISIBLE|WS_TABSTOP,385,84,168,31,window,(HMENU)ID_COPY,instance,NULL);
    HWND stop=CreateWindowW(L"BUTTON",L"Stop and close",WS_CHILD|WS_VISIBLE|WS_TABSTOP,385,137,168,32,window,(HMENU)ID_STOP,instance,NULL);
    HWND note=CreateWindowW(L"STATIC",L"One emulator. Six captured views.\nNo ROM is uploaded.",WS_CHILD|WS_VISIBLE,20,137,350,42,window,NULL,instance,NULL);
    HWND controls[]={status,edit,copy,stop,note};for(unsigned i=0;i<5;i++)SendMessageW(controls[i],WM_SETFONT,(WPARAM)GetStockObject(DEFAULT_GUI_FONT),TRUE);
    if(!headless){ShowWindow(window,SW_SHOWNORMAL);UpdateWindow(window);}
    path(value,L"rea\\server.mjs");wchar_t argument[PATH_CAP];StringCchPrintfW(argument,PATH_CAP,L"\"%s\"",value);
    if(!spawn(L"runtime\\node.exe",argument,server_log,0,&server))fail(L"Could not start the bundled Node.js runtime. Extract the entire ZIP.");
    else {phase=1;startup_at=GetTickCount();SetTimer(window,1,100,NULL);}
    MSG message;while(GetMessageW(&message,NULL,0,0)>0){if(!IsDialogMessageW(window,&message)){TranslateMessage(&message);DispatchMessageW(&message);}}
    WSACleanup();CloseHandle(mutex);return result;
}
