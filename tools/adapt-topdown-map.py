from pathlib import Path
import argparse
import struct
import json
import zipfile
from PIL import Image
ap=argparse.ArgumentParser();ap.add_argument('--directory',type=Path,required=True);ap.add_argument('--classic-core',action='store_true');args=ap.parse_args();root=args.directory
p=root/'map.yaml';text=p.read_text().replace('RequiresMod: rtsai','RequiresMod: rtsai-classic-core' if args.classic_core else 'RequiresMod: rtsai-topdown')
if args.classic_core: text=text.replace('Tileset: TEMPERATE','Tileset: TEMPERAT')
lines=[]
for line in text.splitlines():
    if line.strip().startswith('Location:'):
        x,y=map(int,line.split(':',1)[1].strip().split(','));v=x+y;u=(x-y-(v&1))//2
        line=line.split('Location:',1)[0]+f'Location: {u},{v}'
    lines.append(line)
p.write_text('\n'.join(lines)+'\n')
p=root/'map.bin';data=bytearray(p.read_bytes());w,h=struct.unpack_from('<HH',data,1)
img=Image.new('RGB',(w,h))
for u in range(w):
    for v in range(h):
        offset=17+3*(u*h+v);tid=struct.unpack_from('<H',data,offset)[0];tile={1015:1,1047:2,1031:3}.get(tid,0)
        actual={0:255,1:1,2:580,3:227}[tile] if args.classic_core else tile
        struct.pack_into('<H',data,offset,actual);data[offset+2]=0
        img.putpixel((u,v),{0:(93,125,59),1:(55,94,135),2:(111,116,62),3:(133,111,74)}[tile])
p.write_bytes(data);img.save(root/'map.png')
report=root/'earth.json'
if report.exists():
    value=json.loads(report.read_text());value['gameMode']='classic';value['adaptations'].append('Square standalone Classic terrain and actor coordinates.');report.write_text(json.dumps(value,indent=2)+'\n')

with zipfile.ZipFile(root/'map.oramap','w',zipfile.ZIP_DEFLATED) as package:
    for name in ['map.yaml','map.bin','map.png']:
        package.write(root/name,name)
