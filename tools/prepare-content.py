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
ap.add_argument('--ea-list', type=Path, help='isometric: write the original art files and voice clips the generator needs and stop')
ap.add_argument('--no-ea-audio', action='store_true', help='with --ea-art/--ea-list: original art only, without the original '
                'unit voices and sounds the verified directory otherwise must carry (tools/ea_voices.py)')
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

# Each country's signature keeps its original rules, weapon, cost and prerequisites; its stand-in art comes from a
# project unit (isometric mode).
COUNTRY_ART = {
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
    seqout = {}
    for actor,donor in COUNTRY_ART.items():
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
    catalog += chapters()
    (OUT/'missions.json').write_text(json.dumps(catalog,indent=2)+'\n',encoding='utf-8')

# Lines of Hope, Act III: original missions on the terrain of two adapted maps, with new actors placed here.
# Orion Group is the fictional contractor force (no flag, no real nation); its faction only picks its unit art and
# the scripted wave type (Missions.Wave). Positions are (u, v) map cells, like the Hezbollah exercise above.
TILE = dict(water=1 if CLASSIC_MODE else 1015, rough=2 if CLASSIC_MODE else 1047,
            road=3 if CLASSIC_MODE else 1031, beach=0 if CLASSIC_MODE else 1063, clear=0,
            # Concrete: the tileset's sixteen "Pavement Individual" tiles (463-478), mixed per cell; road in Classic.
            deck=3 if CLASSIC_MODE else 463)
MAP_RULES = 'World:\n\t-SpawnStartingUnits:\n\t-CrateSpawner:\n\t-StartGameNotification:\nPlayer:\n\t-ConquestVictoryConditions:\n'

def chapter_players(slot, faction, color, extra='', ally=None, enemies=(), orion_allies=()):
    """The player's side, Orion Group and Neutral; `enemies` are further sides hostile to the player (and allied to Orion)."""
    allies = f'\tAllies: {ally}\n' if ally else ''
    orion_allies = f'\tAllies: {", ".join(orion_allies)}\n' if orion_allies else ''
    return parse(f'PlayerReference@{slot}:\n\tName: {slot}\n\tAllowBots: False\n\tPlayable: True\n\tRequired: True\n'
                 f'\tLockFaction: True\n\tFaction: {faction}\n\tLockColor: True\n\tColor: {color}\n\tLockSpawn: True\n'
                 f'\tLockTeam: True\n{allies}\tEnemies: {", ".join(("Orion Group",) + tuple(enemies))}\n'
                 'PlayerReference@Orion:\n\tName: Orion Group\n\tFaction: russia\n\tColor: 545D66\n'+orion_allies+'\tEnemies: '+slot+(f', {ally}' if ally else '')+'\n'
                 'PlayerReference@Neutral:\n\tName: Neutral\n\tOwnsWorld: True\n\tNonCombatant: True\n\tFaction: china\n'+extra)

# Stranded crews and the stranger: a non-combatant side nobody is hostile to. Its faction (one of the original
# countries) only gives the stranger the original 1950s commando art in the isometric mode.
SURVIVORS = 'PlayerReference@Survivors:\n\tName: Survivors\n\tNonCombatant: True\n\tFaction: america\n\tColor: D8D2C4\n'
# Tanya with Colonel Aydin's defenders: her own allied side, not a Turkish unit. A modern faction fielding her would
# change the original-art and original-voice overlays for everyone (tools/ea_originals.py and ea_voices.py follow
# who fields an actor, missions included): her pistols would lose their original sound, and Turkey would draw her in
# the original art.
TANYA_SIDE = 'PlayerReference@Tanya:\n\tName: Tanya\n\tFaction: america\n\tColor: 3A8F5B\n\tAllies: Turkey\n\tEnemies: Orion Group\n'

class ChapterMap:
    """A converted base map's terrain plus new actors; validates every placement against the terrain.
    With art_check, write() also refuses actors the public game would draw with the standalone's stand-ins."""
    def __init__(self, base, mission_id, art_check=False):
        self.id = mission_id; self.art_check = art_check
        self.yaml = parse((OUT/'maps'/base/'map.yaml').read_text(encoding='utf-8'))
        self.raw = bytearray((OUT/'maps'/base/'map.bin').read_bytes())
        _, self.w, self.h, self.tiles, _, self.res = struct.unpack_from('<BHHIII', self.raw)
        self.actors = {}; self.cells = {}

    def tile(self, u, v): return struct.unpack_from('<H', self.raw, self.tiles+(u*self.h+v)*3)[0]
    def ore(self, u, v): return self.res and self.raw[self.res+(u*self.h+v)*2] in (1, 2)
    def paint(self, u, v, kind):
        if not (0 <= u < self.w and 0 <= v < self.h): return
        tile = TILE[kind] + ((u*7 + v*5) % 16 if kind == 'deck' and not CLASSIC_MODE else 0)
        struct.pack_into('<HB', self.raw, self.tiles+(u*self.h+v)*3, tile, 0)
        if kind in ('water', 'beach') and self.res: struct.pack_into('<BB', self.raw, self.res+(u*self.h+v)*2, 0, 0)
    def fill(self, u0, v0, u1, v1, kind):
        for u in range(u0, u1+1):
            for v in range(v0, v1+1): self.paint(u, v, kind)
    def lay_ore(self, u0, v0, u1, v1):
        """Lay ore on the land cells of a box (resource type 1 at full density, as the adapted maps carry it)."""
        for u in range(u0, u1+1):
            for v in range(v0, v1+1):
                if self.tile(u, v) != TILE['water'] and (CLASSIC_MODE or self.tile(u, v) != TILE['beach']): struct.pack_into('<BB', self.raw, self.res+(u*self.h+v)*2, 1, 12)

    def clear_ore(self, u0=None, v0=None, u1=None, v1=None):
        """Remove the ore and gems everywhere, or within a box of cells."""
        if not self.res: return
        if u0 is None: self.raw[self.res:self.res+self.w*self.h*2] = bytes(self.w*self.h*2); return
        for u in range(max(0, u0), min(self.w, u1+1)):
            for v in range(max(0, v0), min(self.h, v1+1)): struct.pack_into('<BB', self.raw, self.res+(u*self.h+v)*2, 0, 0)

    def cpos(self, u, v):
        off = v & 1
        return (u, v) if CLASSIC_MODE else ((v+off)//2+u, (v-off)//2-u)
    def mpos(self, x, y):
        if CLASSIC_MODE: return x, y
        v = x+y; return (x-y-(v & 1))//2, v

    def add(self, name, kind, owner, u, v, where='land', **inits):
        if name in self.actors: raise ValueError(f'{self.id}: duplicate actor {name}')
        if kind not in rules: raise ValueError(f'{self.id}: unknown actor type {kind} ({name})')
        x, y = self.cpos(u, v)
        footprint = [(x, y)]
        building = resolve(rules, kind).get('Building')
        if building:
            dw, dh = map(int, building['children'].get('Dimensions', node('1,1'))['value'].replace(' ', '').split(','))
            rows = building['children'].get('Footprint', node('x'))['value'].split()
            # Conservative: the footprint rows and their transpose (some kit shapes list Dimensions as rows x columns).
            cells = {(i, j) for j, row in enumerate(rows) for i, c in enumerate(row) if c != '_'}
            cells |= {(j, i) for i, j in cells} | {(i, j) for i in range(dw) for j in range(dh)}
            footprint = sorted((x+i, y+j) for i, j in cells)
        for cx, cy in footprint:
            mu, mv = self.mpos(cx, cy)
            b = self.yaml['Bounds']['value'].split(',')
            if not (int(b[0]) <= mu < int(b[0])+int(b[2]) and int(b[1]) <= mv < int(b[1])+int(b[3])):
                raise ValueError(f'{self.id}: {name} at {u},{v} leaves the map bounds')
            t = self.tile(mu, mv)
            if kind != 'waypoint':
                water = t == TILE['water']
                if where == 'water' and not water: raise ValueError(f'{self.id}: {name} at {u},{v} must be on water')
                if where == 'land' and water: raise ValueError(f'{self.id}: {name} at {u},{v} is on water')
                if building and (water or (t == TILE['beach'] and not CLASSIC_MODE) or self.ore(mu, mv)):
                    raise ValueError(f'{self.id}: building {name} at {u},{v} overlaps water, beach or ore at {mu},{mv}')
                if (cx, cy) in self.cells and (building or self.cells[(cx, cy)][1]):
                    raise ValueError(f'{self.id}: {name} overlaps {self.cells[(cx, cy)][0]}')
                self.cells[(cx, cy)] = (name, bool(building))
            elif where == 'water' and t != TILE['water']:
                raise ValueError(f'{self.id}: waypoint {name} at {u},{v} must be on water')
            elif where == 'land' and t == TILE['water']:
                raise ValueError(f'{self.id}: waypoint {name} at {u},{v} is on water')
        self.actors[name] = node(kind, values(Owner=owner, Location=f'{x},{y}', **inits))

    def reachable(self, a, b, water=False):
        """Land (or sea) connectivity between two actors' cells (8-neighbour flood fill over the map's land or water cells)."""
        start = self.mpos(*map(int, self.actors[a]['children']['Location']['value'].split(',')))
        goal = self.mpos(*map(int, self.actors[b]['children']['Location']['value'].split(',')))
        seen = {start}; todo = [start]
        while todo:
            u, v = todo.pop()
            if (u, v) == goal: return True
            near = [(u-1, v), (u+1, v), (u, v-2), (u, v+2), (u, v-1), (u, v+1)]
            near += [(u-1, v-1), (u-1, v+1)] if not v & 1 else [(u+1, v-1), (u+1, v+1)]
            if CLASSIC_MODE: near = [(u+du, v+dv) for du in (-1, 0, 1) for dv in (-1, 0, 1) if du or dv]
            for n in near:
                if n not in seen and 0 <= n[0] < self.w and 0 <= n[1] < self.h and (self.tile(*n) == TILE['water']) == water:
                    seen.add(n); todo.append(n)
        return False

    def write(self, title, slot, faction, color, extra_rules='', extra_players='', ally=None, enemies=(), orion_allies=()):
        m = self.yaml
        m['Title'] = node(title); m['Author'] = node('RTS AI — Lines of Hope')
        m['Visibility'] = node('MissionSelector'); m['Categories'] = node('Campaign')
        m['Players'] = node(children=chapter_players(slot, faction, color, extra_players, ally, enemies, orion_allies))
        m['Actors'] = node(children=self.actors)
        m['Rules'] = node(children=parse(MAP_RULES+extra_rules))
        if self.art_check:
            factions = {n['children']['Name']['value']: n['children'].get('Faction', node('china'))['value'] for n in m['Players']['children'].values()}
            for name, a in self.actors.items():
                faction = a['children'].get('Faction', node(factions[a['children']['Owner']['value']]))['value']
                if a['value'] != 'waypoint' and stand_in_art(a['value'], faction):
                    raise ValueError(f'{self.id}: {name} ({a["value"]}, {faction}) has only stand-in art in the public game')
        d = OUT/'maps'/self.id; d.mkdir(parents=True, exist_ok=True)
        (d/'map.yaml').write_text(dump(m), encoding='utf-8', newline='\n'); (d/'map.bin').write_bytes(self.raw)
        w, h = self.w, self.h
        img = Image.new('RGB', (w if CLASSIC_MODE else 2*w, h))
        colors = {TILE['water']: (55, 94, 135), TILE['rough']: (111, 116, 62), TILE['road']: (133, 111, 74)}
        if not CLASSIC_MODE: colors.update({TILE['deck']+k: (120, 122, 124) for k in range(16)})
        if not CLASSIC_MODE: colors[TILE['beach']] = (183, 163, 105)
        for u in range(w):
            for v in range(h):
                color = colors.get(self.tile(u, v), (93, 125, 59))
                for x in ([u] if CLASSIC_MODE else [2*u+(v & 1), 2*u+1+(v & 1)]):
                    if x < img.width: img.putpixel((x, v), color)
        img.save(d/'map.png')

def stand_in_art(kind, faction):
    """True when every sprite the actor's image draws for that faction is one of the standalone's code-drawn stand-ins
    (standalone/placeholders: the civilians, the campaign outpost), ignoring the original art the isometric mode adds."""
    if kind in COUNTRY_ART and not CLASSIC_MODE: return False
    images = resolve(rules, kind).get('RenderSprites', node())['children']
    image = (images.get('FactionImages', node())['children'].get(COUNTRIES.get(faction, faction), node())['value']
             or images.get('Image', node())['value'] or kind)
    seq = resolve(sequences, image) if image in sequences else {}
    default = seq.get('Defaults', node())['children'].get('Filename', node())['value']
    files = {n['children'].get('Filename', node())['value'] or default or image+'.shp' for k, n in seq.items() if k not in ('Defaults', 'icon')}
    def stand_in(f):
        f = f.split('|')[-1]
        return '/' not in f and (MOD/'standalone/placeholders'/f).exists() and not any(
            (MOD/d/f).exists() for d in ('standalone/effects', 'standalone/units', 'standalone/base', 'bits', 'bits/cameos'))
    return not files or all(stand_in(f) for f in files)

def sensor_rules(kind, radius):
    """Map rules showing a detection zone (Missions.Sensor) around every actor of a type: an amber circle while its
    sweep is on, a dim one while off, red once tripped. The campaign host grants the two conditions."""
    def circle(name, color, width, when):
        return (f'\tWithRangeCircle@{name}:\n\t\tRange: {radius}c0\n\t\tVisible: Always\n\t\tValidRelationships: Ally, Neutral, Enemy\n'
                f'\t\tColor: {color}\n\t\tWidth: {width}\n\t\tBorderColor: 00000080\n\t\tBorderWidth: {width+2}\n\t\tRequiresCondition: {when}\n')
    return (f'{kind}:\n\tExternalCondition@sensor-on:\n\t\tCondition: sensor-on\n\tExternalCondition@sensor-tripped:\n'
            '\t\tCondition: sensor-tripped\n' + circle('sensor-on', 'FFB53CF0', 2, 'sensor-on && !sensor-tripped')
            + circle('sensor-off', '8FB4C878', 1, '!sensor-on && !sensor-tripped') + circle('sensor-tripped', 'FF3A2AF0', 3, 'sensor-tripped'))

def chapter_entry(mission, objectives):
    named = set(mission.pop('map').actors)
    for obj in objectives:
        refs = obj.get('targets', [])+obj.get('route', [])+[obj[k] for k in ('target', 'via', 'entry') if k in obj]
        refs += [x for lane in obj.get('lanes', []) for x in lane]
        for ref in refs:
            if ref not in named: raise ValueError(f"{mission['id']}: unknown objective actor {ref}")
    for name in mission['protect']:
        if name not in named: raise ValueError(f"{mission['id']}: unknown protected actor {name}")
    # Sensors and events (Missions.cs): every actor, actor type and event they name must exist.
    ids = {e['id'] for e in mission.get('events', [])}
    refs = [x['actor'] for x in mission.get('sensors', [])]
    for e in mission.get('events', []):
        refs += [sp.get(k) for sp in e.get('spawn', []) for k in ('at', 'to')] + [r.get('at') for r in e.get('reveal', [])]
        refs += [a for g in e.get('grant', [])+e.get('revoke', []) for a in g['actors']] + [e['when'].get('killed'), e['when'].get('detected')]
        for ref in e.get('conceal', [])+[e.get('until'), e['when'].get('event')]:
            if ref and ref not in ids: raise ValueError(f"{mission['id']}: unknown event {ref}")
        for kind in (k for sp in e.get('spawn', []) for k in sp['types']):
            if kind not in rules: raise ValueError(f"{mission['id']}: unknown actor type {kind} in event {e['id']}")
    for ref in refs:
        if ref and ref != '*' and ref not in named: raise ValueError(f"{mission['id']}: unknown event or sensor actor {ref}")
    for ref in (r for obj in objectives for r in obj.get('after', [])):
        if ref not in ids: raise ValueError(f"{mission['id']}: an objective waits for unknown event {ref}")
    mission['objectives'] = objectives
    (SCENARIOS/('mission-'+mission['id']+'.json')).write_text(json.dumps(dict(map=mission['id'], mission=mission['id'], seed=2026,
        players=[dict(slot=mission['slot'], faction=mission['faction'], color='2A6FDB')],
        options={'startingcash': '10000', 'difficulty': 'normal', 'fog': 'True', 'explored': 'False'}), indent=2)+'\n')
    return mission

def lights_in_the_water():
    """Act III, chapter 1: a night rescue on a reef coast (terrain of Hodeidah Lifeline with a painted sea)."""
    import math
    m = ChapterMap('hodeidah-lifeline', 'lights-in-the-water')
    coast = {u: 85+round(2*math.sin(u*0.35)) for u in range(m.w)}
    for u in range(m.w):
        for v in range(coast[u]-2, m.h): m.paint(u, v, 'beach' if v < coast[u] else 'water')
    # The reef line: a broken chain of rocks offshore that the spoofed signals steered the fishing fleet onto.
    for u in range(36, 92):
        if (u//3) % 3 != 2: m.paint(u, coast[u]+4+(u//5) % 2, 'rough')
    # Orion's columns come down the north road; they make for the watch post first, then the town.
    m.add('OrionWaveEntry', 'waypoint', 'Neutral', 52, 3)
    # Buildings in this order: Missions.Wave sends each column at the first of them still standing.
    m.add('WatchPost', 'caoutp', 'Yemen', 30, 44)
    m.add('WatchMissiles', 'r2ycoastal', 'Yemen', 27, 42)
    m.add('WatchBunker', 'r2ybunker', 'Yemen', 35, 50)
    m.add('TownBunkerNorth', 'r2ybunker', 'Yemen', 22, 56)
    m.add('TownMissilesNorth', 'r2ycoastal', 'Yemen', 28, 58)
    # The north and west sites before the east ones: the columns reach the coast road (and the arriving
    # transports) as late as possible.
    m.add('TownMissilesWest', 'r2ycoastal', 'Yemen', 12, 54)
    m.add('TownBunkerEast', 'r2ybunker', 'Yemen', 34, 66)
    m.add('TownMissilesEast', 'r2ycoastal', 'Yemen', 32, 72)
    m.add('TownClinic', 'cahosp', 'Yemen', 16, 64)
    m.add('TownPowerOne', 'napowr', 'Yemen', 10, 58)
    m.add('TownPowerTwo', 'napowr', 'Yemen', 8, 66)
    # Captain Haidar's mobile force: no base, no production.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 26, 76)
    force = [('r2technical', 2), ('r2ytechrr', 2), ('r2ymlr', 2), ('r2ymr', 4), ('r2yrpg', 3), ('r2yspot', 1)]
    i = 0
    for kind, count in force:
        for _ in range(count):
            m.add(f'Haidar{i}', kind, 'Yemen', 22+i % 6*2, 72+i//6*2 + (i % 2)); i += 1
    # Three stranded groups on the beach; the third holds the stranger pulled from the sea.
    sites = [('SurvivorsCove', 44), ('SurvivorsJetty', 64), ('StrangerSite', 86)]
    for name, u in sites:
        v = coast[u]-3
        m.add(name, 'waypoint', 'Neutral', u, v)
        # Engineers (workers in overalls) stand in for the fishing crews: the standalone's civilians are still
        # placeholder art.
        for k, kind in enumerate(['engineer'] * (3 if name != 'StrangerSite' else 2)):
            m.add(f'{name}Civilian{k}', kind, 'Survivors', u-2+k*2, v-1)
    m.add('Stranger', 'tany', 'Survivors', 87, coast[87]-5)
    # Orion patrols have reached each group: heavier the further east (the stranger is what Orion wants).
    patrols = {'SurvivorsCove': [('e2', -3, -2), ('e2', 3, -2), ('e2', 0, -5), ('deso', 5, -4), ('ttnk', 2, -7)],
               'SurvivorsJetty': [('e2', -3, -2), ('e2', 3, -2), ('e2', -2, -5), ('deso', 4, -5), ('ttnk', 0, -8), ('ttnk', 5, -8)],
               'StrangerSite': [('e2', -4, -2), ('e2', 3, -2), ('e2', -2, -5), ('e2', 4, -5), ('deso', 0, -3),
                                ('ttnk', -3, -9), ('ttnk', 3, -9)]}
    for site, u0 in sites:
        for k, (kind, du, dv) in enumerate(patrols[site]): m.add(f'{site}Patrol{k}', kind, 'Orion Group', u0+du, coast[u0]-3+dv)
    for k, (kind, u, v) in enumerate([('ttnk', 76, 74), ('e2', 75, 77), ('e2', 78, 76)]):
        m.add(f'Roadblock{k}', kind, 'Orion Group', u, v)
    # The survivors' transports leave from the reef landing and follow the coast road to the clinic.
    m.add('ReefLanding', 'waypoint', 'Neutral', 84, 78)
    route = [('ReefRoadEast', 72, 77), ('ReefRoadMid', 58, 77), ('ReefRoadWest', 44, 76), ('TownGate', 32, 78), ('ClinicDoor', 22, 79)]
    for name, u, v in route: m.add(name, 'waypoint', 'Neutral', u, v)
    for a, b in [('OrionWaveEntry', 'WatchPost'), ('OrionWaveEntry', 'TownClinic'), ('ReefLanding', 'ClinicDoor'),
                 ('MissionSpawn', 'StrangerSite'), ('MissionSpawn', 'SurvivorsCove'), ('MissionSpawn', 'SurvivorsJetty')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    # Mission rules: the town's defences and generators are not part of the force (losing every unit loses the
    # mission), and Orion's patrol tanks are lighter export hulls so a force without a base can hold the town.
    m.write('Lights in the Water', 'Yemen', 'yemen', '8F7A45', extra_players=SURVIVORS, extra_rules=(
        'r2ycoastal:\n\t-MustBeDestroyed:\nr2ybunker:\n\t-MustBeDestroyed:\nnapowr:\n\t-MustBeDestroyed:\n'
        'htnk:\n\tHealth:\n\t\tHP: 260\nsapc:\n\tMobile:\n\t\tSpeed: 50\n'))
    types = [k for k, _ in force]
    mission = dict(id=m.id, map=m, title='Lights in the Water', faction='yemen', campaign='Lines of Hope', slot='Yemen',
        enemy='Orion Group', protect=['TownClinic'],
        briefing=('Captain Nabil Haidar, coast guard. Tonight the navigation lights along this reef coast lied. Spoofed '
                  'signals steered the fishing fleet onto the reef line, and three groups of survivors are stranded '
                  'on the beaches east of town.\n\nYou have a small mobile force and no base. Find all three groups. '
                  'The transports can only cross the reef at high tide, eight minutes from now; escort them from the '
                  'reef landing along the coast road to the town clinic. Orion Group patrols are '
                  'already closing in from the north, and their columns will strike the watch post and then the '
                  'town. The third group pulled someone out of the sea, a stranger nobody can explain.\n\nIf the '
                  'clinic falls or your force is lost, the operation fails.'),
        adaptation='An original RTS AI chapter on the terrain of Hodeidah Lifeline, with a new coast and new actors.')
    return chapter_entry(mission, [
        objective('Find the first group of survivors at the cove.', 'reach', types=types, target='SurvivorsCove', radius=5, count=3),
        objective('Find the second group by the old jetty.', 'reach', types=types, target='SurvivorsJetty', radius=5, count=3),
        objective('Find the third group on the far reef, with the stranger.', 'reach', types=types, target='StrangerSite', radius=5, count=3),
        # The transports can only cross the reef at high tide, eight minutes in: until then the force must cover
        # both the landing and the town (an idle town falls at about 12 minutes).
        objective('Hold on until high tide lets the transports reach the reef landing.', 'survive', seconds=480),
        objective('Escort the survivors from the reef landing to the town clinic.', 'escort', entry='ReefLanding',
                  route=[name for name, _, _ in route], count=2, requires=[0, 1, 2, 3]),
        objective('Keep the town clinic standing.', 'protect', ['TownClinic'])])

def hold_the_ferry_line():
    """Act III, chapter 2: a timed defence of a strait port (terrain of Straits Shield)."""
    m = ChapterMap('straits-shield', 'hold-the-ferry-line')
    m.add('OrionWaveEntry', 'waypoint', 'Neutral', 136, 94)
    # Three approaches, each held by a checkpoint. Missions.Wave sends each column at the first building still
    # standing, so Orion hits the north road, then the east road, then the south road, then the piers.
    for name, (u, v), guns in [('NorthCheckpoint', (88, 66), [('r2hisar', 93, 67)]),
                               ('EastCheckpoint', (104, 76), [('r2boran', 101, 74)]),
                               ('SouthCheckpoint', (90, 110), [('r2hisar', 95, 112)])]:
        m.add(name, 'caoutp', 'Turkey', u, v)
        for k, (kind, gu, gv) in enumerate(guns): m.add(f'{name}Gun{k}', kind, 'Turkey', gu, gv)
    # Then the two ferry piers, then the port base: once the checkpoints fall, the columns go for the piers.
    for name, kind, u, v in [('FerryPierNorth', 'caoutp', 77, 59), ('FerryPierSouth', 'caoutp', 67, 86),
                             ('TurkeyConyard', 'gacnst', 73, 88), ('TurkeyPowerOne', 'gapowr', 79, 86), ('TurkeyPowerTwo', 'gapowr', 82, 89),
                             ('TurkeyPowerThree', 'gapowr', 79, 92), ('TurkeyBarracks', 'gapile', 82, 95), ('TurkeyFactory', 'gaweap', 61, 91),
                             ('TurkeyRefinery', 'garefn', 84, 78)]:
        m.add(name, kind, 'Turkey', u, v)
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 80, 83)
    m.add('Tanya', 'tany', 'Tanya', 78, 84)
    force = [('r2trrifle', 6), ('r2trat', 4), ('r2bozkir', 2), ('r2aras', 2), ('r2gokkalkan', 1)]
    i = 0
    for kind, count in force:
        for _ in range(count):
            m.add(f'Aydin{i}', kind, 'Turkey', 86+i % 5*2, 99+i//5*2 + (i % 2)); i += 1
    # Four ferries cross the strait to the far shore once loading is done; an Orion boat picket waits in the channel.
    lanes = [[(68, 63), (66, 70), (63, 77), (57, 82), (49, 84), (42, 83)],
             [(69, 66), (67, 73), (62, 79), (54, 83), (46, 84), (44, 82)],
             [(62, 84), (55, 85), (48, 85), (40, 84)],
             [(60, 86), (53, 86), (45, 86), (38, 85)]]
    names = []
    for k, lane in enumerate(lanes):
        names.append([])
        for j, (u, v) in enumerate(lane):
            name = f'Ferry{k}Start' if j == 0 else f'Ferry{k}Shore' if j == len(lane)-1 else f'Ferry{k}Way{j}'
            m.add(name, 'waypoint', 'Neutral', u, v, where='water'); names[-1].append(name)
    for k, (u, v) in enumerate([(46, 87), (48, 89)]):
        m.add(f'OrionPicket{k}', 'dest', 'Orion Group', u, v, where='water')
    for a, b in [('OrionWaveEntry', 'NorthCheckpoint'), ('OrionWaveEntry', 'EastCheckpoint'), ('OrionWaveEntry', 'SouthCheckpoint'),
                 ('OrionWaveEntry', 'FerryPierNorth'), ('OrionWaveEntry', 'TurkeyConyard')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    # Mission rules: the ferries are slow civilian hulls (about two minutes across).
    m.write('Hold the Ferry Line', 'Turkey', 'turkey', 'A73731', extra_players=TANYA_SIDE, ally='Tanya', extra_rules='lcrf:\n\tMobile:\n\t\tSpeed: 50\n')
    mission = dict(id=m.id, map=m, title='Hold the Ferry Line', faction='turkey', campaign='Lines of Hope', slot='Turkey',
        enemy='Orion Group', protect=['FerryPierNorth', 'FerryPierSouth'],
        briefing=('Colonel Kemal Aydın. The port on the far side of the strait is the last ferry line out, and Orion '
                  'Group wants it closed. The town is loading four ferries for the far shore.\n\nHold the port for '
                  'twelve minutes. Orion columns will come down the north road, then the east road, then the south '
                  'road; each checkpoint you keep standing buys the town time. When loading is done the ferries sail '
                  'through the channel, where an Orion boat picket is waiting. Every one must reach the far '
                  'shore.\n\nIf either ferry pier falls, the line is broken.'),
        adaptation='An original RTS AI chapter on the terrain of Straits Shield, with new actors.')
    return chapter_entry(mission, [
        objective('Hold until the ferries finish loading.', 'survive', seconds=360),
        objective('Get all four ferries across to the far shore.', 'shipping', count=4, requires=[0], lanes=names),
        objective('Hold the ferry line for 12 minutes.', 'survive', seconds=720),
        objective('Keep both ferry piers standing.', 'protect', ['FerryPierNorth', 'FerryPierSouth'])])

def glass_island():
    """Act III, chapter 3: an infiltration past sweeping sensor masts (terrain of Haitan Network, its ore cleared and the
    plateau cut off from the lowland by a tidal channel with one causeway)."""
    m = ChapterMap('haitan-network', 'glass-island', art_check=True)
    m.clear_ore()
    for u in range(33, 62):
        for v in range(46, 49): m.paint(u, v, 'road' if 47 <= u <= 50 else 'water')
    # Lin's team lands on the western beach: Tanya (her 1953 commando art comes with the america faction), the network
    # specialist who copies the logs, and one Red Spear.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 3, 39)
    m.add('LandingBeach', 'waypoint', 'Neutral', 3, 39)
    m.add('Tanya', 'tany', 'China', 4, 38, Faction='america')
    m.add('Specialist', 'r2cnnetwork', 'China', 3, 40)
    m.add('RedSpear', 'r2redspear', 'China', 4, 41)
    # Sensor masts: (name, u, v, sweep [on, off] seconds or always on, offset). The bluff and the causeway can only be
    # crossed while their sweep is off; the ridge mast never sleeps but leaves a strip along the cliff; the vault's two
    # masts take turns.
    masts = [('MastBluff', 14, 40, [6, 14], 0), ('MastRidge', 32, 33, [], 0), ('MastCauseway', 48, 41, [8, 14], 4),
             ('MastGate', 64, 57, [8, 12], 0), ('MastVaultNorth', 80, 50, [10, 14], 0), ('MastVaultSouth', 79, 59, [10, 14], 12)]
    for name, u, v, _, _ in masts: m.add(name, 'naradr', 'Orion Group', u, v)
    m.add('CoreNode', 'gatech', 'Orion Group', 87, 55)
    # Guards: they fight anyone they see, but only the masts raise the alarm.
    for k, (kind, u, v) in enumerate([('e2', 52, 57), ('e2', 56, 55), ('dog', 53, 60), ('e2', 22, 44), ('flakt', 23, 45),
                                      ('e2', 70, 51), ('flakt', 71, 58), ('deso', 85, 52), ('e2', 90, 53), ('e2', 89, 59),
                                      ('dog', 84, 58), ('shk', 92, 56)]):
        m.add(f'Guard{k}', kind, 'Orion Group', u, v)
    # Where the hunters come from when a mast trips or goes dark.
    m.add('GarrisonWest', 'waypoint', 'Neutral', 24, 31)
    m.add('GarrisonEast', 'waypoint', 'Neutral', 74, 60)
    # The way out: a boat comes for the team at the north cove once the logs are copied.
    m.add('ExtractionCove', 'waypoint', 'Neutral', 80, 47)
    m.add('BoatLanding', 'waypoint', 'Neutral', 78, 40, where='water')
    m.add('BoatEntry', 'waypoint', 'Neutral', 93, 36, where='water')
    for a, b in [('LandingBeach', 'CoreNode'), ('CoreNode', 'ExtractionCove'), ('GarrisonWest', 'MastBluff'), ('GarrisonEast', 'MastVaultNorth')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    if not m.reachable('BoatEntry', 'BoatLanding', water=True): raise ValueError(f'{m.id}: no sea route for the boat')
    m.write('Glass Island', 'China', 'china', '3B7DD8', extra_rules=sensor_rules('naradr', 6))
    hunters = ['e2', 'e2', 'dog', 'e2', 'flakt', 'dog']
    # Lantern's intel: every mast is in sight from the start, so its zone has something to circle.
    events = [dict(id='intel', when=dict(time=0), reveal=[dict(at=name, radius=2) for name, *_ in masts]),
              dict(id='alarm', when=dict(detected='*'))]
    for name, u, *_ in masts:
        garrison = 'GarrisonWest' if u < 40 else 'GarrisonEast'
        events += [dict(id=f'alarm-{name}', when=dict(detected=name), spawn=[dict(at=garrison, to=name, types=hunters)]),
                   dict(id=f'dark-{name}', when=dict(killed=name), spawn=[dict(at=garrison, to=name, types=hunters)])]
    events.append(dict(id='boat', when=dict(objective=0), spawn=[dict(owner='China', at='BoatEntry', to='BoatLanding', types=['r2haiying'])],
                       reveal=[dict(at='ExtractionCove', radius=6)]))
    mission = dict(id=m.id, map=m, title='Glass Island', faction='china', campaign='Lines of Hope', slot='China',
        enemy='Orion Group', protect=[],
        sensors=[dict(actor=name, radius=6, **(dict(sweep=sweep, offset=offset) if sweep else {})) for name, _, _, sweep, offset in masts],
        events=events,
        briefing=('Commander Lin Haoran. The island no chart names is real, and the Obsidian Directorate watches it with '
                  'sensor masts. Tonight a three-man team lands on its western beach: Tanya, a network specialist and '
                  'one Red Spear.\n\nEach mast sees a circle around it. Some sweep and sleep; watch the circle dim before '
                  'you cross. Reach the core node in the east, deploy the specialist to copy the routing logs, then '
                  'bring him to the boat at the north cove before first light, eight minutes from the landing. Every mast '
                  'that sees you, or goes dark, sends the garrison to look.\n\nIf the island sees you too often, the boat '
                  'has to leave without the logs, or Tanya or the specialist falls, the operation fails.'),
        adaptation='An original RTS AI chapter on the terrain of Haitan Network, with a new channel and new actors.')
    return chapter_entry(mission, [
        objective('Copy the routing logs: deploy the network specialist beside the core node.', 'reach', types=['r2cnnetwork'],
                  target='CoreNode', radius=4, deploy=True),
        # First light: about three times the scripted player's time on normal (tools/mission-probe, plan "stealth"),
        # room for a first-time player to watch the sweeps.
        objective('Bring the specialist and the logs to the boat at the north cove before first light.', 'reach',
                  types=['r2cnnetwork'], target='ExtractionCove', radius=4, requires=[0], limit=480),
        objective("Stay out of the sensor masts' sight.", 'undetected', [name for name, *_ in masts], allowed=1),
        objective('Keep Tanya and the specialist alive.', 'protect', ['Tanya', 'Specialist'])])

def black_platform():
    """Act III, chapter 4: a boarding action on a jamming platform in open sea (the Bab al-Mandab map's frame, its land
    painted over: concrete deck modules joined by catwalks)."""
    m = ChapterMap('bab-al-mandab-passage', 'black-platform', art_check=True)
    m.clear_ore()
    m.fill(0, 0, m.w-1, m.h-1, 'water')
    # Decks (u0, v0, u1, v1): the landing pad, the control deck, the two generator wings and the crew deck; then the
    # catwalks between them.
    for box in [(44, 68, 52, 77), (42, 38, 54, 58), (33, 25, 37, 70), (59, 25, 63, 70), (42, 23, 54, 32),
                (47, 59, 49, 67), (38, 47, 41, 50), (55, 47, 58, 50), (38, 27, 41, 29), (55, 27, 58, 29),
                (47, 33, 49, 37), (38, 72, 43, 74), (53, 72, 58, 74)]:
        m.fill(*box, 'deck')
    # Commander Turki's boarding team on the landing pad: no base, no reinforcements.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 48, 73)
    m.add('LandingPad', 'waypoint', 'Neutral', 48, 73)
    team = [('Tanya', 'tany', 47, 70), ('Falcon1', 'r2falcon', 45, 71), ('Falcon2', 'r2falcon', 51, 71),
            ('Rifle1', 'r2sang', 45, 74), ('Rifle2', 'r2sang', 48, 75), ('Rifle3', 'r2sang', 51, 74), ('Lancer', 'r2saat', 49, 72),
            ('Engineer1', 'engineer', 46, 76), ('Engineer2', 'engineer', 50, 76)]
    for name, kind, u, v in team: m.add(name, kind, 'Saudi Arabia', u, v, **(dict(Faction='america') if kind == 'tany' else {}))
    # The Iron Curtain prototype in the control room keeps the four jammer generators untouchable until it is taken.
    m.add('CurtainControl', 'nairon', 'Orion Group', 47, 47)
    gens = [('GenNW', 34, 28), ('GenNE', 60, 28), ('GenSW', 34, 64), ('GenSE', 60, 64)]
    for name, u, v in gens: m.add(name, 'gapowr', 'Orion Group', u, v)
    # Two deck scanners take turns sweeping the control deck's sides and the catwalks to the wings; the lane down the
    # middle is out of their sight. If one sees the team, the deck crew comes running.
    scanners = [('ScannerWest', 43, 45, 0), ('ScannerEast', 52, 45, 8)]
    for name, u, v, _ in scanners: m.add(name, 'naradr', 'Orion Group', u, v)
    guards = [('e2', 45, 57), ('flakt', 51, 57), ('e2', 44, 53), ('e2', 52, 53), ('dog', 48, 55), ('deso', 45, 41),
              ('e2', 51, 41), ('flakt', 48, 39), ('e2', 35, 40), ('e2', 35, 56), ('flakt', 36, 33), ('dog', 35, 60),
              ('e2', 61, 40), ('e2', 61, 56), ('flakt', 60, 33), ('e2', 61, 60), ('shk', 48, 26), ('e2', 44, 28), ('e2', 52, 28)]
    for k, (kind, u, v) in enumerate(guards): m.add(f'Guard{k}', kind, 'Orion Group', u, v)
    # Where the deck crew and the counterattack come from: the crew deck, the three docks, and the open sea.
    for name, u, v in [('CrewQuarters', 48, 30), ('NorthDock', 48, 24), ('WestDock', 34, 48), ('EastDock', 62, 48)]:
        m.add(name, 'waypoint', 'Neutral', u, v)
    for name, u, v in [('SeaWest', 10, 48), ('SeaEast', 86, 48), ('SeaWestStation', 28, 48), ('SeaEastStation', 68, 48)]:
        m.add(name, 'waypoint', 'Neutral', u, v, where='water')
    for a, b in [('LandingPad', 'CurtainControl'), ('LandingPad', 'GenNW'), ('LandingPad', 'GenSE'), ('NorthDock', 'GenSW')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no deck route {a} -> {b}')
    for a, b in [('SeaWest', 'SeaWestStation'), ('SeaEast', 'SeaEastStation')]:
        if not m.reachable(a, b, water=True): raise ValueError(f'{m.id}: no sea route {a} -> {b}')
    # Mission rules: the control room's armoured core outlasts a few volleys while the team holds it, and the Falcons
    # bring no air strike (a boarding action: no reinforcements, nothing from outside).
    m.write('Black Platform', 'Saudi Arabia', 'saudi', '2E8B57', extra_rules=sensor_rules('naradr', 4)
            + 'nairon:\n\tHealth:\n\t\tHP: 2000\nr2falcon:\n\t-AirstrikePower@falcon:\n')
    crew = ['e2', 'e2', 'dog', 'e2', 'flakt']
    counter = ['e2', 'e2', 'flakt', 'e2']
    gen_names = [name for name, _, _ in gens]
    events = [dict(id='curtain', when=dict(time=0), grant=[dict(condition='invulnerability', actors=gen_names)]),
              dict(id='curtain-down', when=dict(objective=0), revoke=[dict(condition='invulnerability', actors=gen_names)]),
              dict(id='intel', when=dict(time=0), reveal=[dict(at=name, radius=2) for name, *_ in scanners]),
              dict(id='alarm', when=dict(detected='*'))]
    for name, *_ in scanners:
        events.append(dict(id=f'alarm-{name}', when=dict(detected=name), spawn=[dict(at='CrewQuarters', to=name, types=crew)]))
    # When the jamming stops: the north dock's crew at once, then a boat-load at the west and east docks in turn.
    events += [dict(id='jamming-off', when=dict(objective=1), reveal=[dict(radius=0)],
                    spawn=[dict(at='NorthDock', to='CurtainControl', types=counter + ['deso'])]),
               dict(id='counterattack', when=dict(event='jamming-off'), delay=30, repeat=40,
                    spawn=[dict(at='WestDock', to='CurtainControl', types=counter)]),
               dict(id='counterattack-east', when=dict(event='jamming-off'), delay=50, repeat=40,
                    spawn=[dict(at='EastDock', to='CurtainControl', types=counter)]),
               dict(id='gunboats', when=dict(event='jamming-off'), delay=50,
                    spawn=[dict(at='SeaWest', to='SeaWestStation', types=['hyd']), dict(at='SeaEast', to='SeaEastStation', types=['hyd'])])]
    mission = dict(id=m.id, map=m, title='Black Platform', faction='saudi', campaign='Lines of Hope', slot='Saudi Arabia',
        enemy='Orion Group', protect=['CurtainControl'],
        sensors=[dict(actor=name, radius=4, sweep=[8, 8], offset=offset) for name, _, _, offset in scanners],
        events=events,
        briefing=('Commander Turki Al-Zahrani. While this platform jams, no one can see the Directorate hub. Its four '
                  'jammer generators sit under an Iron Curtain prototype: nothing can touch them while the curtain '
                  'control room runs it.\n\nYour boarding team lands on the south pad with Tanya, two engineers and no '
                  'reinforcements. Clear the control deck, take the control room with an engineer to drop the curtain, '
                  'then let Tanya place charges on every generator out on the wings. When the jamming stops, Orion will '
                  'come from the docks and the sea: hold the control room until the picture comes back. Orion\'s relief '
                  'flotilla reaches the platform nine minutes after you land; the charges must be in before then. The '
                  'two deck scanners take turns; the lane down the middle is out of their sight.\n\nIf Tanya falls, '
                  'the control room is destroyed, both engineers are lost before it is taken, or the relief arrives '
                  'first, the operation fails.'),
        adaptation='An original RTS AI chapter on the frame of the Bab al-Mandab Passage map, repainted as open sea with a platform.')
    return chapter_entry(mission, [
        objective('Take the curtain control room with an engineer.', 'capture', ['CurtainControl']),
        # The relief flotilla: about twice the scripted player's time on normal, with the hold (plan "boarding"), and
        # room for a first-time player.
        objective('Place charges on all four jammer generators before the relief flotilla arrives.', 'destroy', gen_names,
                  requires=[0], limit=540),
        objective('Hold the control room until the picture comes back.', 'survive', seconds=120, requires=[1]),
        objective('Keep Tanya alive.', 'protect', ['Tanya']),
        objective('Keep an engineer alive until the control room is taken.', 'squad', ['Engineer1', 'Engineer2'], count=1, until=0),
        objective('Stay clear of the deck scanners.', 'undetected', [name for name, *_ in scanners], allowed=0, secondary=True)])

def every_light_on():
    """Act III, chapter 5, the finale: a full base against the Directorate hub (terrain of Straits Shield, the island
    chain's central landmass). Four other fronts are heard only on the radio; each is a mission event."""
    m = ChapterMap('straits-shield', 'every-light-on', art_check=True)
    # Colonel Badr's forward base in the south of the landmass.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 84, 113)
    for name, kind, u, v in [('SaudiConyard', 'gacnst', 80, 110), ('SaudiPowerOne', 'gapowr', 76, 116), ('SaudiPowerTwo', 'gapowr', 79, 118),
                             ('SaudiPowerThree', 'gapowr', 82, 120), ('SaudiRefinery', 'garefn', 86, 106), ('SaudiBarracks', 'gapile', 72, 109),
                             ('SaudiFactory', 'gaweap', 86, 116), ('PictureRelay', 'gaairc', 71, 112),
                             ('SaudiGuardNorth', 'r2saguard', 93, 106), ('SaudiGuardEast', 'r2saguard', 95, 113), ('SaudiTow', 'r2satow', 92, 118)]:
        m.add(name, kind, 'Saudi Arabia', u, v)
    m.add('SaudiHarvester', 'cmin', 'Saudi Arabia', 89, 110)
    force = [('r2m1a2s', 3), ('r2bradley', 2), ('r2sads', 1), ('r2sang', 4), ('r2saat', 3), ('engineer', 2)]
    i = 0
    for kind, count in force:
        for _ in range(count):
            m.add(f'Badr{i}', kind, 'Saudi Arabia', 88 + i % 6 * 2, 98 + i // 6 * 2 + (i % 2)); i += 1
    # The Directorate's three radar domes (the link to the regional network), each with a guard.
    domes = [('DomeWest', 50, 93), ('DomeNorth', 79, 64), ('DomeEast', 116, 62)]
    for name, u, v in domes: m.add(name, 'amradr', 'Orion Group', u, v)
    guards = {'DomeWest': [('tesla', 54, 96), ('nalasr', 46, 94), ('e2', 54, 97), ('e2', 56, 92), ('htnk', 57, 96),
                           ('tesla', 48, 95), ('flakt', 52, 90), ('htnk', 58, 93), ('deso', 52, 95)],
              'DomeNorth': [('tesla', 82, 69), ('nalasr', 75, 71), ('e2', 80, 72), ('flakt', 84, 66), ('htnk', 78, 74),
                            ('tesla', 75, 64), ('ttnk', 83, 73), ('e2', 81, 75), ('deso', 79, 70)],
              'DomeEast': [('tesla', 113, 67), ('nalasr', 119, 68), ('e2', 115, 70), ('flakt', 112, 64), ('ttnk', 117, 73),
                           ('tesla', 119, 64), ('htnk', 114, 74), ('e2', 118, 71), ('deso', 116, 68)]}
    for dome, items in guards.items():
        for k, (kind, u, v) in enumerate(items): m.add(f'{dome}Guard{k}', kind, 'Orion Group', u, v)
    # The hub at the eastern end: the rebuilt Chronosphere behind coils, sentry guns and a garrison.
    m.add('Chronosphere', 'gacsph', 'Orion Group', 129, 95)
    hub = [('tesla', 126, 88), ('tesla', 126, 96), ('tesla', 135, 90), ('tesla', 138, 98), ('nalasr', 128, 96),
           ('nalasr', 124, 92), ('naflak', 135, 91), ('naflak', 136, 96), ('apoc', 127, 92), ('htnk', 129, 101),
           ('ttnk', 135, 100), ('e2', 129, 94), ('e2', 133, 95), ('flakt', 128, 86), ('deso', 135, 92), ('e2', 136, 91),
           ('tesla', 122, 99), ('tesla', 129, 86), ('apoc', 132, 99), ('htnk', 124, 86), ('ttnk', 138, 93),
           ('e2', 126, 101), ('e2', 133, 88), ('flakt', 135, 92), ('deso', 130, 92)]
    for k, (kind, u, v) in enumerate(hub): m.add(f'Hub{k}', kind, 'Orion Group', u, v)
    # Wave routes: the hub's gate on land, the northern sea lane, and the water off the base's west shore.
    m.add('HubGate', 'waypoint', 'Neutral', 120, 96)
    m.add('NorthLane', 'waypoint', 'Neutral', 65, 38, where='water')
    m.add('BaseShore', 'waypoint', 'Neutral', 64, 112, where='water')
    # Where the strike team lands once the mainland towns are clear.
    m.add('StrikeLanding', 'waypoint', 'Neutral', 112, 100)
    for a, b in [('SaudiConyard', 'DomeWest'), ('SaudiConyard', 'DomeNorth'), ('SaudiConyard', 'DomeEast'),
                 ('SaudiConyard', 'Chronosphere'), ('HubGate', 'SaudiConyard'), ('StrikeLanding', 'Chronosphere')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    if not m.reachable('NorthLane', 'BaseShore', water=True): raise ValueError(f'{m.id}: no sea route for the gunboats')
    # The machine must be taken, not destroyed: the Iron Curtain holds it, and its capture is sealed until the strike.
    # The domes are hardened: a raid has to stay on them.
    m.write('Every Light On', 'Saudi Arabia', 'saudi', '2E8B57',
            extra_rules='gacsph:\n\tExternalCondition@sealed:\n\t\tCondition: sealed\n\tCapturable:\n\t\tRequiresCondition: !sealed\n'
                        'amradr:\n\tHealth:\n\t\tHP: 1800\n')
    events = [
        # Lin keeps the picture alive: the whole map is visible while the relay stands.
        dict(id='picture', when=dict(time=0), reveal=[dict(radius=0)]),
        dict(id='picture-lost', when=dict(killed='PictureRelay'), conceal=['picture']),
        dict(id='hub-sealed', when=dict(time=0), grant=[dict(condition='invulnerability', actors=['Chronosphere']),
                                                         dict(condition='sealed', actors=['Chronosphere'])]),
        # Turki holds the platform: the jamming stays off (radio only).
        dict(id='platform-holds', when=dict(time=75)),
        # Kemal closes the northern lane at eight minutes; until then Orion's gunboats come down it.
        dict(id='naval-wave', when=dict(time=150), repeat=110, until='lane-closed',
             spawn=[dict(at='NorthLane', to='BaseShore', types=['hyd', 'dest', 'hyd'])]),
        dict(id='lane-closed', when=dict(time=480)),
        dict(id='hub-wave', when=dict(time=240), repeat=150,
             spawn=[dict(at='HubGate', to='SaudiConyard', types=['htnk', 'e2', 'e2', 'flakt', 'e2', 'ttnk'])]),
        dict(id='domes-down', when=dict(objective=0), reveal=[dict(at='Chronosphere', radius=12)]),
        # Nabil reports the mainland towns clear at ten minutes: the final strike unlocks.
        dict(id='towns-clear', when=dict(time=600), revoke=[dict(condition='sealed', actors=['Chronosphere'])],
             spawn=[dict(owner='Saudi Arabia', at='StrikeLanding', to='StrikeLanding', types=['engineer', 'engineer', 'r2bradley', 'r2bradley'])]),
    ]
    mission = dict(id=m.id, map=m, title='Every Light On', faction='saudi', campaign='Lines of Hope', slot='Saudi Arabia',
        enemy='Orion Group', protect=['SaudiConyard'], events=events,
        briefing=('Colonel Badr Al-Shammari. The Directorate hub stands at the eastern end of this island, with the rebuilt '
                  'Chronosphere at its heart. Three radar domes link it to every screen on the coast: destroy them first.\n\n'
                  'You are not alone tonight, but the other fronts are only voices on the radio. Commander Lin keeps the '
                  'picture alive through your radar relay; lose the relay and the fog comes back. Commander Turki holds '
                  'the jamming platform. Colonel Kemal is closing the northern sea lane; until he does, gunboats will come '
                  'down it. Captain Nabil is clearing the mainland towns, and the final strike waits for his word: the '
                  'Chronosphere cannot be taken before then.\n\nCapture the Chronosphere with an engineer. It is shielded: '
                  'it cannot be destroyed, only taken. If the construction yard falls, the operation fails.'),
        adaptation='An original RTS AI chapter on the terrain of Straits Shield, with new actors.')
    return chapter_entry(mission, [
        objective('Destroy the three radar domes to sever the Directorate link.', 'destroy', [name for name, _, _ in domes]),
        objective('Capture the Chronosphere once the mainland towns are clear.', 'capture', ['Chronosphere'], requires=[0], after=['towns-clear']),
        objective('Keep the radar relay standing.', 'protect', ['PictureRelay'], secondary=True)])

# Lines of Hope, Act IV (Aftershocks): two chapters on separate coasts and days, one per faction, against the Directorate's
# last cells. They never meet; Lantern's desk connects them on the radio.
# Both give Orion power, so their tesla coils charge (Act III's run unpowered); the coil's charge sound comes from the
# sound check (fix/tesla-sound: sound-fallbacks.yaml until the mod ships btespow.wav).
SALT_ROAD_TOWN ='PlayerReference@Town:\n\tName: Town\n\tNonCombatant: True\n\tFaction: iran\n\tColor: B8B2A2\n'

def sweet_water():
    """Act IV, chapter 1 (Iran): a salt-desert trade road and a port town whose water plant, with a coil cache under it,
    a Directorate cell holds (terrain of Jizan Corridor, with a painted coast, salt flat, road and dock). After Allies
    02 "Five to One" (clear a road before the convoy is due) and Soviet 07 "Core of the Matter" (retake a plant)."""
    import math
    m = ChapterMap('jizan-corridor', 'sweet-water', art_check=True)
    coast = {v: 86 + round(2*math.sin(v*0.21)) for v in range(m.h)}
    for v in range(m.h):
        for u in range(coast[v]-2, m.w): m.paint(u, v, 'beach' if u < coast[v] else 'water')
    # The salt flat the trade road crosses (the tileset's sand), then the road itself, the spur to the town cistern and
    # the town's dock.
    for u in range(m.w):
        for v in range(m.h):
            if ((u-40)/17)**2 + ((v-50)/24)**2 < 1: m.paint(u, v, 'beach')
    m.fill(1, 49, 63, 50, 'road'); m.fill(56, 30, 57, 50, 'road'); m.fill(56, 30, 66, 31, 'road')
    m.fill(coast[51]-2, 50, coast[51]+5, 52, 'deck')
    m.clear_ore(60, 24, 95, 75)
    # Colonel Tavakoli's road camp at the west end of the salt road. Its buildings come first: the raids go for the
    # oldest one still standing.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 10, 64)
    for name, kind, u, v in [('IranConyard', 'nacnst', 8, 58), ('IranPowerOne', 'napowr', 3, 57), ('IranPowerTwo', 'napowr', 3, 62),
                             ('IranBarracks', 'nahand', 15, 56), ('IranFactory', 'naweap', 13, 63), ('IranRefinery', 'narefn', 13, 71),
                             ('IranRadar', 'naradr', 4, 68), ('IranBunkerNorth', 'r2irbunker', 9, 52), ('IranBunkerEast', 'r2irbunker', 20, 53)]:
        m.add(name, kind, 'Iran', u, v)
    force = [('r2karrar', 4), ('r2raad', 1), ('r2basij', 6), ('r2toophan', 3), ('engineer', 3)]
    i = 0
    for kind, count in force:
        for _ in range(count):
            m.add(f'Tavakoli{i}', kind, 'Iran', 19 + i % 6*2, 57 + i//6*2 + (i % 2)); i += 1
    # Three roadblocks across the salt road: a sentry gun and a tesla coil on the road itself (the coils run on the
    # plant's power station), a squad and armour around them.
    roadblocks = [('RoadblockWest', 34, 49, False, [('e2', -2, -3), ('e2', 2, 3), ('flakt', 0, 4), ('htnk', 3, -3), ('e2', -1, -4)]),
                  ('RoadblockMid', 46, 50, False, [('e2', -2, -3), ('e2', 2, 3), ('flakt', -1, 4), ('deso', 3, -2), ('htnk', -3, 3), ('e2', 1, 4)]),
                  ('RoadblockEast', 57, 49, True, [('e2', -2, -3), ('e2', 2, 3), ('flakt', 0, -4), ('deso', -3, 3), ('htnk', 3, -3), ('ttnk', 4, 3)])]
    for name, u, v, coil, guards in roadblocks:
        m.add(name+'Gun', 'nalasr', 'Orion Group', u, v)
        if coil: m.add(name+'Coil', 'tesla', 'Orion Group', u+2, v+(1 if v == 49 else -1))
        for k, (kind, du, dv) in enumerate(guards): m.add(f'{name}Guard{k}', kind, 'Orion Group', u+du, v+dv)
    # The port town: a few buildings of the town's own, and the cistern the trucks fill.
    for name, kind, u, v in [('TownHall', 'nahand', 67, 24), ('TownMarket', 'nadept', 73, 30), ('TownWorks', 'napowr', 79, 24)]:
        m.add(name, kind, 'Town', u, v)
    # The desalination plant on the shore, held by the cell, with the vault and its coil cache beside it; the power
    # station north of it, by the coast road, feeds the cell's coils: take it and they go dark.
    m.add('WaterPlant', 'narefn', 'Orion Group', 72, 56, FreeActor='False')
    m.add('PlantPower', 'nanrct', 'Orion Group', 80, 36)
    m.add('CoilVault', 'natech', 'Orion Group', 71, 64)
    for name, kind, u, v in [('PlantTeslaNorth', 'tesla', 69, 54), ('PlantTeslaSouth', 'tesla', 68, 63), ('PlantGun', 'nalasr', 76, 54),
                             ('PlantFlak', 'naflak', 81, 56), ('PlantTeslaEast', 'tesla', 82, 61), ('PlantGunWest', 'nalasr', 65, 58)]:
        m.add(name, kind, 'Orion Group', u, v)
    for k, (kind, u, v) in enumerate([('e2', 67, 57), ('e2', 76, 59), ('e2', 76, 64), ('e2', 66, 52), ('e2', 70, 69),
                                      ('flakt', 75, 69), ('deso', 74, 63), ('htnk', 65, 61), ('htnk', 72, 51), ('ttnk', 80, 53),
                                      ('ttnk', 67, 66), ('shk', 73, 52),
                                      # the power station's guard
                                      ('e2', 77, 34), ('e2', 84, 38), ('flakt', 80, 42), ('htnk', 76, 39)]):
        m.add(f'PlantGuard{k}', kind, 'Orion Group', u, v)
    # The army water trucks wait at the west edge of the salt; the cell's raiders camp in the northern hills; its
    # recovery boat comes to the town dock.
    route = [('RoadCamp', 14, 50), ('SaltWest', 28, 50), ('SaltMid', 40, 50), ('SaltEast', 52, 50), ('TownGate', 56, 40), ('Cistern', 63, 32)]
    m.add('TruckEntry', 'waypoint', 'Neutral', 2, 50)
    for name, u, v in route: m.add(name, 'waypoint', 'Neutral', u, v)
    m.add('RaidCamp', 'waypoint', 'Neutral', 44, 6)
    m.add('Dock', 'waypoint', 'Neutral', coast[51]+2, 51)
    m.add('DockWater', 'waypoint', 'Neutral', coast[51]+3, 54, where='water')
    m.add('SeaApproach', 'waypoint', 'Neutral', 93, 51, where='water')
    for a, b in [('TruckEntry', 'Cistern'), ('RaidCamp', 'IranConyard'), ('Dock', 'CoilVault'), ('RoadCamp', 'WaterPlant'), ('Dock', 'WaterPlant')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    if not m.reachable('SeaApproach', 'DockWater', water=True): raise ValueError(f'{m.id}: no sea route to the dock')
    # Mission rules: the trucks are slow, laden; the plant and the vault cannot be destroyed while the cell holds them
    # ("intact", granted at the start: the town needs the plant, and the coils hold a charge), and the vault cannot be
    # captured until its lock is cut ("sealed").
    intact = '\tExternalCondition@intact:\n\t\tCondition: intact\n\tDamageMultiplier@intact:\n\t\tModifier: 0\n\t\tRequiresCondition: intact\n'
    m.write('Sweet Water', 'Iran', 'iran', '6A9E3F', extra_players=SALT_ROAD_TOWN, extra_rules=(
        'sapc:\n\tMobile:\n\t\tSpeed: 70\nnarefn:\n' + intact + 'nanrct:\n' + intact + 'natech:\n' + intact
        + '\tExternalCondition@sealed:\n\t\tCondition: sealed\n\tCapturable:\n\t\tRequiresCondition: !sealed\n'))
    guns = [name+'Gun' for name, *_ in roadblocks]
    events = [
        dict(id='plant-held', when=dict(time=0), grant=[dict(condition='intact', actors=['WaterPlant', 'PlantPower', 'CoilVault']),
                                                         dict(condition='sealed', actors=['CoilVault'])]),
        # Lantern's picture: the three roadblocks and the plant.
        dict(id='intel', when=dict(time=0), reveal=[dict(at=name, radius=3) for name in guns] + [dict(at='WaterPlant', radius=3)]),
        # The cell's raiders hit the road camp until the plant is retaken.
        dict(id='raid', when=dict(time=300), repeat=180, until='water-on',
             spawn=[dict(at='RaidCamp', to='IranConyard', types=['e2', 'e2', 'flakt', 'e2', 'deso'])]),
        dict(id='trucks-rolling', when=dict(objective=0)),
        dict(id='trucks-in', when=dict(objective=1)),
        dict(id='water-on', when=dict(objective=2), reveal=[dict(at='WaterPlant', radius=10)]),
        # The cell's recovery boat lands at the dock for the coils while the engineers cut the vault's lock.
        dict(id='recovery', when=dict(event='water-on'), delay=20, repeat=40, until='cache-secured',
             spawn=[dict(at='Dock', to='CoilVault', types=['e2', 'e2', 'flakt', 'deso', 'e2', 'htnk'])]),
        dict(id='gunboat', when=dict(event='water-on'), delay=30, spawn=[dict(at='SeaApproach', to='DockWater', types=['hyd', 'hyd'])]),
        dict(id='vault-open', when=dict(event='water-on'), delay=45, revoke=[dict(condition='sealed', actors=['CoilVault'])]),
        dict(id='cache-secured', when=dict(objective=3)),
    ]
    mission = dict(id=m.id, map=m, title='Sweet Water', faction='iran', campaign='Lines of Hope', slot='Iran',
        enemy='Orion Group', protect=['IranConyard'], events=events,
        briefing=('Colonel Arash Tavakoli. A cell of the Obsidian Directorate has seized the desalination and power plant '
                  'of a port town on the salt coast and cut the town\'s water. Under the plant is a cache of Chronosphere '
                  'coils the cell means to take away by sea.\n\nArmy water trucks are waiting at the western edge of the '
                  'salt, and they are due on the road in ten minutes. The cell has blocked the salt road in three places: '
                  'destroy each roadblock\'s gun before then, and bring the trucks through to the town cistern. Retake the '
                  'plant with engineers: its pumps, and the power station that feeds the cell\'s coils. When the lock on '
                  'the vault is cut, take the cache whole with an engineer. Nothing on the plant can be destroyed.\n\nRaiders '
                  'from the northern hills will strike the road camp. If the construction yard falls, the trucks are lost, '
                  'or the road is still closed when the trucks are due, the operation fails.'),
        adaptation='An original RTS AI chapter on the terrain of Jizan Corridor, with a new coast, salt flat and actors.')
    return chapter_entry(mission, [
        objective('Clear the three roadblocks on the salt road before the water trucks are due.', 'destroy', guns, limit=600),
        objective('Bring the water trucks through to the town cistern.', 'escort', entry='TruckEntry',
                  route=[name for name, _, _ in route], count=2, requires=[0]),
        objective('Retake the water plant: capture its pumps and its power station with engineers.', 'capture', ['WaterPlant', 'PlantPower']),
        objective('Take the coil cache in the plant vault with an engineer.', 'capture', ['CoilVault'], requires=[2], after=['vault-open'])])

def contact_rules(kind, radius):
    """Map rules for the contacts on the picture (each one a Missions.Sensor). One actor type carries both the real
    contacts and the phantoms the Directorate paints. A phantom (condition "phantom", granted by an event) has no
    weapons and takes a tenth of the damage while unverified, so a unit that fires on it has time to be called off;
    once a player unit comes within the radius (the sensor trips: verified) or the relays fall ("spoof-off"), it fades
    behind a cloak nothing detects and cannot be hurt. Rings: amber while unverified, pale for a verified phantom, red for
    a verified real contact."""
    ghost = 'phantom && (sensor-tripped || spoof-off)'
    def circle(name, color, width, when):
        return (f'\tWithRangeCircle@{name}:\n\t\tRange: {radius}c0\n\t\tVisible: Always\n\t\tValidRelationships: Ally, Neutral, Enemy\n'
                f'\t\tColor: {color}\n\t\tWidth: {width}\n\t\tBorderColor: 00000080\n\t\tBorderWidth: {width+2}\n\t\tRequiresCondition: {when}\n')
    out = f'{kind}:\n' + ''.join(f'\tExternalCondition@{c}:\n\t\tCondition: {c}\n' for c in ('phantom', 'spoof-off', 'sensor-on', 'sensor-tripped'))
    for name, n in resolve(rules, kind).items():
        if name.startswith('Armament'):
            cond = n['children'].get('RequiresCondition', node())['value']
            out += f'\t{name}:\n\t\tRequiresCondition: {cond + " && " if cond else ""}!phantom\n'
    out += '\tDamageMultiplier@unverified:\n\t\tModifier: 10\n\t\tRequiresCondition: phantom && !sensor-tripped && !spoof-off\n'
    out += f'\tDamageMultiplier@ghost:\n\t\tModifier: 0\n\t\tRequiresCondition: {ghost}\n'
    out += f'\tCloak@ghost:\n\t\tInitialDelay: 0\n\t\tCloakDelay: 0\n\t\tUncloakOn: None\n\t\tDetectionTypes: Ghost\n\t\tRequiresCondition: {ghost}\n'
    return out + (circle('contact', 'FFB53CF0', 2, 'sensor-on && !sensor-tripped && !spoof-off') + circle('ghost', 'C8DCE6A0', 1, ghost)
                  + circle('hostile', 'FF3A2AF0', 3, f'!phantom && sensor-on && (sensor-tripped || spoof-off)'))

# Ghosts on the Glass: the families' shelters (a non-combatant side nobody fires on) and the contacts (a side hostile to
# the player and allied to Orion: the picture marks every one of them hostile, real or not).
HARBOUR_CIVILIANS = 'PlayerReference@Civilians:\n\tName: Civilians\n\tNonCombatant: True\n\tFaction: israel\n\tColor: D8D2C4\n'
CONTACTS = 'PlayerReference@Contacts:\n\tName: Contacts\n\tFaction: russia\n\tColor: 545D66\n\tAllies: Orion Group\n\tEnemies: Israel\n'

def ghosts_on_the_glass():
    """Act IV, chapter 2 (Israel): a harbour city whose picture a Directorate cell fills with phantom contacts to provoke
    a strike on nothing (the Bab al-Mandab map's frame repainted as a bay with a land bridge across its head). After
    Soviet 03 "Covert Cleanup" (find the real threat among the people around it) and Negotiations (a town full of
    civilians: nothing fires carelessly)."""
    m = ChapterMap('bab-al-mandab-passage', 'ghosts-on-the-glass', art_check=True)
    m.clear_ore()
    # The bay: land across its head in the north joins the city's shore (west) to the cape (east).
    m.fill(0, 0, m.w-1, 12, 'clear')
    m.fill(23, 13, 66, 14, 'beach')
    for box in [(84, 17, 93, 29), (87, 49, 94, 61), (74, 74, 79, 83), (58, 2, 66, 5)]: m.fill(*box, 'rough')
    # Roads: down the city's shore, across the bay head, down the cape; piers at the fishing quay and the harbour.
    m.fill(14, 7, 82, 8, 'road'); m.fill(14, 7, 15, 92, 'road'); m.fill(81, 7, 82, 86, 'road')
    for box in [(21, 34, 29, 35), (21, 70, 30, 71), (21, 80, 28, 81)]: m.fill(*box, 'deck')
    m.lay_ore(1, 53, 6, 61)
    # Colonel Ronen's harbour command in the south of the city's shore, with the ore field north of it.
    m.add('MissionSpawn', 'mpspawn', 'Neutral', 10, 77)
    for name, kind, u, v in [('IsraelConyard', 'gacnst', 6, 72), ('IsraelPowerOne', 'gapowr', 3, 66), ('IsraelPowerTwo', 'gapowr', 2, 80),
                             ('IsraelBarracks', 'gapile', 11, 66), ('IsraelFactory', 'gaweap', 8, 84), ('IsraelRadar', 'gaairc', 16, 74),
                             ('IsraelRefinery', 'garefn', 15, 67), ('IsraelSentry', 'r2ilsentry', 18, 57), ('IsraelBeachGun', 'r2ilatpost', 20, 59),
                             ('IsraelSentryNorth', 'r2ilsentry', 10, 55), ('IsraelATPost', 'r2ilatpost', 19, 90)]:
        m.add(name, kind, 'Israel', u, v)
    force = [('r2merkava', 3), ('r2namer', 2), ('r2ilrifle', 4), ('r2ilat', 3), ('r2ilobserver', 3), ('engineer', 1)]
    i = 0
    for kind, count in force:
        for _ in range(count):
            m.add(f'Ronen{i}', kind, 'Israel', 9 + i % 6*2, 60 + i//6*2 + (i % 2)); i += 1
    for k, (u, v) in enumerate([(27, 85), (29, 88)]): m.add(f'Patrol{k}', 'r2ilpatrol', 'Israel', u, v, where='water')
    # The city: three public shelters the families go down into.
    shelters = [('ShelterNorth', 5, 21), ('ShelterSchool', 8, 34), ('ShelterQuay', 4, 47)]
    for name, u, v in shelters: m.add(name, 'gapile', 'Civilians', u, v)
    # The cell on the cape: three relay towers that paint the phantoms onto every screen in the city, the power station
    # that feeds them and its coils, and their guards.
    relays = [('RelayNorth', 76, 18), ('RelayCape', 87, 42), ('RelaySouth', 84, 68)]
    for name, u, v in relays: m.add(name, 'naradr', 'Orion Group', u, v)
    m.add('CellPower', 'nanrct', 'Orion Group', 90, 54)
    guards = {'RelayNorth': [('nalasr', 79, 15), ('e2', 74, 16), ('e2', 78, 22), ('flakt', 72, 18), ('htnk', 80, 20)],
              'RelayCape': [('tesla', 84, 46), ('nalasr', 85, 39), ('e2', 89, 46), ('e2', 84, 41), ('deso', 88, 39), ('htnk', 88, 44)],
              'RelaySouth': [('nalasr', 81, 65), ('nalasr', 86, 72), ('e2', 82, 71), ('e2', 87, 66), ('flakt', 85, 64), ('ttnk', 80, 70), ('htnk', 88, 71)],
              'CellPower': [('ttnk', 87, 58), ('e2', 92, 52), ('e2', 89, 61)]}
    for site, items in guards.items():
        for k, (kind, u, v) in enumerate(items): m.add(f'{site}Guard{k}', kind, 'Orion Group', u, v)
    # The picture's nine contacts. Six are phantoms (nothing there: the relays paint them); three are real.
    contacts = [('Contact1', 'hyd', 28, 38, True),    # off the fishing quay
                ('Contact2', 'hyd', 40, 62, False),   # mid-bay: a real gunboat
                ('Contact3', 'hyd', 39, 46, True),    # in the lee of the lighthouse island
                ('Contact4', 'htnk', 34, 10, True),   # on the bay-head road
                ('Contact5', 'htnk', 56, 10, False),  # on the bay-head road: real armour
                ('Contact6', 'htnk', 13, 37, True),   # in the school yard
                ('Contact7', 'htnk', 10, 19, True),   # beside the north shelter
                ('Contact8', 'htnk', 80, 47, False),  # on the cape road, below the relay
                ('Contact9', 'hyd', 46, 87, True)]    # on the southern approach
    for name, kind, u, v, _ in contacts: m.add(name, kind, 'Contacts', u, v, where='water' if kind == 'hyd' else 'land')
    phantoms = [name for name, *_, phantom in contacts if phantom]
    # Warning lines a little wider than the contacts on the city's road and the bay head: a column closing on one there
    # hears it on the radio before anything opens fire.
    warn = [('WarnSchool', 'Contact6'), ('WarnNorth', 'Contact7'), ('WarnBridge', 'Contact4')]
    for name, contact in warn:
        c = next(x for x in contacts if x[0] == contact)
        m.add(name, 'waypoint', 'Neutral', c[2], c[3])
    # The proxy that records a strike on nothing: a phantom destroyed before it was verified kills it, and the mission
    # with it. It sits in the middle of the bay, where the picture says the contacts are.
    m.add('ContactPicture', 'waypoint', 'Neutral', 40, 54, where='water')
    # Where Orion lands (the beach north of the harbour), its strike group at the end, and the harbour mouth.
    m.add('LandingBeach', 'waypoint', 'Neutral', 21, 49)
    m.add('SeaSouth', 'waypoint', 'Neutral', 52, 93, where='water')
    m.add('HarbourMouth', 'waypoint', 'Neutral', 32, 78, where='water')
    for a, b in [('IsraelConyard', 'RelayNorth'), ('IsraelConyard', 'RelayCape'), ('IsraelConyard', 'RelaySouth'),
                 ('LandingBeach', 'IsraelConyard'), ('IsraelConyard', 'Contact6'), ('IsraelConyard', 'Contact8')]:
        if not m.reachable(a, b): raise ValueError(f'{m.id}: no land route {a} -> {b}')
    for a, b in [('Patrol0', 'Contact1'), ('Patrol0', 'Contact3'), ('Patrol0', 'Contact9'), ('SeaSouth', 'HarbourMouth')]:
        if not m.reachable(a, b, water=True): raise ValueError(f'{m.id}: no sea route {a} -> {b}')
    # Nothing the player starts with can see a phantom and fire on it before anyone has moved: every phantom lies beyond
    # the longest reach (a weapon's range or the vision of the actor) of every armed unit and gun of the player's.
    def cells(a, b):
        (ax, ay), (bx, by) = [map(int, m.actors[n]['children']['Location']['value'].split(',')) for n in (a, b)]
        return ((ax-bx)**2 + (ay-by)**2) ** 0.5
    armed = [n for n, a in m.actors.items() if a['children']['Owner']['value'] == 'Israel' and any(k.startswith('Armament') for k in resolve(rules, a['value']))]
    for p in phantoms:
        near = min(armed, key=lambda n: cells(n, p))
        if cells(near, p) < 12: raise ValueError(f'{m.id}: phantom {p} is {cells(near, p):.1f} cells from {near}')
    m.write('Ghosts on the Glass', 'Israel', 'israel', '3A6EA5', extra_players=HARBOUR_CIVILIANS + CONTACTS,
            enemies=('Contacts',), orion_allies=('Contacts',), extra_rules=(
                contact_rules('htnk', 3) + contact_rules('hyd', 3)
                + 'waypoint:\n\tHealth:\n\t\tHP: 1\n\tHitShape:\n\tExternalCondition@struck:\n\t\tCondition: struck\n'
                  '\tKillsSelf@struck:\n\t\tRequiresCondition: struck\n'))
    names = [name for name, *_ in contacts]
    landing = ['e2', 'e2', 'flakt', 'htnk', 'e2']
    events = [dict(id='phantoms', when=dict(time=0), grant=[dict(condition='phantom', actors=phantoms)]),
              # Lantern's triangulation: the three relays are on the picture from the start.
              dict(id='intel', when=dict(time=0), reveal=[dict(at=name, radius=3) for name, *_ in relays])]
    events += [dict(id=f'struck-{p}', when=dict(killed=p), grant=[dict(condition='struck', actors=['ContactPicture'])]) for p in phantoms]
    events += [dict(id='warn-school', when=dict(detected='WarnSchool')), dict(id='warn-north', when=dict(detected='WarnNorth')),
               dict(id='warn-bridge', when=dict(detected='WarnBridge')),
               dict(id='ghost-quay', when=dict(detected='Contact1')), dict(id='ghost-school', when=dict(detected='Contact6')),
               dict(id='ghost-north', when=dict(detected='Contact7')), dict(id='ghost-bridge', when=dict(detected='Contact4')),
               dict(id='real-bridge', when=dict(detected='Contact5')), dict(id='real-cape', when=dict(detected='Contact8')),
               # Orion lands on the beach north of the harbour while the relays stand.
               dict(id='landing', when=dict(time=210), repeat=150, until='picture-clean',
                    spawn=[dict(at='LandingBeach', to='IsraelConyard', types=landing)]),
               # The relays fall: every phantom fades and the picture is clean; the real strike group shows itself.
               dict(id='picture-clean', when=dict(objective=1), grant=[dict(condition='spoof-off', actors=names)], reveal=[dict(radius=0)]),
               dict(id='strike-group', when=dict(event='picture-clean'), delay=15, repeat=45, until='held',
                    spawn=[dict(at='LandingBeach', to='IsraelConyard', types=['htnk', 'e2', 'e2', 'flakt', 'deso']),
                           dict(at='SeaSouth', to='HarbourMouth', types=['hyd', 'hyd'])]),
               dict(id='held', when=dict(objective=2))]
    # Eyes on: a contact is verified only from within three cells, closer than almost any weapon reaches.
    sensors = [dict(actor=name, radius=3) for name in names] + [dict(actor=name, radius=9) for name, _ in warn]
    mission = dict(id=m.id, map=m, title='Ghosts on the Glass', faction='israel', campaign='Lines of Hope', slot='Israel',
        enemy='Orion Group', protect=['IsraelConyard'], sensors=sensors, events=events,
        briefing=('Lieutenant Colonel Maya Ronen. The harbour city\'s picture shows nine contacts closing on it, and most '
                  'of them are not there. A cell of the Obsidian Directorate is painting phantoms onto every screen in the '
                  'city from relay towers on the cape across the bay. It wants the city to fire first, on nothing, '
                  'and to sell the picture.\n\nEvery contact is marked by a ring. Before anything fires on one, verify it: '
                  'a unit of yours must come within its ring. A phantom fades and its ring turns pale; a real contact\'s '
                  'ring turns red. Send forward observers first, and set approaching units to Return fire so they never '
                  'shoot first. Then take the road round the head of the bay, destroy the three relay towers, and hold '
                  'the harbour against the strike group behind the lie.\n\nThe families are in three public shelters. If '
                  'the city fires on a phantom, a shelter falls, or the construction yard is lost, the operation fails.'),
        adaptation='An original RTS AI chapter on the frame of the Bab al-Mandab Passage map, repainted as a harbour bay.')
    return chapter_entry(mission, [
        objective('Fire on nothing you have not verified.', 'protect', ['ContactPicture']),
        objective('Destroy the three relay towers on the cape before first light.', 'destroy', [name for name, *_ in relays], limit=960),
        objective('Hold the harbour until the strike group turns back.', 'survive', seconds=180, requires=[1]),
        objective('Keep the shelters standing.', 'protect', [name for name, *_ in shelters]),
        objective('Verify every contact on the picture.', 'scout', names, radius=3, secondary=True)])

def chapters():
    return [lights_in_the_water(), hold_the_ferry_line(), glass_island(), black_platform(), every_light_on(),
            sweet_water(), ghosts_on_the_glass()]

def originals():
    """Original art for the nine original countries (isometric only): content/ea-art.yaml, ea-sequences.yaml,
    ea-models.yaml and ea-files.json. Render-only; see tools/ea_originals.py. Unless --no-ea-audio, also their original
    unit voices and the Attack Dog's barks and bite for every faction: content/ea-audio.yaml (rules), ea-voices.yaml,
    ea-weapons.yaml and ea-audio.json; see tools/ea_voices.py."""
    import ea_originals
    import ea_voices
    generator = ea_originals.Generator(args.mod.resolve(), OUT).plan()
    voices = None if args.no_ea_audio else ea_voices.VoiceGenerator(generator).plan()
    if args.ea_list:
        files = generator.needed_files()
        body = {'schema': 1, 'files': files, 'actors': sorted(generator.actors), 'images': len(generator.images),
                'models': len(generator.models)}
        body['planSha256'] = hashlib.sha256(json.dumps(files).encode()).hexdigest()
        if voices is not None:
            body['audio'] = voices.needed_clips()
            body['audioActors'] = sorted(voices.actors)
            body['audioPlanSha256'] = ea_voices.plan_digest(body['audio'])
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
    if voices is not None:
        audio = manifest.get('audio')
        if audio is None:
            raise ValueError(f'{args.ea_art / "EA-INPUTS.json"} records no original voice clips: run tools/prepare-ea-art.py '
                             'plan, extract and manifest again (or pass --no-ea-audio for original art only)')
        folder = args.ea_art / audio['folder']
        for f in audio['files']:
            if hashlib.sha256((folder / f['name']).read_bytes()).hexdigest() != f['sha256']:
                raise ValueError(f'original clip {f["name"]} differs from EA-INPUTS.json')
        # Fails when a clip the rules name is neither extracted nor recorded as absent from RA2.
        voices.generate([f['name'] for f in audio['files']], audio['absent'])
        vs = voices.write(OUT)
        print(f"original voices: {len(vs['actors'])} actors, {len(voices.voice_nodes)} voice sets, {len(vs['clips'])} clips, "
              f"{len(vs['absent'])} absent from RA2 (project sound kept), weapons {', '.join(vs['weapons'])}")
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
    ea_audio=ea_manifest is not None and not args.no_ea_audio
    receipt={'gameMode':args.game_mode,'modId':'rtsai-topdown' if CLASSIC_MODE else 'rtsai','gridType':'Rectangular' if CLASSIC_MODE else 'RectangularIsometric','compilerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
             'eaArt':({'manifestSha256':ea_manifest['sha256'],'files':len(ea_manifest['files']),'notice':ea_manifest['notice'],'generatorSha256':hashlib.sha256((Path(__file__).parent/'ea_originals.py').read_bytes()).hexdigest()} if ea_manifest else None),'eaAudio':({'manifestSha256':ea_manifest['audio']['sha256'],'clips':len(ea_manifest['audio']['files']),'absent':len(ea_manifest['audio']['absent']),'generatorSha256':hashlib.sha256((Path(__file__).parent/'ea_voices.py').read_bytes()).hexdigest()} if ea_audio else None),'sources':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(set(sources))],'outputs':[{'path':str(p.relative_to(OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.rglob('*')) if p.is_file()]}
    (OUT/'mode-provenance.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print('prepared nine additional countries, five adapted missions and one original Hezbollah exercise')
