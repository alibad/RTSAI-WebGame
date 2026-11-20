// Node 22.18+ strips the pure adviser's TypeScript types. No browser, model or server needed.
// The parity section also requires the sibling OpenRA-AI checkout (or OPENRA_AI_ROOT).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nextAdvice, assessThreat, desiredHarvesterCount, EnemyBaseMemory } from '../web/src/adviser.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companion = path.join(process.env.OPENRA_AI_ROOT ?? path.resolve(repo, '../RTSAI-Mod/companion'), 'services/companion/src');
// PYTHON picks the interpreter; otherwise python3, or python where python3 is only the Windows Store stub.
const python = process.env.PYTHON ?? (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return 'python3'; } catch { return 'python'; } })();
const parity = JSON.parse(execFileSync(python, ['-c', String.raw`
import json, sys
from dataclasses import asdict
sys.path.insert(0, sys.argv[1])
from openra_ai_companion.advisor import Advisor, is_basic_defence
from openra_ai_companion.models import GameSnapshot
from openra_ai_companion.threats import assess_threat
from openra_ai_companion.techtree import load

cases=[]
def add(label, raw, items, build_focus=False):
    snapshot=GameSnapshot.from_dict(raw)
    threat=assess_threat(snapshot)
    advisor=Advisor(snapshot, threat)
    # Pin the generated faction metadata to exercise every roster, even where
    # early shared actors cannot uniquely identify the faction yet.
    if items and snapshot.mod_id != 'ra':
        advisor.tree.items=items
    advice=advisor.next_step(build_focus=build_focus)
    cases.append(dict(label=label, raw=raw, tree=items, buildFocus=build_focus,
                      expected=asdict(advice) if advice else None, threat=asdict(threat)))

for profile, data in load()['profiles'].items():
  first_faction=next(iter(data['factions']))
  for faction, tree in data['factions'].items():
    items=tree['items']
    roles={}
    for key,item in sorted(items.items(),key=lambda p:p[1].get('order',0)):
      for token in item.get('provides',[]):
        if token in ['power','refinery','radar']: roles.setdefault(token,key)
      for token,role in [('infantry','barracks'),('vehicle','factory')]:
        if token in item.get('produces',[]): roles.setdefault(role,key)
    names={key:item['name'] for key,item in items.items()}
    def actor(kind,i=1,x=10,y=10,attack=False,idle=True,**extra):
      return dict(actor_id=i,type=kind,cell_x=x,cell_y=y,can_attack=attack,is_idle=idle,hp_percent=1,**extra)
    # A grown base: two refineries, two factories and four defences (where the faction has one), so the army cases
    # reach the army rules; the cases below take pieces away.
    defence=min((k for k,item in items.items() if is_basic_defence(item)),key=lambda k:items[k].get('cost',0),default=None)
    grown=list(roles.values())+[roles[r] for r in ['refinery','factory'] if r in roles]+([defence]*4 if defence else [])
    base=dict(tick=200,cash=10000,power_provided=1000,power_drained=0,
      harvester_count=3,map_width=96,map_height=96,explored_percent=25,
      mod_id='rtsai',actor_names=names,available_production=list(items),
      buildings=[actor(k,i,10+i%4,10+i//4) for i,k in enumerate(grown,1)],units=[])
    prefix=profile+':'+faction+':'
    for role in ['power','refinery','barracks','factory','radar']:
      if role in roles:
        raw={**base,'buildings':[a for a in base['buildings'] if a['type']!=roles[role]]}
        add(prefix+'missing-'+role,raw,items)
    def drop_one(kind, buildings):
      last=[i for i,a in enumerate(buildings) if a['type']==kind][-1]
      return [a for i,a in enumerate(buildings) if i!=last]
    if roles.get('refinery'):
      add(prefix+'second-refinery',{**base,'buildings':drop_one(roles['refinery'],base['buildings'])},items)
    if roles.get('power'):
      add(prefix+'low-power',{**base,'power_drained':1100},items)
      add(prefix+'power-margin',{**base,'power_drained':960},items)
      add(prefix+'ready',{**base,'production':[dict(queue_type='Building',item=roles['power'],progress=1,remaining_ticks=0)]},items)
    if defence:
      bare=[a for a in base['buildings'] if a['type']!=defence]
      add(prefix+'defence',{**base,'buildings':bare},items)
      # A finished defence goes toward the enemy: the remembered building, else the far side of the map.
      add(prefix+'place-defence',{**base,'buildings':bare,'production':[dict(queue_type='Support',item=defence,progress=1,remaining_ticks=0)]},items)
      add(prefix+'place-defence-known',{**base,'buildings':bare,'production':[dict(queue_type='Support',item=defence,progress=1,remaining_ticks=0)],
        'remembered_enemy_buildings':[actor(next(iter(roles.values())),900,70,20)]},items)
    if roles.get('factory'):
      # Rally points at the doors (the default) are moved toward the enemy; one already there is left alone.
      doors=[dict(a,rally_x=a['cell_x']+1,rally_y=a['cell_y']+3) if a['type'] in (roles['factory'],roles.get('barracks')) else a for a in base['buildings']]
      add(prefix+'rally',{**base,'buildings':doors},items)
    add(prefix+'economy',{**base,'harvester_count':0},items)
    add(prefix+'army',base,items)
    infantry=next((key for key,item in items.items() if item.get('queue')=='Infantry' and item.get('cost',1000)<=400),None)
    tank=next((key for key,item in sorted(items.items(),key=lambda p:p[1].get('order',0)) if item.get('queue')=='Vehicle' and 'tank' in item['name'].lower()),None)
    if infantry:
      army=[actor(infantry,i+100,20+i,20,True,i%2==0) for i in range(10)]
      enemy=actor(infantry,999,11,11,True)
      add(prefix+'defend',{**base,'units':army,'visible_enemies':[enemy]},items)
      add(prefix+'build-focus',{**base,'units':army,'visible_enemies':[enemy]},items,True)
      # Busy unit queues force the strategic scout / attack branch.
      busy=[dict(queue_type=q,item=infantry,progress=.5,remaining_ticks=10) for q in ['Vehicle','Infantry']]
      # Looking for the enemy base: one scout, the fighters together once there are 12, and nobody new while any
      # fighter is busy.
      near=[actor(infantry,i+100,12+(i%6),12+i//6,True) for i in range(12)]
      add(prefix+'scout',{**base,'units':near[:5],'production':busy},items)
      # Twelve riflemen are not an army (under 7,000 credits): still one scout. Twelve tanks advance together.
      add(prefix+'sweep-too-weak',{**base,'units':near,'production':busy},items)
      add(prefix+'scout-out',{**base,'units':near[:5]+[actor(infantry,200,80,80,True,False)],'production':busy},items)
      target=actor(next(iter(roles.values())),1000,80,80)
      wave=[actor(infantry,i+100,20+i,20,True) for i in range(10)]
      add(prefix+'visible-base',{**base,'units':wave,'production':busy,'visible_enemy_buildings':[target]},items)
      add(prefix+'base-known-army-busy',{**base,'units':army,'production':busy,'visible_enemy_buildings':[target]},items)
      # Money piling up with the queues busy: a second factory, then more defences.
      if roles.get('factory'):
        add(prefix+'spend-factory',{**base,'buildings':drop_one(roles['factory'],base['buildings']),'production':busy},items)
      if defence:
        add(prefix+'spend-defence',{**base,'buildings':drop_one(defence,drop_one(defence,base['buildings'])),'production':busy},items)
        add(prefix+'spend-defence-poor',{**base,'cash':2000,'buildings':drop_one(defence,drop_one(defence,base['buildings'])),'production':busy},items)
      if tank:
        tanks=[actor(tank,i+300,12+(i%6),12+i//6,True) for i in range(16)]
        add(prefix+'sweep',{**base,'units':tanks,'production':busy},items)
        # One unit busy somewhere does not hold back a ready army.
        add(prefix+'sweep-one-busy',{**base,'units':tanks+[actor(tank,399,80,80,True,False)],'production':busy},items)
        # An attack is a wave of ready fighters worth 7,000 credits; at most 12 orders, the strongest first.
        add(prefix+'remembered-base',{**base,'units':tanks,'production':busy,'remembered_enemy_buildings':[target]},items)
        add(prefix+'wave-of-16',{**base,'units':tanks+wave,'production':busy,'visible_enemy_buildings':[target]},items)
        add(prefix+'wave-too-small',{**base,'units':tanks[:4]+wave[:4],'production':busy,'visible_enemy_buildings':[target]},items)
        # An attack under way: the units at home join it.
        fighting=[actor(tank,i+450,66+i,66,True,False) for i in range(5)]
        add(prefix+'join',{**base,'units':fighting+tanks[:4],'production':busy,'visible_enemy_buildings':[target]},items)
        add(prefix+'join-too-few-out',{**base,'units':fighting[:3]+tanks[:4],'production':busy,'visible_enemy_buildings':[target]},items)
        # Idle in the enemy base: on to the next building; standing on the only (remembered) one: nothing to repeat.
        other=actor(next(iter(roles.values())),1001,70,86)
        inside=[actor(tank,i+400,78+i%3,78+i//3,True) for i in range(5)]
        add(prefix+'press',{**base,'units':inside,'production':busy,'remembered_enemy_buildings':[target,other]},items)
        add(prefix+'press-nothing-left',{**base,'units':inside,'production':busy,'remembered_enemy_buildings':[target]},items)
        # A building in sight next to them: a direct attack on it (an attack-move does not shoot buildings).
        add(prefix+'press-attack',{**base,'units':inside,'production':busy,'visible_enemy_buildings':[target,other]},items)
        if faction==first_faction:
          # The engine's grid (12 channels): a lake on the far side, everything explored, and what is in sight now.
          import base64, struct as st
          def grid(seen, sight=lambda x,y:False, water=lambda x,y:60<=x<=90 and 60<=y<=90):
            out=bytearray(96*96*12*4)
            for y in range(96):
              for x in range(96):
                i=((y*96+x)*12)*4
                st.pack_into('<f',out,i+12,0.0 if water(x,y) else 1.0)
                st.pack_into('<f',out,i+16,1.0 if sight(x,y) else (0.5 if seen(x,y) else 0.0))
            return base64.b64encode(bytes(out)).decode()
          spatial=lambda g:{'spatial_map':g,'spatial_channels':12}
          army_home=[actor(tank,i+500,14+i%4,14+i//4,True) for i in range(16)]
          # Never seen beyond the lake: the mirror point is water, so the first land place nobody has seen.
          add(prefix+'search-unseen',{**base,'units':army_home,'production':busy,**spatial(grid(lambda x,y:x<40 and y<40))},items)
          # All seen, the army at home and in sight there: the sweep goes on from where the army stands.
          add(prefix+'search-sweep',{**base,'units':army_home,'production':busy,**spatial(grid(lambda x,y:True, lambda x,y:x<30 and y<30))},items)
          away=[actor(tank,i+500,50+i%4,10+i//4,True) for i in range(16)]
          add(prefix+'search-sweep-away',{**base,'units':away,'production':busy,**spatial(grid(lambda x,y:True, lambda x,y:40<=x<=64 and y<24))},items)
          # An enemy in sight on land: the army goes after it; one on the lake is left alone.
          add(prefix+'hunt',{**base,'units':army_home,'production':busy,'visible_enemies':[actor(infantry,950,40,70,True)],**spatial(grid(lambda x,y:True))},items)
          add(prefix+'hunt-not-on-water',{**base,'units':army_home,'production':busy,'visible_enemies':[actor(infantry,951,75,75,True)],**spatial(grid(lambda x,y:True))},items)
    add(prefix+'done',{**base,'done':True,'result':'win'},items)

# Classic uses the native catalog with the same production metadata supplied
# by the browser. Python falls back to its existing Classic labels.
classic_items={
 'powr':dict(name='Power Plant',kind='building',queue='Building',cost=300,order=1),
 'proc':dict(name='Ore Refinery',kind='building',queue='Building',cost=1400,order=2),
 'tent':dict(name='Barracks',kind='building',queue='Building',cost=500,order=3),
 'weap':dict(name='War Factory',kind='building',queue='Building',cost=2000,order=4),
 'dome':dict(name='Radar Dome',kind='building',queue='Building',cost=1000,order=5),
 'e1':dict(name='Rifle Infantry',kind='unit',queue='Infantry',cost=100,order=6),
 '2tnk':dict(name='Medium Tank',kind='unit',queue='Vehicle',cost=800,order=7),
 'harv':dict(name='Ore Truck',kind='unit',queue='Vehicle',cost=1400,order=8),
}
classic=dict(tick=30,mod_id='ra',cash=5000,power_provided=1000,power_drained=50,
 harvester_count=3,map_width=96,map_height=96,available_production=list(classic_items),
 actor_names={k:v['name'] for k,v in classic_items.items()},units=[])
for role in ['powr','proc','tent','weap','dome']:
 add('classic:missing-'+role,{**classic,'buildings':[dict(actor_id=i,type=k,cell_x=10,cell_y=10) for i,k in enumerate(['powr','proc','tent','weap','dome'],1) if k!=role]},classic_items)
add('classic:deploy',{**classic,'buildings':[],'units':[dict(actor_id=5,type='mcv',cell_x=10,cell_y=10)]},classic_items)
print(json.dumps(cases))
`, companion], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

const actor = a => ({ actorId: a.actor_id ?? 0, kind: a.type, cellX: a.cell_x ?? 0, cellY: a.cell_y ?? 0,
  idle: a.is_idle ?? false, canAttack: a.can_attack ?? false, hpPercent: a.hp_percent ?? 1, speed: a.speed ?? 0, rallyX: a.rally_x ?? -1, rallyY: a.rally_y ?? -1,
  canDisguise: a.can_disguise, canInfiltrate: a.can_infiltrate, isDisguised: a.is_disguised, detectsDisguise: a.detects_disguise });
const observation = ({ raw: r, tree }) => ({ tick:r.tick, cash:r.cash ?? 0, powerProvided:r.power_provided ?? 0,
  powerDrained:r.power_drained ?? 0, harvesterCount:r.harvester_count ?? 0, mapWidth:r.map_width ?? 0, mapHeight:r.map_height ?? 0,
  exploredPercent:r.explored_percent ?? 0, done:r.done ?? false, result:r.result, missionMode:r.mission_mode,
  units:(r.units ?? []).map(actor), buildings:(r.buildings ?? []).map(actor), visibleEnemies:(r.visible_enemies ?? []).map(actor),
  visibleEnemyBuildings:(r.visible_enemy_buildings ?? []).map(actor), rememberedEnemyBuildings:(r.remembered_enemy_buildings ?? []).map(actor),
  production:(r.production ?? []).map(p => ({ item:p.item, queueType:p.queue_type, progress:p.progress, remainingTicks:p.remaining_ticks })),
  availableProduction:r.available_production ?? [], actorNames:r.actor_names ?? {}, techTree:tree,
  ...(r.spatial_map ? { spatial: { channels: r.spatial_channels, bytes: new Uint8Array(Buffer.from(r.spatial_map, 'base64')) } } : {}) });

const keys = new Set();
for (const test of parity) {
  const input = observation(test);
  const before = JSON.stringify(input);
  const actual = nextAdvice(input, { buildFocus:test.buildFocus });
  const expected = test.expected;
  assert.equal(actual?.key ?? null, expected?.key ?? null, `${test.label}: priority`);
  assert.deepEqual(actual?.commands ?? [], expected?.commands ?? [], `${test.label}: native commands`);
  // Classic's Python name helper intentionally uses its labels instead of
  // actor_names; browser names are native. Compare semantics, not that legacy text.
  if (!test.label.startsWith('classic:')) assert.equal(actual?.text, expected?.text, `${test.label}: explanation`);
  const threat = assessThreat(input);
  assert.equal(threat.score, test.threat.score, `${test.label}: threat score`);
  assert.equal(threat.level, test.threat.level, `${test.label}: threat level`);
  assert.equal(JSON.stringify(input), before, `${test.label}: observation must not mutate`);
  if (actual) keys.add(actual.key);
}
for (const key of ['deploy','place','defend','build:power','build:refinery','build:barracks','build:factory','build:radar','build:defence','rally','train:harvester','train:tank','scout','sweep','hunt','attack','press','join','done'])
  assert(keys.has(key), `Parity cases must cover ${key}`);
// The new rules do what they say, not only the same thing on both sides.
const expect = (suffix, check) => { const cases = parity.filter(t => t.label.endsWith(':' + suffix)); assert(cases.length, `no ${suffix} case`); for (const t of cases) check(t.expected, t.label); };
const onLand = (c) => !(c.target_x >= 60 && c.target_x <= 90 && c.target_y >= 60 && c.target_y <= 90);
expect('search-unseen', (a, l) => { assert.equal(a?.key, 'sweep', l); assert(a.commands.every(onLand), `${l}: never into the lake`); });
expect('search-sweep', (a, l) => { assert.equal(a?.key, 'sweep', l); assert(a.commands.every(c => c.target_x >= 30 || c.target_y >= 30), `${l}: somewhere not in sight`); });
expect('search-sweep-away', (a, l) => assert.equal(a?.key, 'sweep', l));
expect('sweep-one-busy', (a, l) => { if (a) assert.equal(a.key, 'sweep', l); });
expect('hunt', (a, l) => { assert.equal(a?.key, 'hunt', l); assert.equal(a.commands[0].target_x, 40, l); });
expect('hunt-not-on-water', (a, l) => assert.notEqual(a?.key, 'hunt', l));
expect('press-attack', (a, l) => { if (a?.key === 'press') assert(a.commands.every(c => c.action === 'attack' && c.target_actor_id), l); });
expect('wave-of-16', (a, l) => { if (a?.key === 'attack') assert.equal(a.commands.length, 12, l); });
expect('place-defence-known', (a, l) => { assert.equal(a?.key, 'place', l); assert(a.commands[0].target_x >= 18 && a.commands[0].target_y <= 16, `${l}: toward the enemy at 70,20 (${a.commands[0].target_x},${a.commands[0].target_y})`); });
// The enemy-base memory: a building seen stays known out of sight, and is forgotten once its cell is in sight without it.
{
  const fog = (inSightAt) => { const b = new Uint8Array(20 * 20 * 5 * 4), v = new DataView(b.buffer); for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) v.setFloat32(((y * 20 + x) * 5 + 4) * 4, inSightAt(x, y) ? 1 : 0.5, true); return { channels: 5, bytes: b }; };
  const obs = (tick, visible, sight) => ({ tick, mapWidth: 20, mapHeight: 20, visibleEnemyBuildings: visible, rememberedEnemyBuildings: [], spatial: fog(sight) });
  const yard = { actorId: 7, kind: 'nacnst', cellX: 15, cellY: 15, idle: false, canAttack: false };
  const memory = new EnemyBaseMemory();
  memory.recall(obs(100, [yard], () => true));
  assert.deepEqual(memory.recall(obs(200, [], () => false)).rememberedEnemyBuildings.map(b => b.actorId), [7], 'seen once, kept out of sight');
  assert.equal(memory.recall(obs(300, [], (x, y) => x === 15 && y === 15)).rememberedEnemyBuildings.length, 0, 'its cell in sight without it: forgotten');
  memory.recall(obs(400, [yard], () => true));
  assert.equal(memory.recall(obs(10, [], () => false)).rememberedEnemyBuildings.length, 0, 'a new match starts empty');
}
assert.deepEqual([desiredHarvesterCount(64,64),desiredHarvesterCount(96,96),desiredHarvesterCount(128,128),desiredHarvesterCount(129,128)], [2,3,4,5]);
// No queue metadata: never misidentify a low-cost structure as infantry.
const unknown = observation(parity[0]);
unknown.techTree = {};
unknown.availableProduction = ['unknown'];
unknown.actorNames.unknown = 'Uncatalogued structure';
unknown.units = []; unknown.buildings = []; unknown.production = [];
assert.equal(nextAdvice(unknown), null);
// Hormuz with fog disabled: a large, visible army on the other coast must not
// suppress construction advice. A real nearby attack still takes priority.
const coast = observation(parity[0]);
coast.buildings = [{ actorId:1, kind:'gapowr', cellX:10, cellY:10, idle:false, canAttack:false }];
coast.units = [{ actorId:2, kind:'e1', cellX:12, cellY:10, idle:true, canAttack:true }];
coast.production = [];
coast.availableProduction = ['garefn'];
coast.visibleEnemyBuildings = [];
coast.actorNames = { gapowr:'Power Plant', garefn:'Ore Refinery', e1:'G.I.' };
coast.techTree = {};
coast.threatHeated = true;
coast.visibleEnemies = Array.from({length:32}, (_,i) => ({ actorId:100+i, kind:'e1', cellX:100+i, cellY:10, idle:true, canAttack:true }));
assert.equal(nextAdvice(coast)?.key, 'build:refinery', 'distant coastal army must not prevent base construction');
coast.units[0] = { ...coast.units[0], cellX:98 };
assert.equal(nextAdvice(coast)?.key, 'build:refinery', 'a strike group at the enemy coast must not be mistaken for a base attack');
coast.units[0] = { ...coast.units[0], cellX:12 };
coast.visibleEnemies[0] = { ...coast.visibleEnemies[0], cellX:18 };
assert.equal(nextAdvice(coast)?.key, 'defend', 'nearby attacker must still trigger defense');
// The shipped fallback tree (web/src/adviser-tree.json) names what the engine has not named yet: the opening factory
// advice names a tank before any factory exists. Those names are the public game's own (RTSAI-Mod
// mods/rtsai/standalone/names.ftl, b6794bd), never the stock RA2 names.
const shippedTree = JSON.parse(fs.readFileSync(path.join(repo, 'web/src/adviser-tree.json'), 'utf8'));
const byOrder = Object.keys(shippedTree).sort((a, b) => (shippedTree[a].order ?? 0) - (shippedTree[b].order ?? 0));
const firstWith = (test) => byOrder.find(k => test(shippedTree[k]));
const [power, refinery, barracks, factory] = [firstWith(i => i.provides?.includes('power')), firstWith(i => i.provides?.includes('refinery')),
  firstWith(i => i.produces?.includes('infantry')), firstWith(i => i.produces?.includes('vehicle'))];
const opening = { ...observation(parity[0]), units: [], production: [], visibleEnemies: [], visibleEnemyBuildings: [], rememberedEnemyBuildings: [],
  buildings: [power, refinery, barracks].map((kind, i) => ({ actorId: i + 1, kind, cellX: 10, cellY: 10, idle: false, canAttack: false, hpPercent: 100 })),
  availableProduction: [factory], actorNames: Object.fromEntries([power, refinery, barracks, factory].map(k => [k, shippedTree[k].name])), techTree: shippedTree };
const factoryAdvice = nextAdvice(opening);
assert.equal(factoryAdvice?.key, 'build:factory');
assert.match(factoryAdvice.text, /it builds Battle Tanks\.$/, factoryAdvice.text);
for (const stock of ['Grizzly', 'Rhino', 'Apocalypse', 'Kirov', 'Aegis', 'Typhoon', 'Tesla', 'Prism'])
  assert(!Object.values(shippedTree).some(i => i.name.includes(stock)), `adviser-tree.json still names ${stock}`);
console.log(JSON.stringify({ passed:true, pythonParityCases:parity.length, profiles:['rtsai','standalone','Classic'], coveredKeys:[...keys].sort() }, null, 2));
