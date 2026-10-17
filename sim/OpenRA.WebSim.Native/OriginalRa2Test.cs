using System;
using System.Linq;
using System.Collections.Generic;
using OpenRA;
using OpenRA.GameRules;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;
static class OriginalRa2Test {
 public static int Run(Dictionary<string,string> options) {
  var args = options.ContainsKey("intercept") ? new[] {options["root"],options.GetValueOrDefault("missile", "v3"),"intercept"} : new[] {options["root"],options.GetValueOrDefault("missile", "v3")};
  var faction=options.GetValueOrDefault("faction", "libya");
  try {
   SimHost.Boot(args[0]);
   SimHost.Start(new ScenarioSpec {Map="twin-fords",Bare=true,Seed=23,Players=[new PlayerSpec{Slot="Multi0",Faction=faction},new PlayerSpec{Slot="Multi1",Faction="america",Bot="webidle"}],Options=new(){["fog"]="False",["explored"]="True",["startingcash"]="50000",["crates"]="False",["shortgame"]="False"}});
   var world=SimHost.World;var own=world.LocalPlayer;
   var kind=args.Length>1?args[1]:"v3"; var intercept=args.Length>2; var actor=world.CreateActor(true,kind,new TypeDictionary{new OwnerInit(own),new LocationInit(new MPos(15,40).ToCPos(world.Map)),new FactionInit(faction)});
   var enemy=world.Players.First(p=>p.InternalName=="Multi1");
   var target=world.CreateActor(true,"gatech",new TypeDictionary{new OwnerInit(enemy),new LocationInit(actor.Location+new CVec(12,0)),new FactionInit("america")});
   for(int i=0;i<90;i++)SimHost.Tick();
   if(actor.Trait<Health>().HP != (kind=="v3"?150:800))throw new Exception("Incorrect retail launcher health");
   world.IssueOrder(new Order("Attack",actor,Target.FromActor(target),false));
   var initial=target.Trait<Health>().HP;bool seen=false,empty=false,reloaded=false;int maxAltitude=0,maxCount=0;bool stopped=false;
   for(int i=0;i<1800;i++) {SimHost.Tick();if(i%5==0){Snapshot.Build();if(Snapshot.UnsupportedRenderables!=0)throw new Exception("Unsupported original model renderables");}var rockets=world.Actors.Where(a=>a.Info.Name==(kind=="v3"?"v3rocket":"dmisl")).ToArray();seen|=rockets.Length>0; maxCount=Math.Max(maxCount,rockets.Length); empty|=!actor.Trait<WithOriginalLauncherBody>().Loaded; reloaded|=empty&&actor.Trait<WithOriginalLauncherBody>().Loaded; foreach(var q in rockets) {maxAltitude=Math.Max(maxAltitude,world.Map.DistanceAboveTerrain(q.CenterPosition).Length); if(intercept && q.Trait<OriginalRa2RocketFlight>().FlightAge>=90 && q.Trait<OriginalRa2RocketFlight>().FlightAge%5==0){var aa=world.Map.Rules.Weapons["flakweapon"]; if(!aa.IsValidAgainst(q,target))throw new Exception("AA cannot target rocket"); var shot=aa.Projectile.Create(new ProjectileArgs{Weapon=aa,SourceActor=target,Source=q.CenterPosition+(target.CenterPosition-q.CenterPosition)*2048/Math.Max(1,(target.CenterPosition-q.CenterPosition).Length),PassiveTarget=q.CenterPosition,GuidedTarget=Target.FromActor(q),Facing=(q.CenterPosition-target.CenterPosition).Yaw,DamageModifiers=[],RangeModifiers=[],InaccuracyModifiers=[]});if(shot!=null)world.Add(shot);Console.WriteLine("AA FIRED");}} if(intercept && seen&&!stopped){world.IssueOrder(new Order("Stop",actor,false));stopped=true;}if(target.IsDead||target.Trait<Health>().HP<initial){if(intercept)throw new Exception("AA interception failed; missile damaged protected target"); Console.WriteLine("IMPACT tick="+i+" seen="+seen+" maxAltitude="+maxAltitude+" damage="+(initial-(target.IsDead?0:target.Trait<Health>().HP))+" maxCount="+maxCount+" empty="+empty);return 0;}}
   if(intercept&&seen&&reloaded&&target.Trait<Health>().HP==initial){Console.WriteLine("INTERCEPT PASS noDamage reloaded="+reloaded);return 0;} Console.WriteLine("tick="+world.WorldTick+" activity="+actor.CurrentActivity+" win="+own.WinState+" location="+actor.CenterPosition); throw new Exception("No damage; seen="+seen+" altitude="+maxAltitude);
  } catch(Exception e){Console.Error.WriteLine(e);return 2;}
 }
}
