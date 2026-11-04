"""Generate an original diagnostic ROM; no commercial ROM/assets required.
Run with an installed Python 3 interpreter.
"""
from pathlib import Path
import struct
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--raster-tests',action='store_true')
parser.add_argument('--h32',action='store_true')
args=parser.parse_args();raster_tests=args.raster_tests

out = bytearray(128 * 1024)
def put(a, data):
    out[a:a+len(data)] = data
put(0, struct.pack('>II', 0xFFFF00, 0x200))
put(0x100, b'SEGA MEGA DRIVE  ')
put(0x120, b'REA ORIGINAL INSPECTION TEST'.ljust(48))
put(0x150, b'REA ORIGINAL INSPECTION TEST'.ljust(48))
put(0x180, b'GM 00000000-00')
put(0x190, b'J               ')
put(0x1A0, struct.pack('>IIII', 0, len(out)-1, 0xFF0000, 0xFFFFFF))
put(0x1F0, b'JUE             ')
code = bytearray()
def w(v): code.extend(struct.pack('>H', v))
def l(v): code.extend(struct.pack('>I', v))
def move(v, a, size=2):
    w(0x33FC if size == 2 else 0x23FC)
    (w if size == 2 else l)(v)
    l(a)
def reg(r,v): move(0x8000 | (r << 8) | v, 0xC00004)
def vram(a): move(0x40000000 | ((a & 0x3FFF) << 16) | (a >> 14), 0xC00004, 4)
w(0x46FC); w(0x2700) # mask interrupts
# Default md1va3 model has no TMSS register; do not write an unmapped port.
for r,v in [(0,4),(1,4),(2,0x30),(3,0x2C),(4,7),(5,0x6C),(7,0),(11,0),(12,0 if args.h32 else 0x81),(13,0x3F),(15,2),(16,1),(17,0),(18,0)]: reg(r,v)
move(0xC0000000,0xC00004,4)
for i in range(64): move([0,0x000E,0x00E0,0x0E00][i%4],0xC00000)
vram(0)
for value in ([0,0x1111,0x2222,0x3333,0xEEEE,0xFFFF] if raster_tests else [0,0x1111,0x2222,0x3333]):
    for _ in range(16): move(value,0xC00000)
for addr,tile in ([(0xB000,2),(0xC000,0),(0xE000,1)] if raster_tests else [(0xC000,0),(0xE000,1)]):
    vram(addr)
    for index in range(64*32):
        value=tile
        if raster_tests and addr==0xE000:
            value=1 if index%2==0 else 3
            if index%64 in [10,11,12]:value|=0x8000
        move(value,0xC00000)
vram(0xC000+(9*64+12)*2);move(2,0xC00000)
vram(0xD800)
if raster_tests:
    for index in range(23):
        values=([128+64,index+1,3,128+index*12] if index<21 else
            [128+100,22,0xE004,128+80] if index==21 else [128+120,0,0xE005,128+100])
        for value in values:move(value,0xC00000)
else:
    for value in [128+60,0,3,128+80]:move(value,0xC00000)
vram(0xFC00);move(0,0xC00000);move(0,0xC00000)
move(0x40000010,0xC00004,4) # VSRAM write address 0
move(0,0xC00000);move(0,0xC00000)
if raster_tests:reg(17,0x90);reg(12,8 if args.h32 else 0x89) # Window x>=256; shadow/highlight
reg(1,0x44) # enable Mode 5 display
move(0x52454131,0xFF0010,4) # known bus-order sentinel 'REA1'
if raster_tests:
    def wait_line(line):
        w(0x3039);l(0xC00008) # move.w HV counter,d0
        w(0x0240);w(0xFF00) # andi.w
        w(0x0C40);w(line<<8) # cmpi.w
        w(0x66F0) # bne.s back to HV read
    loop=len(code)
    wait_line(224)
    move(0xC0020000,0xC00004,4);move(0x000E,0xC00000) # red at VBLANK
    vram(0xFC02);move(0,0xC00000)
    vram(32)
    for _ in range(16):move(0x1111,0xC00000) # restore tile 1 after visible scanout
    reg(17,0x90)
    wait_line(0);wait_line(112)
    w(0x3039);l(0xC00008);w(0x0240);w(0x00FF);w(0x0C40);w(0x0080);w(0x64F0) # wait for active horizontal slots
    move(0xC0020000,0xC00004,4);move(0x00E0,0xC00000) # green at raster line 112
    vram(0xFC02);move(8,0xC00000) # shift B by one tile mid-frame
    wait_line(144);reg(17,4) # Window switches from right 64px to left 64px
    wait_line(176);vram(32)
    for _ in range(16):move(0,0xC00000) # blank tile 1 during the bottom of the frame
    w(0x6000);w((loop-len(code))&0xFFFF)
else:
    w(0x52B9);l(0xFF0000);w(0x60F8) # increment RAM counter forever
put(0x200,code)
checksum=sum(struct.unpack('>'+str((len(out)-0x200)//2)+'H',out[0x200:]))&65535
put(0x18E,struct.pack('>H',checksum))
dest=Path(__file__).parent/'test-output'/(('raster-test' if raster_tests else 'inspection-test')+('-h32' if args.h32 else '')+'.bin')
dest.parent.mkdir(exist_ok=True)
dest.write_bytes(out)
print(dest)
