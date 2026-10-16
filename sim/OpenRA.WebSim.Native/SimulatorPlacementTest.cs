using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Real rules/actors at tick zero: a paused simulator must show completed placements.</summary>
static class SimulatorPlacementTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var scenario = new ScenarioSpec
		{
			Map = "web-arena", Bare = true,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = "saudi", Bot = "webidle" }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
		};
		SimHost.Start(scenario);
		using var catalog = JsonDocument.Parse(Ui.UnitCatalog(SimHost.World.Map.Rules));
		var checkedKinds = 0;
		foreach (var unit in catalog.RootElement.GetProperty("units").EnumerateArray())
		{
			var name = unit.GetProperty("name").GetString();
			var info = SimHost.World.Map.Rules.Actors[name];
			var kind = unit.GetProperty("kind").GetString();
			if (info.HasTraitInfo<AircraftInfo>() && kind != "aircraft") throw new Exception(name + ": flying actor outside Aircraft");
			if (!info.HasTraitInfo<AircraftInfo>() && kind == "aircraft") throw new Exception(name + ": ground actor inside Aircraft");
			checkedKinds++;
		}

		var tested = new List<string>();
		foreach (var name in new[] { "gapowr", "gacnst", "gaweap", "napowr", "naweap", "r2sapatriot" })
		{
			using var result = JsonDocument.Parse(Ui.Command($"{{\"cmd\":\"spawn\",\"type\":\"{name}\",\"player\":0,\"u\":24,\"v\":60}}"));
			if (result.RootElement.GetProperty("created").GetInt32() != 1) throw new Exception("Could not place " + name);
			var actor = SimHost.World.Actors.Last(a => a.Info.Name == name && a.Owner.Playable);
			AssertComplete(actor);
			var uv = actor.Location.ToMPos(SimHost.World.Map);
			scenario.Spawns = [new SpawnSpec { Type = name, X = uv.U, Y = uv.V, Player = 0 }];
			SimHost.Start(scenario);
			actor = SimHost.World.Actors.Single(a => a.Info.Name == name && a.Owner.Playable);
			AssertComplete(actor);
			if (actor.Location.ToMPos(SimHost.World.Map) != uv) throw new Exception(name + ": placement moved on restart");
			tested.Add(name);
		}
		Console.WriteLine(JsonSerializer.Serialize(new { passed = true, catalogKindsChecked = checkedKinds, completedBeforeTick = tested, scenarioRestartPreserves = true }));
		SimHost.EndGame();
		return 0;
	}

	static void AssertComplete(Actor actor)
	{
		var bodies = actor.TraitsImplementing<WithSpriteBody>().ToArray();
		if (bodies.Length == 0) throw new Exception(actor.Info.Name + ": no building body");
		if (bodies.Any(b => b.DefaultAnimation.CurrentSequence.Name == "make")) throw new Exception(actor.Info.Name + ": stuck on construction frame before first tick");
	}
}
