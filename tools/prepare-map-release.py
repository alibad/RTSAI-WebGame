"""Overlay reviewed maps/terrain on the live restoration and export archive-free native Classic.

Inputs are immutable verified packages, not working game checkouts. Preserve every
existing isometric rule and original-country asset except explicit scenery layers.
Classic freezes the resolved default experience so it also runs on the published engine.
"""
import argparse, hashlib, json, re, shutil, struct
from pathlib import Path

def sha(b): return hashlib.sha256(b).hexdigest()
def read_pack(path):
    b=path.read_bytes(); assert b[:8]==b'ORAPACK1'; p=12; result={}
    for _ in range(struct.unpack_from('<i',b,8)[0]):
        n=struct.unpack_from('<H',b,p)[0]; p+=2; name=b[p:p+n].decode(); p+=n
        size=struct.unpack_from('<i',b,p)[0]; p+=4
        assert name not in result and not name.startswith('/') and '..' not in name.split('/')
        result[name]=b[p:p+size]; p+=size
    assert p==len(b); return result
def write_pack(path,files,lazy=False):
    rows=[]; path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('wb') as f:
        f.write(b'ORAPACK1'+struct.pack('<i',len(files)))
        for name,b in sorted(files.items()):
            key=name.encode(); f.write(struct.pack('<H',len(key))+key+struct.pack('<i',len(b)))
            rows.append({'path':name,'offset':f.tell(),'size':len(b)}); f.write(b)
    if lazy: path.with_suffix('.json').write_text(json.dumps({'files':rows})+'\n')
def section(yaml,name,lines):
    block=name+':\n'+''.join('\t'+line+'\n' for line in lines)+'\n'
    pattern=r'^'+re.escape(name)+r':[^\n]*\n(?:(?:\t[^\n]*|[ \t]*)\n)*'
    if re.search(pattern,yaml,re.M): return re.sub(pattern,lambda _:block,yaml,count=1,flags=re.M)
    return yaml+'\n'+block
def append(yaml,name,item):
    found=re.search(r'^'+name+r':[^\n]*\n((?:\t[^\n]*\n|\n)*)',yaml,re.M)
    assert found,name
    lines=[line[1:] for line in found[1].splitlines() if line.startswith('\t')]
    return section(yaml,name,list(dict.fromkeys(lines+[item])))
