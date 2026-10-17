using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

// Disposable native battle fixture. Never loads or writes owner maps, saves, or authoring data.
static class OriginalRa2Test
{
    public static int Run(Dictionary<string, string> options)
    {
        SimHost.Boot(options["root"]);
        var faction = options.GetValueOrDefault("faction", "libya");
        var type = options.GetValueOrDefault("missile", "v3");
        var intercept = options.ContainsKey("intercept");
        SimHost.Start(new ScenarioSpec
        {
            Map = "twin-fords", Bare = true, Seed = 23,
            Players = [new PlayerSpec { Slot = "Multi0", Faction = faction },
                new PlayerSpec { Slot = "Multi1", Faction = "america", Bot = "webidle" }],
            Options = new() { ["fog"] = "False", ["explored"] = "True", ["startingcash"] = "50000",
                ["crates"] = "False", ["shortgame"] = "False" }
        });
        var world = SimHost.World;
        var own = world.LocalPlayer;
        var enemy = world.Players.First(p => p.InternalName == "Multi1");
        Actor Spawn(string name, Player owner, CPos cell) => world.CreateActor(true, name, new TypeDictionary
        {
            new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName)
        });
        var origin = new MPos(15, 40).ToCPos(world.Map);
        var source = Spawn(type, own, origin);
        var suicide = type is "terror" or "dtruck";
        var target = Spawn("gatech", enemy, origin + new CVec(suicide ? 1 : 12, 0));
        if (intercept)
        {
            // A real powered enemy Flak Cannon must acquire and shoot the real missile actor.
            Spawn("nanrct", enemy, origin + new CVec(-3, -6));
            Spawn("naflak", enemy, origin + new CVec(4, 2));
        }
        for (var i = 0; i < 90; i++) SimHost.Tick();
        if (suicide) return Suicide(world, source, target, type);
        if (source.Trait<Health>().HP != (type == "v3" ? 150 : 800))
            throw new Exception("Incorrect retail launcher health");

        var before = target.Trait<Health>().HP;
        var seen = false;
        var empty = false;
        var reloaded = false;
        var stopped = false;
        var maxAltitude = 0;
        var maxCount = 0;
        var rocketType = type == "v3" ? "v3rocket" : "dmisl";
        world.IssueOrder(new Order("Attack", source, Target.FromActor(target), false));
        for (var i = 0; i < 1800; i++)
        {
            SimHost.Tick();
            if (i % 5 == 0)
            {
                Snapshot.Build();
                if (Snapshot.UnsupportedRenderables != 0)
                    throw new Exception("Unsupported original model renderables");
            }
            var rockets = world.Actors.Where(a => a.Info.Name == rocketType && !a.IsDead).ToArray();
            seen |= rockets.Length > 0;
            maxCount = Math.Max(maxCount, rockets.Length);
            empty |= !source.Trait<WithOriginalLauncherBody>().Loaded;
            reloaded |= empty && source.Trait<WithOriginalLauncherBody>().Loaded;
            foreach (var rocket in rockets)
                maxAltitude = Math.Max(maxAltitude, world.Map.DistanceAboveTerrain(rocket.CenterPosition).Length);
            if (intercept && seen && !stopped)
            {
                world.IssueOrder(new Order("Stop", source, false));
                stopped = true;
            }
            if (target.IsDead || target.Trait<Health>().HP < before)
            {
                if (intercept) throw new Exception("Enemy AA did not intercept the rocket before impact");
                if (!seen || !empty || maxAltitude < 1024 || type == "dred" && maxCount < 2)
                    throw new Exception("Missing rocket flight, empty model, or Dreadnought salvo");
                Console.WriteLine($"IMPACT PASS {type} faction={faction} tick={i} maxAltitude={maxAltitude} maxCount={maxCount} empty={empty}");
                return 0;
            }
        }
        if (intercept && seen && reloaded && !world.Actors.Any(a => a.Info.Name == rocketType && !a.IsDead))
        {
            Console.WriteLine($"INTERCEPT PASS {type} faction={faction} realEnemyFlak=true noTargetDamage=true reloaded=true");
            return 0;
        }
        throw new Exception($"No verified impact/interception: seen={seen}, altitude={maxAltitude}, reloaded={reloaded}");
    }

    static int Suicide(World world, Actor source, Actor target, string type)
    {
        var weapon = world.Map.Rules.Weapons[type == "terror" ? "ea-retail-terrorbomb" : "ea-retail-demobomb"];
        var blasts = weapon.Warheads.OfType<DamageWarhead>().ToArray();
        if (blasts.Length != 1 || blasts[0].Damage != (type == "terror" ? 225 : 300) || blasts[0].Delay != 0)
            throw new Exception("Incorrect original suicide blast profile");
        var before = target.Trait<Health>().HP;
        SimHost.Select([source.ActorID], false);
        Ui.Command("{\"cmd\":\"deploy\"}");
        for (var i = 0; i < 90; i++)
        {
            SimHost.Tick();
            if (i % 5 == 0) Snapshot.Build();
        }
        if (!source.IsDead || !target.IsDead && target.Trait<Health>().HP >= before)
            throw new Exception("Original suicide weapon did not detonate against the target");
        Console.WriteLine($"SUICIDE PASS {type} originalDamage={blasts[0].Damage} singleBlast=true");
        return 0;
    }
}
