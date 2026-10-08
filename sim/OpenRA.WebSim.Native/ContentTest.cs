using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Exercise real faction tech trees, rendering and specialty production against the bundled public game.</summary>
static class ContentTest
{
	static readonly Dictionary<string, string> Signatures = new()
	{
		["america"] = "e1", ["germany"] = "tnkd", ["england"] = "snipe", ["france"] = "gtgcan", ["korea"] = "beag",
		["cuba"] = "terror", ["libya"] = "dtruck", ["iraq"] = "deso", ["russia"] = "ttnk",
		["china"] = "r2cnnetwork", ["iran"] = "r2karrar", ["turkey"] = "r2aras", ["saudi"] = "r2m1a2s",
		["israel"] = "r2merkava", ["yemen"] = "r2ymlr", ["hezbollah"] = "r2hzrifle"
	};

	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var faction = opts.GetValueOrDefault("faction", "america");
		var scenario = new ScenarioSpec
		{
			Map = "twin-fords", Seed = 23,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = faction }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Options = new() { ["startingunits"] = "heavy", ["startingcash"] = "50000", ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
		};
		SimHost.Start(scenario);
		var world = SimHost.World; var own = world.LocalPlayer;
		var mcv = world.Actors.FirstOrDefault(a => a.Owner == own && a.Info.Name.EndsWith("mcv")) ?? throw new Exception(faction + ": no starting MCV");
		SimHost.Select([mcv.ActorID], false); Ui.Command("{\"cmd\":\"deploy\"}");
		for (var i = 0; i < 100; i++) SimHost.Tick();
		var soviet = new[] { "cuba", "libya", "iraq", "russia", "iran", "yemen", "hezbollah" }.Contains(faction);
		var yard = soviet ? "nacnst" : "gacnst";
		if (!world.Actors.Any(a => a.Owner == own && a.Info.Name == yard)) throw new Exception(faction + ": MCV did not deploy");
		var power = soviet ? "napowr" : "gapowr";
		var queue = own.PlayerActor.TraitsImplementing<ProductionQueue>().First(q => q.Info.Type == "Building");
		if (!queue.BuildableItems().Any(a => a.Name == power)) throw new Exception(faction + ": power unavailable at start");
		Ui.Command($"{{\"cmd\":\"produce\",\"queue\":\"Building\",\"item\":\"{power}\"}}");
		for (var i = 0; i < 1500 && !Ui.State().Contains("\"done\":true"); i++) SimHost.Tick();
		if (!Ui.State().Contains("\"done\":true")) throw new Exception(faction + ": power production failed");
		// Full infrastructure unlocks the real faction tree. These are test-only fixtures, never user-facing cheats.
		var buildings = soviet ? new[] { "napowr", "narefn", "nahand", "naweap", "naradr", "nadept", "natech", "nayard" }
			: new[] { "gapowr", "garefn", "gapile", "gaweap", "gaairc", "gadept", "gatech", "gayard" };
		for (var i = 0; i < buildings.Length; i++)
			Spawn(world, buildings[i], own, new MPos(10 + i % 4 * 5, 30 + i / 4 * 8).ToCPos(world.Map));
		for (var i = 0; i < 40; i++) SimHost.Tick();
		var roster = own.PlayerActor.TraitsImplementing<ProductionQueue>().SelectMany(q => q.BuildableItems()).DistinctBy(a => a.Name).ToArray();
		var signature = Signatures[faction];
		if (!roster.Any(a => a.Name == signature)) throw new Exception(faction + ": specialty unavailable: " + signature + "; roster " + string.Join(",", roster.Select(a => a.Name)));
		var units = roster.Where(a => a.HasTraitInfo<BuildableInfo>() && !a.HasTraitInfo<BuildingInfo>()).ToArray();
		for (var i = 0; i < units.Length; i++)
		{
			Spawn(world, units[i].Name, own, new MPos(18 + i % 8 * 2, 50 + i / 8 * 3).ToCPos(world.Map));
			Ui.Icon(units[i].Name);
		}
		var structures = roster.Where(a => a.HasTraitInfo<BuildingInfo>()).ToArray();
		for (var i = 0; i < structures.Length; i++)
		{
			Spawn(world, structures[i].Name, own, new MPos(8 + i % 7 * 6, 75 + i / 7 * 6).ToCPos(world.Map));
			Ui.Icon(structures[i].Name);
		}
		if (faction == "america" || faction == "iraq")
			world.CreateActor(true, signature, new TypeDictionary { new OwnerInit(own), new LocationInit(new MPos(40, 55).ToCPos(world.Map)), new FactionInit(faction), new DeployStateInit(DeployState.Deployed) });
		for (var i = 0; i < 120; i++) { SimHost.Tick(); Snapshot.Build(); }
		if (Snapshot.UnsupportedRenderables > 0) throw new Exception(faction + ": unsupported renderables");
		Console.WriteLine(JsonSerializer.Serialize(new { faction, signature, production = true, units = units.Select(a => a.Name), unsupported = Snapshot.UnsupportedRenderables, passed = true }));
		return 0;
	}

	static void Spawn(World world, string type, Player owner, CPos cell)
	{
		world.CreateActor(true, type, new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName) });
	}
}
