using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

static class OriginalRa2EconomyTest
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static int Run(Dictionary<string, string> opts)
    {
        SimHost.Boot(opts["root"]);
        var defaults = new OriginalRa2CashInfiltrationInfo();
        Check(defaults.Percentage == 100 && defaults.Minimum == -1, "engine infiltration defaults changed");
        if (opts.ContainsKey("classic"))
        {
            SimHost.Start(new ScenarioSpec { Map = "ca-all-connected", Bare = true,
                Players = [new PlayerSpec { Slot = "Multi0", Faction = "england" }, new PlayerSpec { Slot = "Multi1", Faction = "russia", Bot = "webidle" }],
                Options = new() { ["fog"] = "False", ["shortgame"] = "False", ["startingcash"] = "5000", ["crates"] = "False" } });
            var cw = SimHost.World; var co = cw.LocalPlayer; var ce = cw.Players.First(p => p.InternalName == "Multi1");
            Actor ClassicSpawn(string name, Player owner, int x, int y) => cw.CreateActor(true, name,
                new TypeDictionary { new OwnerInit(owner), new LocationInit(new CPos(x, y)), new SkipMakeAnimsInit() });
            ClassicSpawn("fact", co, 10, 10); ClassicSpawn("fact", ce, 35, 35);
            var refinery = ClassicSpawn("proc", ce, 20, 20); var spy = ClassicSpawn("spy", co, 17, 20); SimHost.Tick(); SimHost.Tick();
            var victim = ce.PlayerActor.Trait<PlayerResources>(); var thief = co.PlayerActor.Trait<PlayerResources>();
            victim.TakeCash(victim.Cash); victim.GiveCash(200); var before = thief.Cash;
            foreach (var t in refinery.TraitsImplementing<INotifyInfiltrated>()) t.Infiltrated(refinery, spy, BitSet<TargetableType>.FromStringsNoAlloc(["SpyInfiltrate"]));
            var gain = thief.Cash - before; var price = spy.Info.TraitInfo<ValuedInfo>().Cost;
            Check(gain == Math.Max(100, price) && victim.Cash == 100, "Classic fallback minimum changed");
            Check(co.PlayerActor.TraitsImplementing<ProductionQueue>().All(q => q is not OriginalRa2ProductionQueue), "Classic queue changed");
            Console.WriteLine("CLASSIC-CASH " + JsonSerializer.Serialize(new { gain, victimCash = victim.Cash, spyPrice = price, preserved = true }));
            SimHost.EndGame(); return 0;
        }
        string[] countries = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];
        string[] modern = ["china", "iran", "turkey", "saudi", "israel", "yemen", "hezbollah"];
        foreach (var country in opts.TryGetValue("faction", out var f) ? [f] : countries.Concat(modern))
        {
            var retail = countries.Contains(country);
            var soviet = new[] { "cuba", "libya", "iraq", "russia" }.Contains(country);
            SimHost.Start(new ScenarioSpec { Map = "twin-fords", Bare = true, Seed = 23,
                Players = [new PlayerSpec { Slot = "Multi0", Faction = country }, new PlayerSpec { Slot = "Multi1", Faction = "america", Bot = "webidle" }],
                Options = new() { ["fog"] = "False", ["explored"] = "True", ["shortgame"] = "False", ["crates"] = "False", ["startingcash"] = "50000" } });
            var w = SimHost.World; var own = w.LocalPlayer; var enemy = w.Players.First(p => p.InternalName == "Multi1");
            var origin = new MPos(15, 40).ToCPos(w.Map);
            Actor Spawn(string n, Player p, CVec offset) => w.CreateActor(true, n, new TypeDictionary {
                new OwnerInit(p), new FactionInit(p.Faction.InternalName), new LocationInit(origin + offset), new SkipMakeAnimsInit() });
            void Tick(int n) { for (var i = 0; i < n; i++) SimHost.Tick(); }
            Spawn(soviet ? "nacnst" : "gacnst", own, new CVec(-8, -5)); Spawn("nacnst", enemy, new CVec(16, -5));
            var power = Spawn("nanrct", own, new CVec(-8, 1));
            var factory = soviet ? "naweap" : "gaweap";
            Spawn(factory, own, new CVec(0, 0)); Tick(3);
            var q = own.PlayerActor.TraitsImplementing<ProductionQueue>().Single(q => q.Info.Type == "Vehicle");
            Check((q is OriginalRa2ProductionQueue) == retail, "country queue gate " + country);
            var tank = soviet ? "htnk" : "mtnk"; var ai = w.Map.Rules.Actors[tank]; var bi = ai.TraitInfo<BuildableInfo>();
            var cost = q.GetProductionCost(ai); var one = q.GetBuildTime(ai, bi);
            Check(one == cost * (retail ? 105 : 60) / 100, "single factory " + country + ": " + one);
            Spawn(factory, own, new CVec(0, 6)); Tick(3); var two = q.GetBuildTime(ai, bi);
            Check(two == one * (retail ? 80 : 86) / 100, "second factory " + two);
            Spawn(factory, own, new CVec(-5, 6)); Tick(3); var three = q.GetBuildTime(ai, bi);
            Check(three == (retail ? (int)(one * .8m * .8m) : one * 75 / 100), "third factory " + three);
            var resources = own.PlayerActor.Trait<PlayerResources>();
            // Real production orders exercise throttling and completion, not a
            // direct ProductionItem.Tick call that would bypass the queue.
            int Produce()
            {
                w.IssueOrder(new Order("StartProduction", own.PlayerActor, false) { TargetString = tank, ExtraData = 1 });
                Tick(1); var item = q.CurrentItem(); Check(item != null, "tank did not queue " + country);
                var ticks = 0; while (!item.Done && ticks < 10000) { Tick(1); ticks++; }
                Check(item.Done, "production never finished"); Tick(10); return ticks;
            }
            int? normal = null, low = null;
            var rates = new List<object>();
            if (retail)
            {
                normal = Produce(); Check(Math.Abs(normal.Value - three) <= 2, "normal production elapsed");
                power.Dispose(); Tick(3); var rq = (OriginalRa2ProductionQueue)q;
                Check(rq.ProductionRate == 500000, "severe low power must clamp to 50%");
                low = Produce(); Check(Math.Abs(low.Value - three * 2) <= 3, "critical production elapsed");
                // Exact power ratios exercise both clamps and an intermediate
                // shortage without depending on a particular country's plants.
                var pm = own.PlayerActor.Trait<PowerManager>();
                var provided = typeof(PowerManager).GetProperty(nameof(PowerManager.PowerProvided));
                var drained = typeof(PowerManager).GetProperty(nameof(PowerManager.PowerDrained));
                foreach (var amount in new[] { 0, 60, 99, 100 })
                {
                    provided.SetValue(pm, amount); drained.SetValue(pm, 100);
                    var expected = amount >= 100 ? 1000000 : Math.Clamp(amount * 10000, 500000, 800000);
                    Check(rq.ProductionRate == expected, "low-power ratio " + amount);
                    rates.Add(new { provided = amount, drain = 100, rate = rq.ProductionRate });
                }
            }
            var targetCash = enemy.PlayerActor.Trait<PlayerResources>();
            var refinery = Spawn("garefn", enemy, new CVec(9, 0)); var spy = Spawn("spy", own, new CVec(8, 0)); Tick(2);
            var types = BitSet<TargetableType>.FromStringsNoAlloc(["SpyInfiltrate"]);
            var thefts = new List<object>();
            foreach (var balance in new[] { 0, 200, 2000 })
            {
                targetCash.TakeCash(targetCash.Cash); targetCash.GiveCash(balance); var before = resources.Cash;
                foreach (var t in refinery.TraitsImplementing<INotifyInfiltrated>()) t.Infiltrated(refinery, spy, types);
                var gain = resources.Cash - before; var loss = balance - targetCash.Cash;
                Check(loss == balance / 2 && gain == (retail ? loss : Math.Max(500, loss)), "spy money " + balance);
                thefts.Add(new { balance, gain, loss });
            }
            var enemyPower = Spawn("gapowr", enemy, new CVec(9, 6)); Tick(2);
            foreach (var t in enemyPower.TraitsImplementing<INotifyInfiltrated>()) t.Infiltrated(enemyPower, spy, types);
            var blackout = enemy.PlayerActor.Trait<PowerManager>().PowerOutageRemainingTicks;
            Check(blackout == (retail ? 1667 : 500), "spy blackout " + blackout);
            var oil = Spawn("caoild", own, new CVec(-4, 11)); var payouts = new List<int>(); var cash = resources.Cash;
            for (var tick = 1; tick <= 1000; tick++) { Tick(1); if (resources.Cash != cash) { Check(resources.Cash - cash == 20, "oil amount"); payouts.Add(tick); cash = resources.Cash; } }
            Check(payouts.SequenceEqual(retail ? new[] { 167, 334, 500, 667, 834, 1000 } : new[] { 1, 102, 203, 304, 405, 506, 607, 708, 809, 910 }), "oil cadence " + string.Join(',', payouts));
            var shell = w.Map.Rules.Weapons["ea-retail-105mm"].Warheads.OfType<SpreadDamageWarhead>().Single();
            var falloff = typeof(SpreadDamageWarhead).GetMethod("GetDamageFalloff", BindingFlags.Instance | BindingFlags.NonPublic);
            var curve = new[] { 0, 153, 307, 308, 512 }.Select(d => (int)falloff.Invoke(shell, [d])).ToArray();
            Check(curve.SequenceEqual(new[] { 100, 76, 50, 0, 0 }), "AP curve " + string.Join(',', curve));
            Check(shell.DamageCalculationType == DamageCalculationType.CenterPosition, "AP geometry");
            var splashHits = new List<object>();
            foreach (var pair in new[] { (0, 65), (153, 49), (307, 32), (308, 0) })
            {
                var target = Spawn("mtnk", enemy, new CVec(5, 12)); Tick(1);
                var hp = target.Trait<Health>().HP;
                w.Map.Rules.Weapons["ea-retail-105mm"].Impact(Target.FromPos(target.CenterPosition + new WVec(pair.Item1, 0, 0)), own.PlayerActor);
                var damage = hp - target.Trait<Health>().HP;
                Check(damage == pair.Item2, "AP actual damage " + pair.Item1 + ": " + damage);
                splashHits.Add(new { distance = pair.Item1, damage }); target.Dispose(); Tick(1);
            }
            Console.WriteLine("RA2-ECONOMY " + JsonSerializer.Serialize(new { country, retail, cost, one, two, three, normal, low, rates, thefts, blackout, payouts, curve, splashHits }));
            SimHost.EndGame();
        }
        return 0;
    }
}
