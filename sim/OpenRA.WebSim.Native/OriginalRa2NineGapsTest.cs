using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Mods.RA2.Traits.SupportPowers;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

static class OriginalRa2NineGapsTest
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static int Run(Dictionary<string,string> options)
    {
        SimHost.Boot(options["root"]);
        var test = options.GetValueOrDefault("case","ifv");
        foreach (var country in options.TryGetValue("faction",out var f) ? new[]{f} : new[]{"america","germany","england","france","korea","cuba","libya","iraq","russia"})
        {
            var scenario=new ScenarioSpec { Map="twin-fords", Bare=true, Seed=23,
                Players=[new PlayerSpec { Slot="Multi0",Faction=country },new PlayerSpec { Slot="Multi1",Faction="america",Bot="webidle" }],
                Options=new() { ["fog"]="False",["explored"]="True",["shortgame"]="False",["crates"]="False",["startingcash"]="50000" } };
            SimHost.Start(scenario);
            var w=SimHost.World;var own=w.LocalPlayer;var enemy=w.Players.First(p=>p.InternalName=="Multi1");
            var origin=new MPos(15,40).ToCPos(w.Map);
            Actor Spawn(string name,Player p,CPos cell)=>w.CreateActor(true,name,new TypeDictionary {new OwnerInit(p),new FactionInit(p.Faction.InternalName),new LocationInit(cell),new SkipMakeAnimsInit()});
            void Tick(int n){for(var i=0;i<n;i++)SimHost.Tick();}
            bool Until(Func<bool> condition,int n){for(var i=0;i<n;i++){Tick(1);if(condition())return true;}return false;}
            void Attack(Actor a,Actor b)=>w.IssueOrder(new Order("Attack",a,Target.FromActor(b),false));
            Spawn("gacnst",own,origin+new CVec(-12,-10));Spawn("nacnst",enemy,origin+new CVec(15,-10));
            var evidence=new Dictionary<string,object>{["country"]=country,["case"]=test};
            if(test=="ranks")
            {
                var results=new List<object>();
                for(var level=0;level<=2;level++)
                {
                    var unit=Spawn("mtnk",own,origin);Tick(1);if(level>0)unit.Trait<GainsExperience>().GiveLevels(level,true);Tick(1);
                    var hp=unit.Trait<Health>().HP;unit.InflictDamage(enemy.PlayerActor,new Damage(100));var damage=hp-unit.Trait<Health>().HP;
                    var fire=unit.TraitsImplementing<IFirepowerModifier>().Select(t=>t.GetFirepowerModifier()).Where(v=>v!=100).ToArray();
                    var speed=unit.TraitsImplementing<ISpeedModifier>().Select(t=>t.GetSpeedModifier()).Where(v=>v!=100).ToArray();
                    var reload=unit.TraitsImplementing<IReloadModifier>().Select(t=>t.GetReloadModifier()).Where(v=>v!=100).ToArray();
                    Check(damage==(level==0?100:67),"rank damage "+damage);Check(fire.SequenceEqual(level==0?Array.Empty<int>():new[]{110}),"rank firepower");
                    Check(speed.SequenceEqual(level==0?Array.Empty<int>():new[]{120}),"rank speed");Check(reload.SequenceEqual(level==2?new[]{60}:Array.Empty<int>()),"rank reload");
                    results.Add(new{level,damage,fire,speed,reload});unit.Dispose();Tick(1);
                }
                evidence["ranks"]=results;
            }
            else if(test=="ifv")
            {
                var forms=new Dictionary<string,string>();
                foreach(var pair in new[]{("e1","crm60"),("engineer","repairbullet"),("snipe","awpe"),("tany","crmp5"),("shk","crelectricbolt"),("deso","crradbeamweapon"),("flakt","crflakguygun"),("cleg","crneutronrifle"),("yuri","crmindcontrol"),("ivan","crnuke"),("terror","crterrorbomb")})
                {
                    Console.WriteLine("IFV passenger "+pair.Item1);
                    // Each form gets a fresh world: the Ivan IFV leaves real radiation.
                    if(pair.Item1 is "ivan" or "terror")
                    {
                        SimHost.Start(scenario);w=SimHost.World;own=w.LocalPlayer;enemy=w.Players.First(p=>p.InternalName=="Multi1");
                        Spawn("gacnst",own,origin+new CVec(-12,-10));Spawn("nacnst",enemy,origin+new CVec(15,-10));
                    }
                    var position=origin;
                    var unit=Spawn("fv",own,position);var passenger=Spawn(pair.Item1,own,position+new CVec(0,1));Tick(1);
                    w.IssueOrder(new Order("EnterTransport",passenger,Target.FromActor(unit),false));
                    Check(Until(()=>unit.Disposed || unit.IsDead || unit.Trait<Cargo>().PassengerCount==1,120) && !unit.Disposed && !unit.IsDead,"passenger entry "+pair.Item1+" unitDead="+unit.IsDead+" passengerDead="+passenger.IsDead+" passengerInWorld="+passenger.IsInWorld+" activity="+passenger.CurrentActivity?.GetType().Name);
                    var active=unit.TraitsImplementing<Armament>().Where(a=>!a.IsTraitDisabled).ToArray();
                    Check(active.Length==1 && active[0].Info.Weapon=="ea-retail-"+pair.Item2,"IFV "+pair.Item1+": "+string.Join(",",active.Select(a=>a.Info.Weapon)));
                    forms[pair.Item1]=active[0].Info.Weapon;
                    if(pair.Item1=="cleg")
                    {
                        var target=Spawn("amcv",enemy,origin+new CVec(3,0));Tick(1);Attack(unit,target);
                        Check(Until(()=>target.Trait<OriginalRa2Target>().TemporalProgress>0,60),"chrono IFV never erased");
                        Check(target.Trait<Health>().HP==target.Trait<Health>().MaxHP,"chrono IFV ordinary damage");
                        Check(Until(()=>target.IsDead,220),"chrono IFV did not finish erasure");target.Dispose();
                    }
                    if(pair.Item1 is "ivan" or "terror")
                    {
                        var target=Spawn("gatech",enemy,position+new CVec(2,0));Tick(1);var hp=target.Trait<Health>().HP;Attack(unit,target);
                        Check(Until(()=>unit.IsDead,160),"suicide IFV did not detonate: "+pair.Item1);
                        Check(target.Trait<Health>().HP<hp,"suicide IFV did not damage target");target.Dispose();
                    }
                    unit.Dispose();passenger.Dispose();Tick(2);
                }
                evidence["passengerOrders"]=forms;
            }
            else if(test=="approach")
            {
                var legion=Spawn("cleg",own,origin);var target=Spawn("gatech",enemy,origin+new CVec(11,0));Tick(1);var start=legion.CenterPosition;Attack(legion,target);Tick(20);
                var distance=(legion.CenterPosition-start).HorizontalLength;Check(distance>3000,"legionnaire walked: "+distance);
                Check(legion.Trait<Mobile>().IsTraitDisabled,"teleport phase not vulnerable");
                Check(Until(()=>target.Trait<OriginalRa2Target>().TemporalProgress>0,160),"legionnaire did not resume attack");
                evidence["teleportedDistance"]=distance;evidence["attackResumed"]=true;
            }
            else if(test=="garrison")
            {
                var neutral=w.Players.First(p=>p.InternalName=="Neutral");var house=Spawn("cahse01",neutral,origin);var gi=Spawn("e1",own,origin+new CVec(-2,0));Tick(1);
                w.IssueOrder(new Order("OriginalGarrison",gi,Target.FromActor(house),false));
                Check(Until(()=>house.Trait<Cargo>().PassengerCount==1,160),"neutral house entry failed");Check(house.Owner==own,"garrison owner not transferred");
                Snapshot.Build();Check(Snapshot.UnsupportedRenderables==0,"occupied house did not render");
                var victim=Spawn("e2",enemy,origin+new CVec(5,0));Tick(1);var hp=victim.Trait<Health>().HP;Attack(house,victim);
                Check(Until(()=>victim.IsDead || victim.Trait<Health>().HP<hp,160),"occupied house did not fire");
                house.InflictDamage(enemy.PlayerActor,new Damage(350));Tick(3);
                Check(house.Trait<Cargo>().IsEmpty() && gi.IsInWorld && house.Owner==neutral,"damaged garrison did not evacuate");
                Check(w.Map.Rules.Actors.Values.Count(a=>a.HasTraitInfo<OriginalRa2GarrisonInfo>())==120,"not all 120 original occupiable buildings restored");
                evidence["neutralEntryOwnershipFireEvacuation"]=true;
            }
            else if(test=="sensor")
            {
                Spawn("nanrct",own,origin+new CVec(-8,0));var sensor=Spawn("napsis",own,origin);var spy=Spawn("spy",enemy,origin+new CVec(10,0));var disguise=Spawn("e1",own,origin+new CVec(12,0));Tick(1);
                foreach(var resolver in spy.TraitsImplementing<IResolveOrder>())resolver.ResolveOrder(spy,new Order("Disguise",spy,Target.FromActor(disguise),false));
                Check(spy.EffectiveOwner.Disguised,"spy fixture failed");Tick(2);Check(!spy.EffectiveOwner.Disguised,"sensor did not detect disguise");
                var attacker=Spawn("mtnk",enemy,origin+new CVec(18,0));Attack(attacker,sensor);Tick(3);
                var lines=sensor.Trait<OriginalRa2PsychicSensor>().RenderAnnotations(sensor,SimHost.WorldRenderer).Count();
                Check(lines>0,"sensor did not expose incoming attack intent");
                Check(sensor.TraitsImplementing<DetectCloaked>().Max(d=>d.Range.Length)==15*1024,"sensor cloak range");
                evidence["detectedDisguise"]=true;evidence["incomingIntentLines"]=lines;
            }
            else if(test=="bomb")
            {
                var source=Spawn("ivan",own,origin);var victim=Spawn("amcv",enemy,origin+new CVec(2,0));Tick(1);Attack(source,victim);
                Check(Until(()=>victim.Trait<OriginalRa2Target>().HasBomb,100),"Ivan did not attach bomb");Tick(2);
                bool Visible()=>victim.TraitsImplementing<WithIdleOverlay>().Any(o=>o.Info.Sequence.StartsWith("stage-",StringComparison.Ordinal) && !o.IsTraitDisabled);
                Check(Visible(),"attached fuse invisible");Snapshot.Build();Check(Snapshot.UnsupportedRenderables==0,"bomb cursor failed render");
                victim.Trait<Mobile>().SetPosition(victim,origin+new CVec(4,0));Tick(125);Check(Visible(),"moving victim lost fuse");
                victim.Trait<OriginalRa2Target>().Defuse();Tick(2);Check(!Visible(),"defused fuse stayed visible");evidence["attachMoveRenderDefuse"]=true;
            }
            else if(test=="timing")
            {
                var tank=Spawn("mtnk",own,origin);var target=Spawn("gatech",enemy,origin+new CVec(3,0));Tick(1);Attack(tank,target);var shots=new List<int>();var hp=target.Trait<Health>().HP;
                for(var i=0;i<350;i++){Tick(1);var now=target.Trait<Health>().HP;if(now<hp)shots.Add(i);hp=now;}
                Check(shots.Count>=3,"ROF fixture never fired");Check(shots.Zip(shots.Skip(1),(a,b)=>b-a).All(t=>t==100),"60 retail-frame ROF did not fire every 100 host ticks: "+string.Join(",",shots));
                var station=Spawn("gaweat",own,origin+new CVec(-8,0));Spawn("nanrct",own,origin+new CVec(-8,-8));Tick(2);
                var storm=station.Trait<OriginalRa2WeatherPower>();
                storm.Activate(station,new Order("OriginalWeather",own.PlayerActor,Target.FromCell(w,origin+new CVec(12,12)),false),own.PlayerActor.Trait<SupportPowerManager>());
                Tick(416);Check(!storm.StormActive && storm.DirectHits==0,"storm deferment ran fast");Tick(1);Check(storm.StormActive,"storm did not start after retail 250 frames");
                var hitTicks=new List<int>();var previous=0;
                for(var i=1;i<=300;i++){Tick(1);if(storm.DirectHits>previous)hitTicks.Add(i);previous=storm.DirectHits;}
                Check(!storm.StormActive && storm.DirectHits==18 && storm.ScatterHits==36,"storm accumulated cadence drift");
                Check(hitTicks[0]==17 && hitTicks[^1]==300,"storm hit clock wrong: "+string.Join(",",hitTicks));
                evidence["shotTicks"]=shots;evidence["stormActiveTicks"]=300;evidence["stormDefermentTicks"]=417;evidence["stormHitTicks"]=hitTicks;evidence["stormScatterCount"]=storm.ScatterHits;
            }
            else if(test=="naval")
            {
                var squid=Spawn("sqd",own,new MPos(14,33).ToCPos(w.Map));var dolphin=Spawn("dlph",enemy,new MPos(14,34).ToCPos(w.Map));Tick(1);squid.Trait<GainsExperience>().GiveLevels(2,true);Tick(1);Attack(squid,dolphin);Tick(100);
                Check(dolphin.IsDead || dolphin.Trait<Health>().HP<200,"elite squid could not punch dolphin");evidence["elitePunch"]=true;
            }
            else if(test=="nuke")
            {
                var nuke=w.Map.Rules.Actors["namisl"].TraitInfos<NukePowerInfo>().Single(p=>p.RequiresCondition?.ToString()=="ea-art");
                Check(nuke.MissileImage=="ea-atomic" && nuke.TrailImage=="ea-nukesmoke","active nuke still draws replacement art");
                evidence["missile"]=nuke.MissileImage;evidence["trail"]=nuke.TrailImage;
            }
            else throw new ArgumentException("Unknown nine-gap case "+test);
            Console.WriteLine("NINE-GAPS "+JsonSerializer.Serialize(evidence));
        }
        return 0;
    }
}
