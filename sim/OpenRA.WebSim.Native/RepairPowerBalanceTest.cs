using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Activities;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

static class RepairPowerBalanceTest
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }

    public static int Run(Dictionary<string, string> options)
    {
        SimHost.Boot(options["root"]);
        if (options.ContainsKey("classic"))
        {
            SimHost.Start(new ScenarioSpec { Map = "ca-all-connected", Bare = true,
                Players = [new PlayerSpec { Slot = "Multi0", Faction = "england" }],
                Options = new() { ["fog"] = "False", ["shortgame"] = "False", ["startingcash"] = "50000" } });
            var world = SimHost.World;
            Check(!OriginalRa2Rules.Country(world.LocalPlayer), "Classic got original-country balance");
            var actor = world.Map.Rules.Actors.Values.First(a => a.TraitInfoOrDefault<RepairsUnitsInfo>() != null);
            var info = actor.TraitInfo<RepairsUnitsInfo>();
            var host = world.CreateActor(true, actor.Name, new TypeDictionary { new OwnerInit(world.LocalPlayer),
                new LocationInit(new CPos(12, 12)), new SkipMakeAnimsInit() });
            var actual = host.Trait<RepairsUnits>().Info;
            Check(actual.HpPerStep == info.HpPerStep && actual.Interval == info.Interval && actual.ValuePercentage == info.ValuePercentage, "Classic repair settings changed");
            Console.WriteLine("REPAIR-CLASSIC " + JsonSerializer.Serialize(new { actor = actor.Name, actual.HpPerStep, actual.Interval, actual.ValuePercentage }));
            SimHost.EndGame(); return 0;
        }
        string[] originals = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];
        string[] modern = ["china", "iran", "turkey", "saudi", "israel", "yemen", "hezbollah"];
        foreach (var country in options.TryGetValue("faction", out var f) ? [f] : originals.Concat(modern))
        {
            var original = originals.Contains(country);
            var soviet = new[] { "cuba", "libya", "iraq", "russia" }.Contains(country);
            SimHost.Start(new ScenarioSpec { Map = "twin-fords", Bare = true, Seed = 26,
                Players = [new PlayerSpec { Slot = "Multi0", Faction = country }, new PlayerSpec { Slot = "Multi1", Faction = "america", Bot = "webidle" }],
                Options = new() { ["fog"] = "False", ["explored"] = "True", ["shortgame"] = "False", ["crates"] = "False", ["startingcash"] = "50000" } });
            var world = SimHost.World; var owner = world.LocalPlayer; var enemy = world.Players.First(p => p.InternalName == "Multi1");
            var origin = new MPos(15, 40).ToCPos(world.Map);
            Actor Spawn(string name, Player player, CVec offset) => world.CreateActor(true, name, new TypeDictionary {
                new OwnerInit(player), new FactionInit(player.Faction.InternalName), new LocationInit(origin + offset), new SkipMakeAnimsInit() });
            void Tick(int count) { for (var i = 0; i < count; i++) SimHost.Tick(); }
            Spawn("gacnst", owner, new CVec(-12, -8)); Spawn("nacnst", enemy, new CVec(18, -8));
            var plant = Spawn("nanrct", owner, new CVec(-8, 0));
            var purifier = Spawn("gaorep", owner, new CVec(0, 7));
            var refinery = Spawn("garefn", owner, new CVec(6, 7)); Tick(3);
            foreach (var harvester in world.Actors.Where(a => a.Info.Name is "cmin" or "harv").ToArray()) harvester.Dispose();
            Tick(1);
            var resources = owner.PlayerActor.Trait<PlayerResources>(); var power = owner.PlayerActor.Trait<PowerManager>();
            int Deposit()
            {
                var before = resources.Cash + resources.Resources;
                Check(refinery.Trait<IAcceptResources>().AcceptResources(refinery, "Ore", 4) == 4, "refinery rejected ore");
                return resources.Cash + resources.Resources - before;
            }
            Check(power.PowerState == PowerState.Normal, "fixture not powered"); var poweredIncome = Deposit();
            power.TriggerPowerOutage(1000); Tick(2); Check(power.PowerState != PowerState.Normal, "outage not active"); var blackoutIncome = Deposit();
            power.TriggerPowerOutage(0); Tick(2); Check(power.PowerState == PowerState.Normal, "power not restored"); var restoredIncome = Deposit();
            Check(poweredIncome == 125 && restoredIncome == 125 && blackoutIncome == (original ? 100 : 125), "purifier income " + country);
            // A normal supply shortage must disable the original bonus too, not only spy outages.
            plant.Dispose(); Tick(2); Check(power.PowerState != PowerState.Normal, "shortage not active"); var shortageIncome = Deposit();
            Check(shortageIncome == (original ? 100 : 125), "shortage bonus " + country);
            Spawn("nanrct", owner, new CVec(-8, 0)); Tick(2);
            // Capture must recompute policy and direct the bonus to the new owner's funds.
            var oldCash = resources.Cash;
            purifier.ChangeOwner(enemy); Tick(2);
            var enemyResources = enemy.PlayerActor.Trait<PlayerResources>(); var enemyPower = enemy.PlayerActor.Trait<PowerManager>();
            enemyPower.TriggerPowerOutage(1000); Tick(2);
            var capturedBlackoutCash = enemyResources.Cash;
            foreach (var callback in purifier.TraitsImplementing<INotifyResourceAccepted>()) callback.OnResourceAccepted(purifier, refinery, "Ore", 4, 100);
            Check(resources.Cash == oldCash, "captured purifier paid previous owner");
            Check(enemyResources.Cash == capturedBlackoutCash, "captured purifier ignored new owner's blackout");
            var enemyBefore = enemyResources.Cash; enemyPower.TriggerPowerOutage(0); Spawn("nanrct", enemy, new CVec(18, 0)); Tick(2);
            foreach (var callback in purifier.TraitsImplementing<INotifyResourceAccepted>()) callback.OnResourceAccepted(purifier, refinery, "Ore", 4, 100);
            Check(enemyResources.Cash - enemyBefore == 25, "captured purifier did not resume"); purifier.Dispose(); Tick(1);

            List<(int tick, int gain)> Repair(string hostName, string unitName, CVec offset, int duration)
            {
                var host = Spawn(hostName, owner, offset); var unit = Spawn(unitName, owner, offset + new CVec(4, 0)); Tick(2);
                unit.InflictDamage(enemy.PlayerActor, new Damage(unit.Trait<Health>().MaxHP - 1));
                unit.QueueActivity(false, new Resupply(unit, host, new WDist(-1), true));
                var hp = unit.Trait<Health>().HP; var pulses = new List<(int tick, int gain)>();
                for (var t = 1; t <= duration; t++) { Tick(1); var now = unit.Trait<Health>().HP; if (hp != now) { pulses.Add((t, now - hp)); hp = now; } }
                unit.Dispose(); host.Dispose(); Tick(1); return pulses;
            }
            var depot = Repair(soviet ? "nadept" : "gadept", soviet ? "htnk" : "mtnk", new CVec(0, -7), 170);
            var hospital = Repair("cahosp", "engineer", new CVec(0, 13), 35);
            var expectedDepotStep = original ? 20 : soviet ? 20 : 10;
            var expectedDepotCadence = original ? 25 : soviet ? 149 : 51;
            Check(depot.Count >= 2 && depot[0].gain == expectedDepotStep && depot[1].tick - depot[0].tick == expectedDepotCadence, "depot cadence " + country);
            Check(hospital.Count >= 2 && hospital[0].gain == (original ? 20 : 10) && hospital[1].tick - hospital[0].tick == (original ? 5 : 25), "hospital cadence " + country);

            // Preserve the owner's deliberate deviations from retail.
            var vat = Spawn("naclon", owner, new CVec(0, 0)); var engineer = Spawn("engineer", owner, new CVec(3, 0)); Tick(2);
            var beforeRecycle = resources.Cash; world.IssueOrder(new Order("DeliverCash", engineer, Target.FromActor(vat), false));
            for (var t = 0; t < 250 && engineer.IsInWorld; t++) Tick(1);
            Check(!engineer.IsInWorld && resources.Cash - beforeRecycle == 250, "Engineer recycling changed " + country);
            var aircraft = Spawn(country == "korea" ? "beag" : "orca", owner, new CVec(7, -7)); Tick(2);
            var ammo = aircraft.Trait<AmmoPool>(); ammo.TakeAmmo(aircraft, 1); var rearmTicks = 0;
            while (!ammo.HasFullAmmo && rearmTicks < 600) { aircraft.Trait<Rearmable>().RearmTick(aircraft); rearmTicks++; }
            Check(rearmTicks == 50, "fast rearm changed " + country);
            Console.WriteLine("REPAIR-POWER " + JsonSerializer.Serialize(new { country, original, poweredIncome, blackoutIncome, restoredIncome, shortageIncome,
                depotStep = depot[0].gain, depotCadence = depot[1].tick - depot[0].tick, hospitalStep = hospital[0].gain,
                hospitalCadence = hospital[1].tick - hospital[0].tick, engineerRecycling = 250, rearmTicks }));
            SimHost.EndGame();
        }
        return 0;
    }
}