def emit(folder,core,art,audio,receipt):
    # MapCache hashes complete map packages at boot, before shipped sprites are
    # available. Map previews must stay resident with map.bin/map.yaml; static
    # releases intentionally omit the large lazy art pack.
    for name in list(art):
        if '/maps/' in name: core[name]=art.pop(name)
    for name in list(core):
        ext=Path(name).suffix.lower()
        if ext in ['.wav','.aud','.ogg','.mp3'] or re.fullmatch(r'\.[vr]0[0-3]',ext): audio[name]=core.pop(name)
        # Preserve the input's resident art partition. Cursors, UI art and map
        # previews are read outside the world's prebaked sprite path, so moving
        # them into a lazy archive would break static releases that omit it.
    allfiles={**core,**art,**audio}; allfiles.pop('ora/BUNDLE_ID',None)
    identity=sha(b''.join(name.encode()+b'\0'+bytes.fromhex(sha(b)) for name,b in sorted(allfiles.items())))[:20]
    core['ora/BUNDLE_ID']=identity.encode()
    receipt['bundle']=identity
    core['ora/map-release.json']=(json.dumps(receipt,indent=2)+'\n').encode()
    write_pack(folder/'web-bundle.pack',core); write_pack(folder/'web-art.pack',art,True); write_pack(folder/'web-audio.pack',audio,True)
    (folder/'map-release.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(f'{folder.name}: {identity}, {len(core)} core files, {len(art)} art files, {len(audio)} audio files')
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for name in ['base','classic','assets','mod','out']: ap.add_argument('--'+name,type=Path,required=True)
    a=ap.parse_args(); assert not a.out.exists(),'Choose a new output'
    a.out.mkdir(parents=True)
    manifest=json.loads((a.mod/'INPUTS.json').read_text())
    for e in manifest['files']: assert sha((a.mod/e['path']).read_bytes())==e['sha256'],e['path']
    base=read_pack(a.base/'web-bundle.pack'); base_art=read_pack(a.base/'web-art.pack'); base_audio=read_pack(a.base/'web-audio.pack')
    old={**base,**base_art}; overlays={}
    record=json.loads((a.mod/'mods/rtsai/standalone/terrain/CLIFF-REPAIR.json').read_text())
    names=[e['file'] for e in record['files']]+['CLIFF-REPAIR.json']
    for name in names: overlays['mods/rtsai/standalone/terrain/'+name]=(a.mod/'mods/rtsai/standalone/terrain'/name).read_bytes()
    for folder in ['bridges','editor-world','maps']:
        src=a.mod/'mods/rtsai/standalone'/folder
        for p in src.rglob('*'):
            if p.is_file() and (folder!='maps' or p.relative_to(src).parts[0].startswith('ra2-')):
                overlays[p.relative_to(a.mod).as_posix()]=p.read_bytes()
    for name,b in overlays.items(): base_art.pop(name,None); base[name]=b
    yaml=base['mods/rtsai/mod.yaml'].decode().replace('\r\n','\n')
    for s,item in [('Rules','ra2|standalone/editor-world/rules.yaml'),('Sequences','ra2|standalone/editor-world/sequences.yaml'),('Sequences','ra2|standalone/bridges/sequences.yaml')]: yaml=append(yaml,s,item)
    base['mods/rtsai/mod.yaml']=yaml.encode()
    # Preserve original-country restores and all unrelated fields by exact bytes.
    preserved=[name for name in old if name not in overlays and name!='mods/rtsai/mod.yaml' and name!='ora/BUNDLE_ID']
    combined={**base,**base_art}
    assert all(combined[name]==old[name] for name in preserved)
    receipt={'schema':1,'sourceMod':manifest['head'],'sourceModSha256':manifest['sourceSha256'],
        'baseBundle':old['ora/BUNDLE_ID'].decode(),'basePackSha256':sha((a.base/'web-bundle.pack').read_bytes()),
        'preservedFiles':len(preserved),'overlays':{name:sha(b) for name,b in overlays.items()},
        'scope':'Reviewed map, cliff and map-scenery overlays; preserve all live original-country rules/art and audio.'}
    iso=a.out/'public'; emit(iso,base,base_art,dict(base_audio),receipt)
    for name in ['build-inputs.json','ea-inputs.json','content-profile.json']: shutil.copy2(a.base/name,iso/name)
    core=read_pack(a.classic/'web-bundle.pack'); art=read_pack(a.classic/'web-art.pack'); audio={}
    core={name:b for name,b in core.items() if not name.startswith('support/') and name not in ['ora/global mix database.dat','ora/classic-inputs.json']}
    assets=json.loads((a.assets/'classic-assets.json').read_text()); prefix='mods/rtsai-classic-core/web/ea/'
    for e in assets['files']:
        b=(a.assets/e['name']).read_bytes(); assert sha(b)==e['sha256']; core[prefix+e['name']]=b
    core[prefix+'ea-content.json']=json.dumps(assets,indent=2).encode()
    yaml=core['mods/rtsai-classic-core/mod.yaml'].decode().replace('\r\n','\n')
    yaml=re.sub(r'^Include: experiences.yaml\n','',yaml,flags=re.M)
    yaml=re.sub(r'^FinalRules:[^\n]*\n(?:(?:\t[^\n]*|[ \t]*)\n)*','',yaml,flags=re.M)
    yaml=re.sub(r'^PackageFormats:.*\n','',yaml,flags=re.M)
    yaml=re.sub(r'^RTSAIModePreferences:[^\n]*\n(?:(?:\t[^\n]*|[ \t]*)\n)*','',yaml,flags=re.M) # desktop settings hook; browser owns its preferences
    packages=['^EngineDir','$rtsai-classic-core: ra','$rtsai: ra2','^EngineDir|mods/common: common','common|scripts','ra|scripts','ra|uibits']
    packages += ['ra|web/ea/'+m['folder']+(': '+m['alias'] if m['alias'] else '') for m in assets['mounts'] if any(e['name'].startswith(m['folder']+'/') for e in assets['files'])]
    packages+=['ra|bits','ra2|uibits','ra|bits/desert','ra|bits/environment','ra2|standalone/audio/music']
    yaml=re.sub(r'^FileSystem:[^\n]*\n(?:(?:\t[^\n]*|[ \t]*)\n)*',lambda _:'FileSystem: DefaultFileSystem\n\tPackages:\n'+''.join('\t\t'+p+'\n' for p in packages)+'\n',yaml,flags=re.M)
    for name,lines in assets['sections'].items(): yaml=section(yaml,name,lines)
    yaml=section(yaml,'Music',['ra2|standalone/audio/music.yaml'])
    yaml=re.sub(r'^SoundFormats:.*$', 'SoundFormats: Aud, Wav, Ogg',yaml,flags=re.M)
    yaml=re.sub(r'^SpriteFormats:(.*)$',r'SpriteFormats:\1, PngSheet',yaml,flags=re.M)
    core['mods/rtsai-classic-core/mod.yaml']=yaml.encode()
    for name,b in old.items():
        if name.startswith('mods/rtsai/standalone/audio/music'):
            core[name]=b
    for name,b in base_audio.items():
        if name.startswith('mods/rtsai/standalone/audio/music/'): audio[name]=b
    for name in [*core,*art]: assert not re.search(r'\.(mix|bag|idx|vqa|bik)$',name,re.I),name
    classic=a.out/'public-classic'; emit(classic,core,art,audio,{'schema':1,'sourceMod':manifest['head'],'sourceModSha256':manifest['sourceSha256'],
        'sourceBundle':read_pack(a.classic/'web-bundle.pack')['ora/BUNDLE_ID'].decode(),'resolvedExperience':assets['configuration'],
        'classicAssets':sha((a.assets/'classic-assets.json').read_bytes()),'maps':json.loads((a.mod/'resources/classic-web-maps.json').read_text())})
    shutil.copy2(a.base/'build-inputs.json',classic/'build-inputs.json')
    (classic/'content-profile.json').write_text(json.dumps({'schema':1,'gameMode':'classic-core','variant':'native-classic-reviewed','modSource':manifest['sourceSha256']})+'\n')
if __name__=='__main__': main()
