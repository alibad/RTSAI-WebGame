// A careful scripted player, ported from mission-probe/Scripted.cs Water. Ordinary, fog-validated player orders only.
// It changes neither the campaign definition nor actors/resources. Used to distinguish objective/balance bugs from Auto strategy failures.
export class WaterPlayer {
  constructor(text) {
    this.named={};let section='',current=null,index=0;
    for(const line of text.split(/\r?\n/)) {
      if(/^\S/.test(line)){section=line.split(':')[0];continue;}
      if(section!=='Actors')continue;
      const a=line.match(/^\t([^\t:]+):\s*(\S+)/);
      if(a){current=this.named[a[1]]={name:a[1],type:a[2],index:index++};continue;}
      const p=line.match(/^\t\tLocation:\s*(-?\d+),(-?\d+)/);
      if(p&&current){const x=+p[1],y=+p[2],v=x+y;Object.assign(current,{u:(x-y-(v&1))/2,v});}
    }
    this.targets=['RoadblockWestGun','RoadblockMidGun','RoadblockEastGun','PlantPower','PlantTeslaNorth','PlantGun','PlantTeslaSouth','CoilVault'];
    this.column=new Set();this.seen=new Set();this.sent=new Map();this.phase=0;this.started=0;this.regroup=null;
    this.offset=null;this.last={produce:-1000,engineer:-1000,join:-1000,orders:-1000};this.lines=[];this.receipts=[];
  }
  point(name){return this.named[name];}
  distance(a,b){return Math.hypot((a.cellX??a.u)-(b.cellX??b.u),((a.cellY??a.v)-(b.cellY??b.v))/2)*Math.SQRT2;}
  async tick(obs,state,execute) {
    const tick=obs.tick;
    const fighters=obs.units.filter(u=>u.canAttack&&!/harv|mcv|cmin|engineer|sapc|lcrf/.test(u.kind));
    if(this.offset===null) {
      const votes=new Map();for(const u of [...obs.units,...obs.buildings])for(const n of Object.values(this.named))if(n.type===u.kind)votes.set(u.actorId-n.index,(votes.get(u.actorId-n.index)??0)+1);
      this.offset=[...votes].sort((a,b)=>b[1]-a[1])[0]?.[0];
      if(this.offset===undefined)throw Error('Cannot identify the starting map actors');
      fighters.forEach(u=>this.column.add(u.actorId));this.started=tick;
    }
    const id=name=>this.named[name].index+this.offset;
    const enemy=[...obs.visibleEnemies,...obs.visibleEnemyBuildings];enemy.forEach(u=>this.seen.add(u.actorId));
    const mine=name=>obs.buildings.some(u=>u.actorId===id(name));
    const army=()=>fighters.filter(u=>this.column.has(u.actorId));
    const goal=this.targets[this.phase], p=this.point(goal), engineer=obs.units.filter(u=>u.canCapture);
    const commands=[];
    const move=(units,to)=>commands.push(...units.map(u=>({action:'attack_move',actor_id:u.actorId,target_x:to.u,target_y:to.v})));
    const log=line=>{this.lines.push(`${(tick/1500).toFixed(2)} ${line}`);console.log('  PLAYER',line);};
    if(tick-this.last.produce>=500){commands.push({action:'train',item_type:'r2karrar'},{action:'train',item_type:'r2karrar'},{action:'train',item_type:'r2basij'},{action:'train',item_type:'r2basij'});this.last.produce=tick;}
    if(tick-this.last.engineer>=750&&engineer.length<2){commands.push({action:'train',item_type:'engineer'});this.last.engineer=tick;}
    if(tick-this.last.join>=750) {
      const home=this.point('IranConyard');const join=fighters.filter(u=>!this.column.has(u.actorId)).sort((a,b)=>this.distance(a,home)-this.distance(b,home)).slice(6);
      join.forEach(u=>this.column.add(u.actorId));move(join,this.regroup?.at??p);this.last.join=tick;
    }
    const current=enemy.find(u=>u.actorId===id(goal));
    // Locate markers deliberately remain after a target dies. Use a previously seen building's absence while the
    // column is close enough to see its site; never treat the UI marker's disappearance as a kill.
    const destroyed=this.seen.has(id(goal))&&!current&&army().some(u=>this.distance(u,p)<8);
    const done=goal==='PlantPower'?mine(goal):this.phase<7&&destroyed;
    if(this.regroup) {
      const need=[0,12,14,16,0,0,0,0][this.phase+1];
      if(army().length>=need||tick-this.regroup.tick>=2250){this.phase++;this.started=tick;this.regroup=null;move(army(),this.point(this.targets[this.phase]));log(`Regrouped; column ${army().length} to ${this.targets[this.phase]}`);}
    }else if(done||(this.phase<7&&tick-this.started>4500)) {
      if(this.phase<=2){this.regroup={at:p,tick};move(army(),p);log(`${goal} cleared; regroup`);}
      else{this.phase++;this.started=tick;move(army(),this.point(this.targets[this.phase]));log(`Column to ${this.targets[this.phase]}`);}
    }
    if(tick-this.last.orders>=250) {
      const target=this.point(this.targets[this.phase]);
      if(!this.regroup)for(const u of army()) {
        const n=enemy.find(e=>e.actorId===id(this.targets[this.phase]));
        const gun=enemy.filter(e=>e.canAttack&&this.distance(e,u)<10).sort((a,b)=>this.distance(a,u)-this.distance(b,u))[0];
        if(this.phase<7&&this.targets[this.phase]!=='PlantPower'&&n&&this.distance(u,target)<12)commands.push({action:'attack',actor_id:u.actorId,target_actor_id:n.actorId});
        else if(u.idle&&gun)commands.push({action:'attack',actor_id:u.actorId,target_actor_id:gun.actorId});
        else if(u.idle)move([u],target);
      }
      const power=this.point('PlantPower');
      const atPower=this.phase===3&&(tick-this.started>1500||enemy.filter(e=>e.canAttack&&this.distance(e,power)<8).length<=1);
      if((this.phase>3||atPower)&&!this.regroup) {
        const goals=['PlantPower',...(mine('PlantPower')?['WaterPlant']:[]),...(state.events.includes('vault-open')?['CoilVault']:[])];
        for(const name of goals.filter(n=>!mine(n))) {
          const previous=engineer.find(e=>e.actorId===this.sent.get(name));if(previous&&!previous.idle)continue;
          const used=new Set([...this.sent.values()]);
          const e=engineer.filter(e=>e.idle&&!used.has(e.actorId)&&(e.captureTargets??[]).includes(id(name))).sort((a,b)=>this.distance(a,this.point(name))-this.distance(b,this.point(name)))[0];
          if(e){this.sent.set(name,e.actorId);commands.push({action:'capture',actor_id:e.actorId,target_actor_id:id(name)});log(`Engineer to ${name}`);}
        }
      }else if(this.phase>=2)for(const e of engineer.filter(e=>e.idle))commands.push({action:'move',actor_id:e.actorId,target_x:this.point('TownGate').u,target_y:this.point('TownGate').v});
      this.last.orders=tick;
    }
    for(let i=0;i<commands.length;i+=12){const receipt=await execute(commands.slice(i,i+12));this.receipts.push({tick,commands:commands.slice(i,i+12),receipt});}
  }
}
