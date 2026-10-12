// Node 22.18+ strips the pure adviser's TypeScript types. No browser, model or server needed.
// The parity section also requires the sibling OpenRA-AI checkout (or OPENRA_AI_ROOT).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nextAdvice, assessThreat, desiredHarvesterCount } from '../web/src/adviser.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companion = path.join(process.env.OPENRA_AI_ROOT ?? path.resolve(repo, '../OpenRA-AI'), 'services/companion/src');
const parity = JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', ['-c', String.raw`
import json, sys
from dataclasses import asdict
sys.path.insert(0, sys.argv[1])
from openra_ai_companion.advisor import Advisor
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
  for faction, tree in data['factions'].items():
    items=tree['items']
    roles={}
    for key,item in sorted(items.items(),key=lambda p:p[1].get('order',0)):
      for token in item.get('provides',[]):
        if token in ['power','refinery','radar']: roles.setdefault(token,key)
      for token,role in [('infantry','barracks'),('vehicle','factory')]:
        if token in item.get('produces',[]): roles.setdefault(role,key)
    names={key:item['name'] for key,item in items.items()}
    def actor(kind,i=1,x=10,y=10,attack=False,idle=True):
      return dict(actor_id=i,type=kind,cell_x=x,cell_y=y,can_attack=attack,is_idle=idle,hp_percent=1)
    base=dict(tick=200,cash=10000,power_provided=1000,power_drained=0,
      harvester_count=3,map_width=96,map_height=96,explored_percent=25,
      mod_id='rtsai',actor_names=names,available_production=list(items),
      buildings=[actor(k,i) for i,k in enumerate(roles.values(),1)],units=[])
    prefix=profile+':'+faction+':'
    for role in ['power','refinery','barracks','factory','radar']:
      if role in roles:
        raw={**base,'buildings':[a for a in base['buildings'] if a['type']!=roles[role]]}
        add(prefix+'missing-'+role,raw,items)
    if roles.get('power'):
      add(prefix+'low-power',{**base,'power_drained':1100},items)
      add(prefix+'ready',{**base,'production':[dict(queue_type='Building',item=roles['power'],progress=1,remaining_ticks=0)]},items)
    add(prefix+'economy',{**base,'harvester_count':0},items)
    add(prefix+'army',base,items)
    infantry=next((key for key,item in items.items() if item.get('queue')=='Infantry' and item.get('cost',1000)<=400),None)
    if infantry:
      army=[actor(infantry,i+100,20+i,20,True,i%2==0) for i in range(10)]
      enemy=actor(infantry,999,11,11,True)
      add(prefix+'defend',{**base,'units':army,'visible_enemies':[enemy]},items)
      add(prefix+'build-focus',{**base,'units':army,'visible_enemies':[enemy]},items,True)
      # Busy unit queues force the strategic scout / attack branch.
      busy=[dict(queue_type=q,item=infantry,progress=.5,remaining_ticks=10) for q in ['Vehicle','Infantry']]
      add(prefix+'scout',{**base,'units':army,'production':busy},items)
      target=actor(next(iter(roles.values())),1000,80,80)
      add(prefix+'visible-base',{**base,'units':army,'production':busy,'visible_enemy_buildings':[target]},items)
      add(prefix+'remembered-base',{**base,'units':army,'production':busy,'remembered_enemy_buildings':[target]},items)
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
  idle: a.is_idle ?? false, canAttack: a.can_attack ?? false, hpPercent: a.hp_percent ?? 1,
  canDisguise: a.can_disguise, canInfiltrate: a.can_infiltrate, isDisguised: a.is_disguised, detectsDisguise: a.detects_disguise });
const observation = ({ raw: r, tree }) => ({ tick:r.tick, cash:r.cash ?? 0, powerProvided:r.power_provided ?? 0,
  powerDrained:r.power_drained ?? 0, harvesterCount:r.harvester_count ?? 0, mapWidth:r.map_width ?? 0, mapHeight:r.map_height ?? 0,
  exploredPercent:r.explored_percent ?? 0, done:r.done ?? false, result:r.result, missionMode:r.mission_mode,
  units:(r.units ?? []).map(actor), buildings:(r.buildings ?? []).map(actor), visibleEnemies:(r.visible_enemies ?? []).map(actor),
  visibleEnemyBuildings:(r.visible_enemy_buildings ?? []).map(actor), rememberedEnemyBuildings:(r.remembered_enemy_buildings ?? []).map(actor),
  production:(r.production ?? []).map(p => ({ item:p.item, queueType:p.queue_type, progress:p.progress, remainingTicks:p.remaining_ticks })),
  availableProduction:r.available_production ?? [], actorNames:r.actor_names ?? {}, techTree:tree });

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
for (const key of ['deploy','place','defend','build:power','build:refinery','build:barracks','build:factory','build:radar','train:harvester','train:tank','scout','attack','done'])
  assert(keys.has(key), `Parity cases must cover ${key}`);
assert.deepEqual([desiredHarvesterCount(64,64),desiredHarvesterCount(96,96),desiredHarvesterCount(128,128),desiredHarvesterCount(129,128)], [2,3,4,5]);
// No queue metadata: never misidentify a low-cost structure as infantry.
const unknown = observation(parity[0]);
unknown.techTree = {};
unknown.availableProduction = ['unknown'];
unknown.actorNames.unknown = 'Uncatalogued structure';
unknown.units = []; unknown.buildings = []; unknown.production = [];
assert.equal(nextAdvice(unknown), null);
console.log(JSON.stringify({ passed:true, pythonParityCases:parity.length, profiles:['rtsai','standalone','Classic'], coveredKeys:[...keys].sort() }, null, 2));
