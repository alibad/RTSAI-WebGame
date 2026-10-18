using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

// Real engine orders in disposable matches. Controlled XP/damage are used only to
// isolate promotion and regeneration; no owner saves/maps or authoring values are edited.
static class OriginalRa2GameplayTest
{
    static readonly string[] Countries = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    public static int Run(Dictionary<string, string> options)
    {
        SimHost.Boot(options["root"]);
        var selected = options.GetValueOrDefault("case", "ranks");
        foreach (var faction in options.TryGetValue("faction", out var f) ? new[] { f } : Countries)
        {
            SimHost.Start(new ScenarioSpec { Map = "twin-fords", Bare = true, Seed = 23,
                Players = [new PlayerSpec { Slot = "Multi0", Faction = faction }, new PlayerSpec { Slot = "Multi1", Faction = "america", Bot = "webidle" }],
                Options = new() { ["fog"] = "False", ["explored"] = "True", ["shortgame"] = "False", ["crates"] = "False", ["startingcash"] = "50000" } });
            var w = SimHost.World; var own = w.LocalPlayer; var enemy = w.Players.First(p => p.InternalName == "Multi1");
            var origin = new MPos(15, 40).ToCPos(w.Map);
            Actor Spawn(string name, Player p, CPos c) => w.CreateActor(true, name, new TypeDictionary { new OwnerInit(p), new FactionInit(p.Faction.InternalName), new LocationInit(c), new SkipMakeAnimsInit() });
            void Tick(int n) { for (var i = 0; i < n; i++) SimHost.Tick(); }
            void Attack(Actor source, Actor target) => w.IssueOrder(new Order("Attack", source, Target.FromActor(target), false));
            bool Until(Func<bool> condition, int n) { for (var i = 0; i < n; i++) { Tick(1); if (condition()) return true; } return false; }
            var result = new Dictionary<string, object> { ["faction"] = faction, ["case"] = selected };
            // A hidden parasite is not a stand-alone conquest army. Keep both players
            // alive while testing it inside an enemy-owned vehicle.
            Spawn("gacnst", own, origin + new CVec(-12, -10));
            Spawn("nacnst", enemy, origin + new CVec(15, -10));
            if (selected == "ranks")
            {
                var unit = Spawn("mtnk", own, origin); Tick(1); var cost = unit.Info.TraitInfo<ValuedInfo>().Cost;
                var xp = unit.Trait<GainsExperience>(); xp.GiveExperience(cost * 300, true);
                Check(xp.Level == (faction == "china" ? 0 : 1), "Incorrect veteran threshold");
                unit.Trait<Health>().InflictDamage(unit, enemy.PlayerActor, new Damage(50), true);
                var hp = unit.Trait<Health>().HP; Tick(250);
                Check(unit.Trait<Health>().HP == hp, "Original veteran must not gain elite self-heal");
                xp.GiveExperience(cost * 300, true); Check(xp.Level == 2, "Incorrect elite threshold");
                Tick(250); Check(unit.Trait<Health>().HP > hp, "Elite did not self-heal");
                foreach (var type in new[] { "terror", "dtruck", "ivan", "cmin", "engineer", "spy" })
                {
                    var actor = Spawn(type, own, origin + new CVec(5, 0)); Tick(1);
                    Check(actor.Trait<GainsExperience>().MaxLevel == 0, "Non-trainable actor can rank: " + type); actor.Dispose();
                }
                foreach (var type in new[] { "aegis", "beag", "cleg", "dlph", "htk", "hyd", "orca", "shad" })
                {
                    var cell = type is "aegis" or "dlph" or "hyd" ? new MPos(14, 33).ToCPos(w.Map) : origin + new CVec(5, 0);
                    var actor = Spawn(type, own, cell); Tick(1); actor.Trait<GainsExperience>().GiveLevels(2, true); Tick(1);
                    var active = actor.TraitsImplementing<Armament>().Where(a => !a.IsTraitDisabled).Select(a => a.Info.Weapon).ToArray();
                    Check(active.Any(n => n.StartsWith("ea-retail-") && n.EndsWith('e')), "Missing elite weapon: " + type + ": " + string.Join(",", active)); actor.Dispose();
                }
                result["thresholds"] = "300%,600%"; result["eliteHealing"] = true; result["eightEliteWeapons"] = true; result["nonTrainable"] = true;
            }
            else if (selected is "iron" or "chrono")
            {
                Spawn("gacnst", own, origin + new CVec(-7, 5)); Spawn("nanrct", own, origin + new CVec(-7, -5)); Spawn("gatech", own, origin + new CVec(-12, 0));
                Spawn("nacnst", enemy, origin + new CVec(12, 0)); Spawn(selected == "iron" ? "nairon" : "gacsph", own, origin); Tick(10600);
                var manager = own.PlayerActor.Trait<SupportPowerManager>();
                if (selected == "iron")
                {
                    var tank = Spawn("htnk", own, origin + new CVec(5, 0)); var infantry = Spawn("e2", enemy, tank.Location + new CVec(1, 0)); Tick(1);
                    var power = manager.Powers.Values.Single(p => p.Info is OriginalRa2IronCurtainPowerInfo);
                    Check(power.Ready, "Iron Curtain not ready");
                    w.IssueOrder(new Order(power.Key, own.PlayerActor, Target.FromCell(w, tank.Location), false)); Tick(3);
                    Check(infantry.IsDead, "Iron Curtain did not kill enemy infantry");
                    var hp = tank.Trait<Health>().HP; tank.InflictDamage(enemy.PlayerActor, new Damage(100)); Check(tank.Trait<Health>().HP == hp, "Iron Curtain did not protect vehicle");
                    Check(((GrantExternalConditionPowerInfo)power.Info).Duration == 1250, "Retail 750-frame duration was not translated to host ticks");
                    result["enemyInfantryKilled"] = true; result["vehicleProtected"] = true;
                }
                else
                {
                    var tank = Spawn("htnk", enemy, origin + new CVec(5, 0)); Tick(1);
                    var power = manager.Powers.Values.Single(p => p.Info is OriginalRa2ChronoshiftPowerInfo); Check(power.Ready, "Chronosphere not ready");
                    w.IssueOrder(new Order(power.Key, own.PlayerActor, Target.FromCell(w, new MPos(14, 33).ToCPos(w.Map)), false) { ExtraLocation = tank.Location }); Tick(10);
                    Check(tank.IsDead, "Enemy tank was not destroyed in water"); result["waterKill"] = true;
                }
            }
            else if (selected == "temporal")
            {
                var source = Spawn("cleg", own, origin); var victim = Spawn("gatech", enemy, origin + new CVec(3, 0)); Tick(1); var hp = victim.Trait<Health>().HP;
                Attack(source, victim); Check(Until(() => victim.Trait<OriginalRa2Target>().TemporalProgress > 0, 80), "Erasure did not begin: activity="+source.CurrentActivity?.GetType().Name+" sourceTarget="+source.Trait<OriginalRa2Target>().TemporalTarget?.Info.Name+" victimSource="+victim.Trait<OriginalRa2Target>().TemporalSource?.Info.Name+" arms="+string.Join(";",source.TraitsImplementing<Armament>().Select(a=>a.Info.Name+":"+a.IsTraitDisabled+":"+a.FireDelay+":"+a.Weapon.Projectile.GetType().Name)));
                Check(victim.Trait<Health>().HP == hp, "Temporal beam dealt ordinary damage");
                w.IssueOrder(new Order("Stop", source, false)); Tick(5); Check(victim.Trait<OriginalRa2Target>().TemporalProgress == 0, "Stopped erasure did not cancel");
                Attack(source, victim); Check(Until(() => victim.IsDead, 350), "Sustained erasure did not remove victim");
                var to = new MPos(11, 55).ToCPos(w.Map); w.IssueOrder(new Order("Move", source, Target.FromCell(w, to), false)); Tick(3);
                Check(source.Location == to, "Chrono Legionnaire walked instead of teleporting"); result["erasureCancelCompleteTeleport"] = true;
            }
            else if (selected == "parasites")
            {
                var drone = Spawn("dron", own, origin); var victim = Spawn("amcv", enemy, origin + new CVec(1, 0)); Tick(1); Attack(drone, victim);
                Check(Until(() => victim.Trait<OriginalRa2Target>().Parasite == drone, 200), "Drone did not infest vehicle"); Tick(110);
                Check(!drone.IsInWorld && victim.Trait<Health>().HP < 1000, "Infestation did not hide drone and damage vehicle: hp="+victim.Trait<Health>().HP+" world="+drone.IsInWorld+" dead="+drone.IsDead+" disposed="+drone.Disposed+" parasite="+victim.Trait<OriginalRa2Target>().Parasite?.Info.Name);
                var depot = Spawn("gadept", enemy, new MPos(10, 48).ToCPos(w.Map)); Tick(1);
                w.IssueOrder(new Order("Repair", victim, Target.FromActor(depot), false));
                Check(Until(() => drone.Disposed, 1800), "Real Service Depot repair order did not remove parasite");
                var squid = Spawn("sqd", own, new MPos(14, 33).ToCPos(w.Map)); var ship = Spawn("dest", enemy, new MPos(14, 34).ToCPos(w.Map)); Tick(1); Attack(squid, ship);
                Check(Until(() => ship.Trait<OriginalRa2Target>().Squid, 200), "Squid did not grab ship");
                var cell = ship.Location; w.IssueOrder(new Order("Move", ship, Target.FromCell(w, new MPos(15, 30).ToCPos(w.Map)), false)); Tick(30);
                Check(ship.Location == cell, "Grabbed ship was not immobilized");
                var dolphin = Spawn("dlph", enemy, new MPos(13, 33).ToCPos(w.Map)); ship.InflictDamage(dolphin, new Damage(1)); Tick(2);
                Check(!ship.Trait<OriginalRa2Target>().Squid && squid.IsInWorld, "Dolphin hit did not release squid"); result["infestGrabRelease"] = true;
            }
            else if (selected == "bomb")
            {
                var ivan = Spawn("ivan", own, origin); var victim = Spawn("amcv", enemy, origin + new CVec(1, 0)); Tick(1); Attack(ivan, victim);
                Check(Until(() => victim.Trait<OriginalRa2Target>().HasBomb, 100), "Bomb did not attach"); w.IssueOrder(new Order("Stop", ivan, false));
                w.IssueOrder(new Order("Move", victim, Target.FromCell(w, origin + new CVec(8, 0)), false));
                Check(Until(() => victim.Trait<Health>().HP < 1000, 850), "Attached bomb did not follow moving vehicle");
                Check(!victim.IsDead && victim.Trait<Health>().HP == 600, "Bomb damage is not 400 after armor");
                var engineer = Spawn("engineer", own, victim.Location + new CVec(1, 0)); victim.Trait<OriginalRa2Target>().AddBomb(ivan, 100, "retailivanexplosion"); Tick(1);
                w.IssueOrder(new Order("OriginalDefuse", engineer, Target.FromActor(victim), false)); Tick(30);
                Check(!victim.Trait<OriginalRa2Target>().HasBomb, "Engineer did not defuse bomb"); result["movingBomb400EngineerDefuse"] = true;
            }
            else if (selected == "prism")
            {
                Spawn("nanrct", own, origin + new CVec(-10, -5));
                var tower = Spawn("atesla", own, origin); var donor = Spawn("atesla", own, origin + new CVec(-4, 0)); var victim = Spawn("gatech", enemy, origin + new CVec(6, 0)); Tick(30); Attack(tower, victim);
                Check(Until(() => donor.Trait<OriginalRa2Target>().PrismCooldown > 0, 200), "Prism support did not activate: power="+own.PlayerActor.Trait<PowerManager>().PowerState+" hp="+victim.Trait<Health>().HP+" arms="+string.Join(";",tower.TraitsImplementing<Armament>().Select(a=>a.Info.Name+":"+a.IsTraitDisabled+":"+a.FireDelay)));
                Check(Until(() => victim.IsDead || victim.Trait<Health>().HP < 500, 30), "Supported beam did not damage target");
                Check(victim.Trait<Health>().HP == 350, "One support tower must amplify the 60-vs-wood hit to 150");
                var tank = Spawn("sref", own, origin + new CVec(0, 7)); var primary = Spawn("amcv", enemy, tank.Location + new CVec(5, 0)); var secondary = Spawn("amcv", enemy, primary.Location + new CVec(0, 2)); Tick(1); Attack(tank, primary);
                Check(Until(() => secondary.Trait<Health>().HP < 1000, 200), "Prism Tank did not branch to secondary target"); result["supportAndBranching"] = true;
            }
            else if (selected == "rules")
            {
                var building = Spawn("gacnst", own, origin); Tick(1);
                Check(building.Trait<RepairableBuilding>().Info.RepairPercent == 15 && building.Trait<RepairableBuilding>().Info.RepairStep == 8, "Repair rules differ");
                var storm = w.Map.Rules.Weapons["retaillightningstorm"].Warheads.OfType<SpreadDamageWarhead>().Single(); Check(storm.Damage == 250, "Lightning damage differs");
                var nuke = w.Map.Rules.Weapons["retailatomic"]; var blast = nuke.Warheads.OfType<SpreadDamageWarhead>().Single();
                Check(blast.Damage == 600 && blast.Falloff.SequenceEqual(new[] { 100, 2 }), "Nuclear damage is still amplified");
                Check(nuke.Warheads.Count(h => h.GetType().Name == "CreateTintedCellsWarhead") == 1, "Duplicate nuclear radiation"); result["repairStormNuclearRules"] = true;
                // Calibrate actual area impacts as well as fields: concrete receives
                // 600 * 8% = 48 at the center, without the old 1024% amplification.
                nuke.Impact(Target.FromPos(building.CenterPosition), own.PlayerActor); Tick(30);
                Check(building.Trait<Health>().HP == 952, "Nuclear central damage was not 48 versus concrete");
                var vehicle = Spawn("amcv", enemy, origin + new CVec(20, 0)); Tick(1);
                w.Map.Rules.Weapons["retaillightningstorm"].Impact(Target.FromPos(vehicle.CenterPosition), own.PlayerActor); Tick(60);
                Check(vehicle.Trait<Health>().HP == 750, "Lightning strike did not deal 250 versus heavy armor");
                result["nuclearConcreteDamage"] = 48; result["lightningHeavyDamage"] = 250;
            }
            else throw new Exception("Unknown gameplay case " + selected);
            Snapshot.Build(); Check(Snapshot.UnsupportedRenderables == 0, "Unsupported gameplay effect rendering");
            result["passed"] = true; Console.WriteLine("GAMEPLAY " + JsonSerializer.Serialize(result));
        }
        return 0;
    }
}
