"""Build the browser's project-content expansion without modifying the input mod.

Classic country mechanics use existing project sprites. Modern campaign maps are
converted from their source terrain and actor layouts; their objectives run in the
shared deterministic host, avoiding a native Lua dependency in WebAssembly.
"""
from pathlib import Path
import argparse
import os
import copy
import json
import re
import struct
import hashlib
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--game-mode', choices=['isometric','classic'], default='isometric')
ap.add_argument('--mod', type=Path, default=Path(os.environ.get('RTSAI_MOD_ROOT', ROOT / '.inputs/mod')))
ap.add_argument('--missions', type=Path, default=ROOT / '.inputs/missions/missions')
ap.add_argument('--classic-source', type=Path, default=ROOT / '.inputs/classic-map-source')
ap.add_argument('--out', type=Path, default=ROOT / 'content')
ap.add_argument('--scenarios-out', type=Path, default=ROOT / 'scenarios')
ap.add_argument('--ea-art', type=Path, help='isometric: verified original-art directory (tools/prepare-ea-art.py); '
                'draws the nine original countries with the original Westwood art')
ap.add_argument('--ea-list', type=Path, help='isometric: write the original art files the generator needs and stop')
args = ap.parse_args()
MOD = args.mod.resolve() / 'mods/rtsai'
OUT = args.out.resolve()
SCENARIOS = args.scenarios_out.resolve()
MISSIONS = args.missions.resolve()
CLASSIC = args.classic_source.resolve()
CLASSIC_MODE = args.game_mode == "classic"

