using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA.WebSim;

static class AiLabTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var results = new List<object>();
		ScenarioSpec Scenario(string doctrine, bool fog, string faction, int seed) => new()
		{
			Map = "web-arena", Seed = seed, Sandbox = true, Objective = "survive", Duration = 30,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = faction, Bot = "webidle" }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle", Doctrine = doctrine }],
			Options = new() { ["explored"] = "True", ["fog"] = fog ? "True" : "False", ["shortgame"] = "False", ["crates"] = "False" },
			Spawns = Enumerable.Range(0, 8).Select(i => new SpawnSpec { Type = "r2cnrifle", Player = i < 6 ? 0 : 1, X = i < 6 ? 48 + i : 76 + i - 6, Y = 60, Order = "hold", Health = 100 }).ToList()
		};
		foreach (var faction in new[] { "saudi", "china", "iran" })
			foreach (var seed in new[] { 42, 4242 })
				foreach (var doctrine in new[] { "raider", "sentinel", "adaptive" })
				{
					SimHost.Start(Scenario(doctrine, false, faction, seed));
					for (var t = 0; t < 130; t++) SimHost.Tick();
					using var data = JsonDocument.Parse(AiLab.StateJson());
					var decisions = data.RootElement.GetProperty("doctrines")[0].GetProperty("decisions");
					if (doctrine == "sentinel" && decisions.GetArrayLength() != 0) throw new Exception("Sentinel chased distant contacts.");
					if (doctrine != "sentinel" && decisions.GetArrayLength() == 0) throw new Exception(doctrine + " did not direct idle units.");
					if (doctrine == "adaptive" && decisions[0].GetProperty("mode").GetString() != "regroup") throw new Exception("Adaptive did not respond to observed numerical disadvantage.");
					results.Add(new { faction, seed, doctrine, decisions = decisions.GetArrayLength(), passed = true });
				}
		SimHost.Start(Scenario("raider", true, "saudi", 42));
		for (var t = 0; t < 130; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson()))
			if (data.RootElement.GetProperty("doctrines")[0].GetProperty("decisions").GetArrayLength() != 0) throw new Exception("Director used unseen contacts.");
		var nearby = Scenario("sentinel", false, "saudi", 42);
		foreach (var spawn in nearby.Spawns.Where(s => s.Player == 0)) spawn.X += 16;
		SimHost.Start(nearby);
		for (var t = 0; t < 130; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson()))
			if (data.RootElement.GetProperty("doctrines")[0].GetProperty("decisions").GetArrayLength() == 0) throw new Exception("Sentinel did not defend nearby contacts.");
		foreach (var map in new[] { "twin-fords", "harbor-line" })
		{
			var skirmish = Scenario("adaptive", true, "china", 4242); skirmish.Map = map; skirmish.Objective = null; skirmish.Spawns.Clear(); skirmish.Players[0].Bot = null; skirmish.Players[1].Bot = "normal";
			SimHost.Start(skirmish);
			for (var t = 0; t < 150; t++) SimHost.Tick();
			using var data = JsonDocument.Parse(AiLab.StateJson());
			if (data.RootElement.GetProperty("doctrines")[0].GetProperty("decisions").EnumerateArray().Any(d => d.GetProperty("units").GetInt32() > 8)) throw new Exception("Director exceeded tactical bound.");
			results.Add(new { map, seed = 4242, doctrine = "adaptive", passed = true });
		}
		SimHost.Start(Scenario("standard", false, "saudi", 42));
		using (var data = JsonDocument.Parse(AiLab.Validate(SimHost.World))) if (!data.RootElement.GetProperty("valid").GetBoolean()) throw new Exception(data.RootElement.ToString());
		for (var t = 0; t < 780; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson())) if (data.RootElement.GetProperty("status").GetString() != "complete") throw new Exception("Survival objective did not complete.");
		var elimination = Scenario("standard", false, "saudi", 42); elimination.Objective = "eliminate";
		SimHost.Start(elimination);
		for (var t = 0; t < 780; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson())) if (data.RootElement.GetProperty("status").GetString() != "failed") throw new Exception("Elimination timeout did not fail objective.");
		SimHost.Start(elimination);
		foreach (var a in SimHost.World.Actors.Where(a => a.Owner.InternalName == "Multi1" && a.OccupiesSpace != null).ToArray()) a.Kill(a);
		for (var t = 0; t < 130; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson())) if (data.RootElement.GetProperty("status").GetString() != "complete") throw new Exception("Elimination objective did not complete.");
		SimHost.Start(elimination);
		foreach (var a in SimHost.World.Actors.Where(a => a.Owner.InternalName == "Multi0" && a.OccupiesSpace != null).ToArray()) a.Kill(a);
		for (var t = 0; t < 130; t++) SimHost.Tick();
		using (var data = JsonDocument.Parse(AiLab.StateJson())) if (data.RootElement.GetProperty("status").GetString() != "failed") throw new Exception("Loss of own force did not fail objective.");
		Console.WriteLine(JsonSerializer.Serialize(new { passed = true, evaluations = results, fogRespect = true, routes = true, survival = true, elimination = true, failure = true }));
		return 0;
	}
}
