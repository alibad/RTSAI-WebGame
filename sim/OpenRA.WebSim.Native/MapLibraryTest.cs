using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Exercise every seat of the curated maps with native movement and AI economy.</summary>
static class MapLibraryTest
{
	static void Check(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var ticks = opts.TryGetValue("ticks", out var t) ? int.Parse(t) : 4000;
		var names = opts.TryGetValue("maps", out var namesValue) ? namesValue.Split(',') : SimHost.ModData.MapCache
			.Where(p => Path.GetFileName(p.Path).StartsWith("ra2-", StringComparison.Ordinal)).Select(p => Path.GetFileName(p.Path)).ToArray();
		Check(names.Length > 0, "No reviewed RA2 maps found");
		var reports = new List<object>();
		foreach (var id in names)
		{
			var preview = SimHost.ModData.MapCache.Single(p => Path.GetFileName(p.Path) == id);
			var seats = preview.Players.Players.Values.Where(p => p.Playable).OrderBy(p => p.Name).ToArray();
			Check(preview.SpawnPoints.Length == seats.Length, id + ": start positions differ from playable seats");
			SimHost.Start(new ScenarioSpec { Map = id, Seed = 4242,
				Players = seats.Select((p, i) => new PlayerSpec { Slot = p.Name, Faction = i % 2 == 0 ? "america" : "russia", Bot = "normal", SpawnPoint = i + 1 }).ToList(),
				Options = new() { ["startingunits"] = "medium", ["startingcash"] = "20000", ["explored"] = "True", ["fog"] = "False", ["crates"] = "False" } });
			var world = SimHost.World;
			var map = world.Map;
			var locomotor = world.WorldActor.TraitsImplementing<Locomotor>().First(l => l.Info.Name == "tracked");
			var offsets = new[] { new CVec(1,0), new CVec(-1,0), new CVec(0,1), new CVec(0,-1), new CVec(1,1), new CVec(1,-1), new CVec(-1,1), new CVec(-1,-1) };
			var reachable = new List<int>();
			foreach (var spawn in preview.SpawnPoints)
			{
				Check(map.Contains(spawn), id + ": start outside playable bounds");
				var visited = new HashSet<CPos> { spawn };
				var queue = new Queue<CPos>(); queue.Enqueue(spawn);
				var resources = 0;
				while (queue.TryDequeue(out var from))
				{
					if (map.Resources[from].Type != 0) resources++;
					foreach (var offset in offsets)
					{
						var to = from + offset;
						if (!map.Contains(to) || visited.Contains(to) || locomotor.MovementCostToEnterCell(null, from, to, BlockedByActor.None, null) == PathGraph.MovementCostForUnreachableCell) continue;
						visited.Add(to); queue.Enqueue(to);
					}
				}
				Check(resources > 0, id + ": a starting seat has no reachable ore or gems");
				reachable.Add(resources);
			}
			Snapshot.Build();
			Check(Snapshot.UnsupportedRenderables == 0, id + ": unsupported world renderables");
			if (opts.TryGetValue("out", out var output))
			{
				Directory.CreateDirectory(output);
				File.WriteAllBytes(Path.Combine(output, id + ".png"), map.SavePreview());
			}
			for (var i = 0; i < ticks; i++) SimHost.Tick();
			Snapshot.Build();
			Check(Snapshot.UnsupportedRenderables == 0, id + ": unsupported renderables after play");
			var economy = world.Players.Where(p => p.Playable).Select(p => new {
				slot = p.InternalName, earned = p.PlayerActor.Trait<PlayerResources>().Earned,
				buildings = world.Actors.Count(a => a.Owner == p && !a.IsDead && a.Info.HasTraitInfo<BuildingInfo>()) }).ToArray();
			foreach (var p in economy) Check(p.earned > 0 && p.buildings >= 4, $"{id}: {p.slot} did not establish a working economy ({p.buildings} buildings, {p.earned} earned)");
			var report = new { id, title = map.Title, players = seats.Length, ticks, reachableResourceCells = reachable, economy, unsupportedRenderables = Snapshot.UnsupportedRenderables };
			reports.Add(report);
			Console.WriteLine(JsonSerializer.Serialize(report));
			SimHost.EndGame();
		}
		if (opts.TryGetValue("out", out var dir)) File.WriteAllText(Path.Combine(dir, "verification.json"), JsonSerializer.Serialize(reports, new JsonSerializerOptions { WriteIndented = true }));
		Console.WriteLine($"PASS: {names.Length} reviewed maps; every starting seat has reachable resources and a working AI economy.");
		return 0;
	}
}