def parse(text):
    root = {}; stack = [(-1, root)]
    for line in text.splitlines():
        line = line.split(' #', 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith('#'): continue
        depth = len(line) - len(line.lstrip('\t'))
        key, _, val = line.strip().partition(':')
        while stack[-1][0] >= depth: stack.pop()
        node = {'value': val.strip(), 'children': {}}
        stack[-1][1][key] = node; stack.append((depth, node['children']))
    return root

def merge(dst, src):
    for k, n in src.items():
        if k.startswith('-'): dst.pop(k[1:], None); continue
        if k not in dst: dst[k] = copy.deepcopy(n)
        else:
            if n['value']: dst[k]['value'] = n['value']
            merge(dst[k]['children'], n['children'])
    return dst

def dump(nodes, depth=0):
    return ''.join('\t'*depth+k+':'+(' '+n['value'] if n['value'] else '')+'\n'+dump(n['children'],depth+1) for k,n in nodes.items())

def node(v='', children=None): return {'value': str(v), 'children': children or {}}
def values(**kwargs): return {k:node(v) for k,v in kwargs.items()}
def section(path, key): return parse(path.read_text(encoding='utf-8'))[key]['children']

manifest = parse((MOD/'mod.yaml').read_text())
rules = {}; sequences = {}
for key, dest in [('Rules', rules), ('Sequences', sequences)]:
    for name in manifest[key]['children']:
        if name.startswith('ra2|'): merge(dest, parse((MOD/name.split('|')[1]).read_text(encoding='utf-8')))

def resolve(allnodes, key, visiting=()):
    if key in visiting: raise ValueError('inheritance cycle '+key)
    out = {}; source = allnodes[key]['children']
    for k,n in source.items():
        if k.startswith('Inherits'): merge(out, resolve(allnodes,n['value'],visiting+(key,)))
    merge(out,{k:n for k,n in source.items() if not k.startswith('Inherits')})
    return out

COUNTRIES = {'america':'saudi','germany':'china','england':'turkey','france':'israel','korea':'china',
             'cuba':'hezbollah','libya':'yemen','iraq':'iran','russia':'iran'}

def countries():
    overlay = parse((MOD.parent/'rtsai-classic/rules/factions.yaml').read_text())
    # The public world selects from all sixteen real countries.
    overlay['^BaseWorld']['children']['Faction@random']['children']['RandomFactionMembers'] = node(', '.join([
        *COUNTRIES,'china','iran','turkey','saudi','israel','yemen','hezbollah']))
    # Reuse the kit's faction paint schemes for shared buildings and utility units.
    kit = parse((MOD/'standalone/base-kit.yaml').read_text())
    for actor,n in kit.items():
        sprites = n['children'].get('RenderSprites',{}).get('children',{})
        images = sprites.get('FactionImages',{}).get('children',{})
        if images:
            target = overlay.setdefault(actor,node())['children'].setdefault('RenderSprites',node())['children']
            target['FactionImages'] = node(children={f:copy.deepcopy(images.get(d, next(iter(images.values())))) for f,d in COUNTRIES.items()})
    # Each country's signature keeps its original rules, weapon, cost and prerequisites.
    art = {
        'e1':'r2cnrifle','e2':'r2basij','snipe':'r2wadighost','ghost':'r2ilrifle','ccomand':'r2ilrifle',
        'ptroop':'r2falcon','tany':'r2ilrifle','jumpjet':'r2falcon','cleg':'r2cnnetwork',
        'flakt':'r2yrpg','shk':'r2cnportable','terror':'r2hzrifle','deso':'r2hzat','ivan':'r2dronecontrol',
        'civan':'r2dronecontrol','yuri':'r2cnnetwork','yuripr':'r2cnnetwork',
        'mtnk':'r2m1a2s','tnkd':'r2qilin','fv':'r2aras','sref':'r2merkava','mgtk':'r2zbd',
        'htnk':'r2karrar','apoc':'r2karrar','ttnk':'r2qilin','dtruck':'r2ymlr','dron':'r2lynx',
        'dest':'r2ege','aegis':'r2luyang','dlph':'r2jiaolong','carrier':'r2haiwang',
        'sub':'r2jiaolong','hyd':'r2ege','sqd':'r2jiaolong',
        'shad':'r2crane','zep':'r2cloud','orca':'r2haiying','beag':'r2skyspear',
        'pdplane':'r2haiying','hornet':'r2haiying','asw':'r2crane',
        'gapill':'r2saguard','gagun':'r2saguard','gagt':'r2saguard','nasam':'r2iraasite',
        'naflak':'r2iraasite','tesla':'r2spectrum','atesla':'r2spectrum','gtur':'r2saguard',
        'nalasr':'r2hzbunker','naftur':'r2hzbunker','tesl':'r2spectrum','gtgcan':'r2bastion',
    }
    seqout = {}
    for actor,donor in art.items():
        if actor not in rules or donor not in rules or donor not in sequences: continue
        orig = resolve(rules,actor); source = resolve(rules,donor)
        traits = overlay.setdefault(actor,node())['children']
        seq = resolve(sequences,donor)
        # Give the original animation vocabulary project-owned frames, including deployment/prone animations.
        image = 'web-'+actor
        origimage = orig.get('RenderSprites',node())['children'].get('Image',node(actor))['value'] or actor
        if origimage in sequences:
            for name in resolve(sequences,origimage):
                if name not in seq and name != 'Defaults':
                    candidate = 'prone-shoot' if 'shoot' in name and 'prone' in name else 'shoot' if 'shoot' in name else 'run' if 'run' in name else 'die1' if name.startswith('die') else 'idle' if 'idle' in seq else 'stand'
                    seq[name] = copy.deepcopy(seq.get(candidate, next(iter(seq.values()))))
        if ('WithSpriteTurret' in orig or ('WithSpriteTurret' in source and 'Turreted' in orig)) and 'turret' not in seq:
            seq['turret'] = copy.deepcopy(seq.get('idle', seq.get('stand', next(iter(seq.values())))))
        seqout[image] = node(children=seq)
        palette = source.get('RenderSprites',node())['children'].get('PlayerPalette',node('kitplayer'))['value']
        traits['RenderSprites'] = node(children=values(Image=image,PlayerPalette=palette))
        if 'WithDeathAnimation@normal' in orig:
            traits['WithDeathAnimation@normal'] = node(children=values(DeathSequencePalette=palette,DeathPaletteIsPlayerPalette='true'))
        for k in orig:
            if k.startswith('WithVoxel'):
                # Preserve traits that descendant actors remove, but disable their voxel bodies.
                traits[k] = node(children=values(RequiresCondition='false'))
        if 'RenderVoxels' in orig:
            traits['BodyOrientation'] = node(children=values(QuantizedFacings=32))
            if 'Building' not in orig:
                traits['WithFacingSpriteBody'] = node()
        if 'WithSpriteTurret' in source and 'Turreted' in orig:
            traits['WithSpriteTurret'] = node()
        if 'TakeCover' in orig:
            traits['TakeCover'] = node(children=values(ProneSequencePrefix='prone-'))
        # Icons remain specific to the original actor's role through the generated project sequence.
    (OUT/'countries.yaml').write_text(dump(overlay),encoding='utf-8',newline='\n')
    (OUT/'country-sequences.yaml').write_text(dump(seqout),encoding='utf-8',newline='\n')
    # All original countries use a shipped project announcer rather than unavailable RA2 EVA clips.
    notifications={'Speech':node(children={'Prefixes':node(children={f:node('ra2|modern-factions/audio/eva/'+d+'/') for f,d in COUNTRIES.items()})})}
    (OUT/'country-notifications.yaml').write_text(dump(notifications),encoding='utf-8',newline='\n')

def objective(text, kind, targets=(), **kw):
    return dict(text=text,kind=kind,targets=list(targets),**kw)

CAMPAIGNS = [
    dict(id='jizan-corridor',source='red-sea-2026/jizan-corridor',faction='saudi',campaign='Red Sea',
         title='Jizan Corridor',enemy='Yemen',protect=['SaudiConyard'],
         objectives=[objective('Capture Radar Node Seven.','capture',['RadarNode']),
                     objective('Destroy both mobile launchers.','destroy',['LauncherWest','LauncherEast']),
                     objective('Escort at least two relief trucks to the port.','escort',entry='ConvoyEntry',
                               route=['ConvoyRally','CorridorOne','CorridorTwo','CorridorThree','PortGate','ConvoyExit'],requires=[0,1],count=2),
                     objective('Keep the port depot and desalination plant intact.','protect',['PortDepot','Desalination'],secondary=True)]),
    dict(id='hodeidah-lifeline',source='red-sea-2026/hodeidah-lifeline',faction='yemen',campaign='Red Sea',
         title='Hodeidah Lifeline',enemy='Saudi Arabia',protect=['YemenConyard'],
         objectives=[objective('Deliver relief supplies inland.','escort',entry='PortEntry',
                               route=['PortRally','ReliefOne','ReliefTwo','ReliefThree','DistributionGate','ReliefExit'],count=2),
                     objective('Move the mobile force out of the marked surveillance zone before the sweep.','disperse',
                               area=[20,62,43,82],seconds=120,allowed=1),
                     objective('Protect the evacuation convoy on its return to port.','escort',entry='EvacEntry',
                               route=['DistributionGate','ReliefThree','ReliefTwo','ReliefOne','PortRally','EvacExit'],count=2,requires=[0,1]),
                     objective('Keep lifeline infrastructure intact.','protect',['PortControl','FisheriesDepot','CoastalClinic','InlandDistribution'])]),
    dict(id='straits-shield',source='turkey-faction/straits-shield',faction='turkey',campaign='Combined Arms',
         title='Straits Shield',enemy='Orion Group',protect=['TurkeyConyard'],
         objectives=[objective('Build the land, air, technology, repair and naval production network.','build',
                               types=['gaweap','gaairc','gatech','gadept','gayard']),
                     objective('Destroy all three drone uplinks.','destroy',['UplinkNorth','UplinkEast','UplinkSouth']),
                     objective('Capture the harbor relay with an engineer.','capture',['HarborRelay']),
                     objective('Neutralize the five-ship surface group.','destroy',['OrionFrigate','OrionCorvette1','OrionCorvette2','OrionUSV1','OrionUSV2'])]),
    dict(id='haitan-network',source='china-faction/haitan-network',faction='china',campaign='Combined Arms',
         title='Haitan Network',enemy='Obsidian Directorate',protect=['ChinaConyard'],
         objectives=[objective('Deploy a network specialist at the command node.','reach',types=['r2cnnetwork'],
                               target='NetworkNode',radius=3,deploy=True),
                     objective('Sail two amphibious IFVs through the sea gate and land on the eastern beach.','reach',
                               types=['r2zbd'],via='AmphibiousGate',target='EastBeach',radius=5,count=2),
                     objective('Destroy the enemy control node.','destroy',['EnemyCommand']),
                     objective('Protect the network relay.','protect',['NetworkRelay'],secondary=True)]),
    dict(id='bab-al-mandab-passage',source='red-sea-2026/bab-al-mandab-passage',faction='saudi',campaign='Red Sea',
         title='Bab al-Mandab Passage',enemy='Yemen',protect=['SaudiConyard','PassageControl'],
         objectives=[objective('Build radar and a technology center.','build',types=['gaairc','gatech']),
                     objective('Reconnoiter the three coastal sectors.','scout',targets=['ReconNorth','ReconCenter','ReconSouth'],radius=7),
                     objective('Neutralize the mobile launchers.','destroy',['ThreatNorth','ThreatCenter','ThreatSouth']),
                     objective('Protect four merchant vessels through the strait.','shipping',count=4,requires=[0,1,2],
                               lanes=[['ShipEntryWest','ShipWestOne','ShipWestTwo','ShipWestThree','ShipWestFour','ShipWestExit'],
                                      ['ShipEntryInnerWest','ShipInnerWestOne','ShipInnerWestTwo','ShipInnerWestThree','ShipInnerWestFour','ShipInnerWestExit'],
                                      ['ShipEntryInnerEast','ShipInnerEastOne','ShipInnerEastTwo','ShipInnerEastThree','ShipInnerEastFour','ShipInnerEastExit'],
                                      ['ShipEntryEast','ShipEastOne','ShipEastTwo','ShipEastThree','ShipEastFour','ShipEastExit']])]),
]

def missions():
    catalog=[]
    for mission in CAMPAIGNS:
        src=MISSIONS/mission['source']
        original=parse((src/'map.yaml').read_text())
        w,h=map(int,original['MapSize']['value'].split(','))
        tilefile='temperat.yaml' if original['Tileset']['value']=='TEMPERAT' else 'desert.yaml'
        templates=section(CLASSIC/'mods/ra/tilesets'/tilefile,'Templates')
        terrain={}
        for n in templates.values():
            ch=n['children']; tid=int(ch['Id']['value'])
            for idx,t in ch.get('Tiles',node())['children'].items(): terrain[(tid,int(idx))]=t['value']
        if (src/'map.bin').exists(): raw=(src/'map.bin').read_bytes()
        else:
            with zipfile.ZipFile(CLASSIC/'mods/ra/maps'/(mission['id']+'-2026.oramap')) as archive:
                raw=archive.read('map.bin')
        version,sw,sh,tilesOffset,heightOffset,resOffset=struct.unpack_from('<BHHIII',raw)
        if (sw,sh)!=(w,h): raise ValueError('map dimensions differ')
        out=bytearray(17+w*h*6)
        struct.pack_into('<BHHIII',out,0,2,w,h,17,17+w*h*3,17+w*h*4)
        colors=[]
        for u in range(w):
            for v in range(h):
                i=u*h+v; t,idx=struct.unpack_from('<HB',raw,tilesOffset+i*3)
                cls=terrain.get((t,idx),'Clear')
                tile=(1 if cls=='Water' else 2 if cls in ('Rock','Rough','Tree') else 3 if cls=='Road' else 0) if CLASSIC_MODE else (1015 if cls=='Water' else 1047 if cls in ('Rock','Rough','Tree') else 1031 if cls=='Road' else 1063 if cls=='Beach' else 0)
                struct.pack_into('<HB',out,17+i*3,tile,0)
                if resOffset:
                    r,amount=struct.unpack_from('<BB',raw,resOffset+i*2)
                    if r in (1,2) and cls!='Water': struct.pack_into('<BB',out,17+w*h*4+i*2,r,amount)
        players=original['Players']['children']
        byname={n['children']['Name']['value']:n['children'] for n in players.values()}
        human=next(n for n in byname.values() if n.get('Playable',node())['value']=='True')
        mission['slot']=human['Name']['value']
        for p in byname.values():
            p.pop('Bot',None)
            if p.get('Faction',node())['value'] in ('allies','soviets'): p['Faction']=node('china' if p['Faction']['value']=='allies' else 'iran')
        actors=original['Actors']['children']
        convert={'fact':'gacnst','proc':'garefn','apwr':'gapowr','powr':'gapowr','tent':'gapile','barr':'nahand',
                 'weap':'gaweap','dome':'gaairc','atek':'gatech','stek':'natech','fix':'gadept','hpad':'gaairc','afld':'gaairc',
                 'fcom':'caoutp','hosp':'cahosp','miss':'caoutp','mrj':'r2spectrum','3tnk':'htnk','v2rl':'r2ymlr',
                 'e6':'engineer','tech':'r2technical','mine':'oremine','gmine':'oremine','oilb':'caoild','ftrk':'htk',
                 'redspear':'r2redspear','aras8':'r2aras','denizkaplan':'r2deniz','kuzgunm':'r2kuzgun',
                 'cnbastion':'r2bastion','cnskyshield':'r2skyshield','cnspectrum':'r2spectrum',
                 'cnzbd':'r2zbd','cnqilin':'r2qilin','cnphl':'r2phl','cnlynx':'r2lynx','cnmantis':'r2mantis',
                 'cnluyang':'r2luyang','cnkunlun':'r2kunlun','cnjiaolong':'r2jiaolong','cncrane':'r2crane',
                 'cncloud':'r2cloud','cnhaiwang':'r2haiwang','cnhaiying':'r2haiying','cnskyspear':'r2skyspear'}
        for name,a in actors.items():
            kind=a['value']; owner=a['children'].get('Owner',node('Neutral'))['value']
            faction=byname.get(owner,{}).get('Faction',node('china'))['value']
            if 'r2'+kind in rules: kind='r2'+kind
            else: kind=convert.get(kind,kind)
            if kind in ('gacnst','garefn','gapowr','gapile','gaweap','gaairc','gadept','gatech') and faction in ('iran','yemen','hezbollah','russia'):
                kind={'gacnst':'nacnst','garefn':'narefn','gapowr':'napowr','gapile':'nahand','gaweap':'naweap','gaairc':'naradr','gadept':'nadept','gatech':'natech'}[kind]
            if kind=='e1': kind={'saudi':'r2sang','china':'r2cnrifle','turkey':'r2trrifle'}.get(faction,'e1')
            if kind=='e2': kind={'yemen':'r2ymr','iran':'r2basij'}.get(faction,'e2')
            if kind not in rules: raise ValueError(f"{mission['id']}: unmapped actor {name}: {kind}")
            a['value']=kind
            if not CLASSIC_MODE and 'Location' in a['children']:
                u,v=map(int,a['children']['Location']['value'].split(',')); off=v&1
                a['children']['Location']=node(f'{(v+off)//2+u},{(v-off)//2-u}')
            a['children'].pop('SubCell',None)
        # The source map's topology and resource fields are retained. Art comes from our temperate tileset.
        home=next(a for a in actors.values() if a['children'].get('Owner',node())['value']==mission['slot'] and a['value'] in ('gacnst','nacnst'))
        actors['MissionSpawn']=node('mpspawn',values(Owner='Neutral',Location=home['children']['Location']['value']))
        original['RequiresMod']=node('rtsai-topdown' if CLASSIC_MODE else 'rtsai'); original['Tileset']=node('TEMPERATE')
        original['Author']=node('RTS AI — browser adaptation')
        original.pop('FluentMessages',None); original.pop('Sequences',None); original.pop('Weapons',None)
        original['Rules']=node(children=parse('World:\n\t-SpawnStartingUnits:\n\t-CrateSpawner:\n\t-StartGameNotification:\nPlayer:\n\t-ConquestVictoryConditions:\n'))
        d=OUT/'maps'/mission['id']; d.mkdir(parents=True,exist_ok=True)
        (d/'map.yaml').write_text(dump(original),encoding='utf-8',newline='\n'); (d/'map.bin').write_bytes(out)
        # A native-style isometric map preview, generated from the actual converted terrain.
        img=Image.new('RGB',(w if CLASSIC_MODE else 2*w,h))
        for u in range(w):
            for v in range(h):
                tid=struct.unpack_from('<H',out,17+(u*h+v)*3)[0]
                color={1:(55,94,135),2:(111,116,62),3:(133,111,74),1015:(55,94,135),1047:(111,116,62),1031:(133,111,74),1063:(183,163,105)}.get(tid,(93,125,59))
                for x in ([u] if CLASSIC_MODE else [2*u+(v&1),2*u+1+(v&1)]):
                    if x<img.width: img.putpixel((x,v),color)
        img.save(d/'map.png')
        mission['briefing']='\n\n'.join(p for p in (src/'briefing.md').read_text().split('\n\n') if not p.startswith('#') and not p.startswith('Sources:') and not p.startswith('- ') and not p.startswith('http'))
        mission['adaptation']='Adapted from the original Red Alert mission for RTS AI units and project terrain.'
        # Validate every named target at build time: a typo must not make a mission impossible to win.
        named=set(actors)
        for obj in mission['objectives']:
            refs=obj.get('targets',[])+obj.get('route',[])+[obj[k] for k in ('target','via','entry') if k in obj]
            refs += [x for lane in obj.get('lanes',[]) for x in lane]
            for ref in refs:
                if ref not in named: raise ValueError(f"{mission['id']}: unknown objective actor {ref}")
        mission['protect']=[name for name in mission['protect'] if name in named]
        catalog.append(mission)
        scenario=dict(map=mission['id'],mission=mission['id'],seed=2026,players=[dict(slot=mission['slot'],faction=mission['faction'],color='2A6FDB')],options={'startingcash':'10000','difficulty':'normal','fog':'True','explored':'False'})
        (SCENARIOS/('mission-'+mission['id']+'.json')).write_text(json.dumps(scenario,indent=2)+'\n')
    # No legacy Hezbollah mission exists. This new fictional exercise uses the modern roster.
    hz=dict(id='hezbollah-relay',title='Relay Under Siege',faction='hezbollah',campaign='Combined Arms',slot='Hezbollah',enemy='Opposition',
            protect=['HezbollahConyard'],briefing='A fictional training exercise: establish a relay and field workshop, defend your supply base through repeated attacks, then destroy the opposing command post. Use rifle teams, anti-tank specialists, mobile launchers and reconnaissance drones together. Expand the economy before the main assault. No real operation or force disposition is represented.',
            adaptation='An original RTS AI mission using project units, art and terrain.',
            objectives=[objective('Build a field relay and workshop.','build',types=['r2hzrelay','r2hzworkshop']),
                        objective('Hold the base through four minutes of attacks.','survive',seconds=240),
                        objective('Destroy the opposing command post.','destroy',['EnemyCommand'],requires=[0,1])])
    base=MOD/'standalone/maps/twin-fords'
    game_map=parse((base/'map.yaml').read_text())
    game_map['Title']=node(hz['title']); game_map['Visibility']=node('MissionSelector');game_map['Categories']=node('Campaign')
    game_map['Players']=node(children=parse('PlayerReference@Neutral:\n\tName: Neutral\n\tOwnsWorld: True\n\tNonCombatant: True\n\tFaction: china\nPlayerReference@Hezbollah:\n\tName: Hezbollah\n\tPlayable: True\n\tRequired: True\n\tLockFaction: True\n\tFaction: hezbollah\n\tEnemies: Opposition\nPlayerReference@Opposition:\n\tName: Opposition\n\tFaction: israel\n\tColor: D83A2E\n\tEnemies: Hezbollah\n'))
    actors={k:n for k,n in game_map['Actors']['children'].items() if n['value']=='oremine'}
    if CLASSIC_MODE:
        game_map['RequiresMod']=node('rtsai-topdown')
        for actor in actors.values():
            x,y=map(int,actor['children']['Location']['value'].split(',')); v=x+y; u=(x-y-(v&1))//2
            actor['children']['Location']=node(f'{u},{v}')
    def add(name,kind,owner,u,v):
        off=v&1; location=f'{u},{v}' if CLASSIC_MODE else f'{(v+off)//2+u},{(v-off)//2-u}'
        actors[name]=node(kind,values(Owner=owner,Location=location))
    add('MissionSpawn','mpspawn','Neutral',13,94)
    for name,kind,u,v in [('HezbollahConyard','nacnst',12,92),('HezbollahPower','napowr',8,98),
                          ('HezbollahRefinery','narefn',15,98),('HezbollahBarracks','nahand',10,104),
                          ('HezbollahFactory','naweap',18,108),('HezbollahRadar','naradr',5,106),
                          ('HezbollahHarvester','harv',19,94)]: add(name,kind,'Hezbollah',u,v)
    for i in range(4): add('Rifle'+str(i),'r2hzrifle','Hezbollah',18+i*2,96)
    for i in range(2): add('AT'+str(i),'r2hzat','Hezbollah',18+i*3,102)
    add('Scout','r2hzscout','Hezbollah',23,96)
    add('Launcher','r2hzrockets','Hezbollah',22,105)
    add('EnemyCommand','gacnst','Opposition',48,30)
    add('EnemyFactory','gaweap','Opposition',45,24)
    add('EnemyGuard1','r2merkava','Opposition',43,34)
    add('EnemyGuard2','r2merkava','Opposition',51,36)
    add('GroundWaveEntry','waypoint','Neutral',46,42)
    game_map['Actors']=node(children=actors)
    game_map['Rules']=node(children=parse('World:\n\t-SpawnStartingUnits:\n\t-CrateSpawner:\n\t-StartGameNotification:\nPlayer:\n\t-ConquestVictoryConditions:\n'))
    for n in actors.values():
        if n['value'] not in rules: raise ValueError('Hezbollah mission unknown actor '+n['value'])
    d=OUT/'maps'/hz['id'];d.mkdir(parents=True,exist_ok=True)
    (d/'map.yaml').write_text(dump(game_map),encoding='utf-8',newline='\n')
    raw=bytearray((base/'map.bin').read_bytes())
    if CLASSIC_MODE:
        _,w,h,at,_,_=struct.unpack_from('<BHHIII',raw); image=Image.new('RGB',(w,h))
        for u in range(w):
            for v in range(h):
                tid=struct.unpack_from('<H',raw,at+(u*h+v)*3)[0]; tid={1015:1,1047:2,1031:3}.get(tid,0)
                struct.pack_into('<HB',raw,at+(u*h+v)*3,tid,0); image.putpixel((u,v),{1:(55,94,135),2:(111,116,62),3:(133,111,74)}.get(tid,(93,125,59)))
        image.save(d/'map.png')
    else: (d/'map.png').write_bytes((base/'map.png').read_bytes())
    (d/'map.bin').write_bytes(raw)
    catalog.append(hz)
    (SCENARIOS/('mission-'+hz['id']+'.json')).write_text(json.dumps(dict(map=hz['id'],mission=hz['id'],seed=2026,players=[dict(slot=hz['slot'],faction=hz['faction'],color='2A6FDB')],options={'startingcash':'10000','difficulty':'normal','fog':'True','explored':'False'}),indent=2)+'\n')
    (OUT/'missions.json').write_text(json.dumps(catalog,indent=2)+'\n',encoding='utf-8')

def originals():
    """Original art for the nine original countries (isometric only): content/ea-art.yaml, ea-sequences.yaml,
    ea-models.yaml and ea-files.json. Render-only; see tools/ea_originals.py."""
    import ea_originals
    generator = ea_originals.Generator(args.mod.resolve(), OUT).plan()
    if args.ea_list:
        files = generator.needed_files()
        body = {'schema': 1, 'files': files, 'actors': sorted(generator.actors), 'images': len(generator.images),
                'models': len(generator.models)}
        body['planSha256'] = hashlib.sha256(json.dumps(files).encode()).hexdigest()
        args.ea_list.write_text(json.dumps(body, indent=1) + '\n')
        return None
    manifest = json.loads((args.ea_art / 'EA-INPUTS.json').read_text())
    recorded = {f['name']: f for f in manifest['files']}
    generator.generate()
    for name in generator.ea_files:
        f = recorded.get(name)
        if f is None:
            raise ValueError(f'original art {name} is not in {args.ea_art / "EA-INPUTS.json"}')
        if hashlib.sha256((args.ea_art / name).read_bytes()).hexdigest() != f['sha256']:
            raise ValueError(f'original art {name} differs from EA-INPUTS.json')
    summary = generator.write(OUT)
    print(f"original art: {len(summary['actors'])} actors, {len(generator.seq_nodes)} images, {len(generator.model_nodes)} voxel models, {len(summary['files'])} files")
    return manifest


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    SCENARIOS.mkdir(parents=True, exist_ok=True)
    if (args.ea_art or args.ea_list) and CLASSIC_MODE:
        raise ValueError('original art is isometric only; Classic/top-down keeps the stand-ins')
    if not CLASSIC_MODE: countries()
    missions()
    ea_manifest = originals() if (args.ea_art or args.ea_list) else None
    if args.ea_list:
        print(f'wrote {args.ea_list}')
        raise SystemExit(0)
    sources=[p for p in MISSIONS.rglob('*') if p.is_file() and p.suffix in {'.yaml','.bin','.md'}]
    sources += [CLASSIC/'mods/ra/tilesets/temperat.yaml',CLASSIC/'mods/ra/tilesets/desert.yaml',MOD/'standalone/maps/twin-fords/map.yaml',MOD/'standalone/maps/twin-fords/map.bin',MOD.parent/'rtsai-topdown/tileset.yaml']
    if ea_manifest: sources.append(args.ea_art/'EA-INPUTS.json')
    receipt={'gameMode':args.game_mode,'modId':'rtsai-topdown' if CLASSIC_MODE else 'rtsai','gridType':'Rectangular' if CLASSIC_MODE else 'RectangularIsometric','compilerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
             'eaArt':({'manifestSha256':ea_manifest['sha256'],'files':len(ea_manifest['files']),'notice':ea_manifest['notice'],'generatorSha256':hashlib.sha256((Path(__file__).parent/'ea_originals.py').read_bytes()).hexdigest()} if ea_manifest else None),'sources':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(set(sources))],'outputs':[{'path':str(p.relative_to(OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.rglob('*')) if p.is_file()]}
    (OUT/'mode-provenance.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print('prepared nine additional countries, five adapted missions and one original Hezbollah exercise')
