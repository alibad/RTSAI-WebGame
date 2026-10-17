using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Traits;
using OpenRA.WebSim;

static class EditorBridgesTest
{
	static void Check(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		EditorHost.Open("{\"new\":{\"width\":32,\"height\":32,\"title\":\"Bridge regression\"}}");
		using var catalog = JsonDocument.Parse(EditorHost.Call("{\"op\":\"catalog\"}"));
		var actors = catalog.RootElement.GetProperty("actors").EnumerateArray().ToArray();
		var bridges = actors.Where(a => a.GetProperty("categories").EnumerateArray().Any(c => c.GetString() == "Bridge")).Select(a => a.GetProperty("name").GetString()).ToArray();
		Check(bridges.Length == 21, "Expected all 21 native bridge pieces");
		using var previews = JsonDocument.Parse(EditorHost.Call(JsonSerializer.Serialize(new { op = "actor-previews", names = bridges, owner = "Neutral" })));
		foreach (var name in bridges)
		{
			var parts = previews.RootElement.GetProperty(name);
			Check(parts.GetArrayLength() > 0, name + " has no native sprite preview");
			Check(parts[0].GetProperty("w").GetInt32() == 192, name + " still uses placeholder art");
		}
		// Every category uses its own native preview safely; voxel actors can keep their cameo fallback.
		foreach (var batch in actors.Select(a => a.GetProperty("name").GetString()).Chunk(60))
			using (JsonDocument.Parse(EditorHost.Call(JsonSerializer.Serialize(new { op = "actor-previews", names = batch, owner = "Neutral" })))) { }
		var map = SimHost.World.Map;
		var layer = SimHost.World.WorldActor.Trait<EditorActorLayer>();
		var cell = map.AllCells.Where(map.Contains).ElementAt(map.AllCells.Count(map.Contains) / 2);
		var point = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(cell));
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"actor\",\"type\":\"lobrdg_a\",\"owner\":\"Neutral\"}");
		foreach (var ev in new[] { "move", "down", "up" })
			EditorHost.Call(JsonSerializer.Serialize(new { op = "pointer", @event = ev, x = point.X, y = point.Y, button = 1 }));
		Check(map.AllCells.SelectMany(layer.PreviewsAtCell).Distinct().Count(p => p.Type == "lobrdg_a") == 1, "Bridge click did not place native actor");
		EditorHost.Call("{\"op\":\"pointer\",\"event\":\"move\",\"x\":-100000,\"y\":-100000,\"button\":0}");
		Sync.RunUnsynced(SimHost.World, () => SimHost.World.TickRender(SimHost.WorldRenderer));
		Check(map.AllCells.SelectMany(layer.PreviewsAtCell).Distinct().Count(p => p.Type == "lobrdg_a") == 1, "Leaving the canvas must only hide the cursor preview");
		EditorHost.Call("{\"op\":\"undo\"}");
		Check(!map.AllCells.SelectMany(layer.PreviewsAtCell).Any(p => p.Type == "lobrdg_a"), "Undo did not remove bridge");
		EditorHost.Call("{\"op\":\"redo\"}");
		using var saved = JsonDocument.Parse(EditorHost.Call("{\"op\":\"save\",\"title\":\"Bridge regression\"}"));
		Check(saved.RootElement.GetProperty("files").GetProperty("map.yaml").GetString().Length > 0, "Bridge map failed to export");
		Console.WriteLine($"Editor: {bridges.Length} bridge previews use original art; {actors.Length} actor previews; placement, undo, redo and export passed.");

		SimHost.Start(new ScenarioSpec { Map = "web-arena", Bare = true,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = "saudi", Bot = "webidle" }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" } });
		var world = SimHost.World; map = world.Map;
		cell = map.AllCells.Where(map.Contains).First(c => c.ToMPos(map).U == 24 && c.ToMPos(map).V == 60);
		var info = map.Rules.Actors["lobrdg_a"].TraitInfo<BuildingInfo>();
		var footprint = info.PathableTiles(cell).ToArray();
		var water = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates.Values.First(t => t.Size == new int2(1, 1) && t[0] != null && map.Rules.TerrainInfo.TerrainTypes[t[0].TerrainType].Type == "Water");
		foreach (var c in footprint) { map.Height[c] = 0; map.Tiles[c] = new TerrainTile(water.Id, 0); }
		var li = map.Rules.Actors[SystemActors.World].TraitInfos<LocomotorInfo>().First(i => i.Name == "tracked");
		var loco = new Locomotor(world.WorldActor, li); loco.WorldLoaded(world, SimHost.WorldRenderer);
		bool Passable(CPos c) => loco.MovementCostToEnterCell(null, c, c, BlockedByActor.None, null) != PathGraph.MovementCostForUnreachableCell;
		Check(footprint.All(c => !Passable(c)), "Water should block tracked units");
		var owner = world.Players.First(p => p.Playable);
		var bridge = world.CreateActor("lobrdg_a", [new LocationInit(cell), new OwnerInit(owner)]);
		Check(footprint.All(Passable), "Native bridge must open the crossing over water");
		bridge.Dispose();
		SimHost.Tick(); // Dispose removes actors and their custom terrain at frame end.
		Check(footprint.All(c => !Passable(c)), "Removed bridge must close the crossing");
		var dead = world.CreateActor("lobrdg_a_d", [new LocationInit(cell), new OwnerInit(owner)]);
		var segment = dead.TraitsImplementing<object>().First(t => t.GetType().Name == "BridgePlaceholder");
		var contract = segment.GetType().GetInterfaces().Single(t => t.Name == "IBridgeSegment");
		contract.GetMethod("Repair").Invoke(segment, [dead]);
		SimHost.Tick();
		Check(world.Actors.Any(a => a.Info.Name == "lobrdg_a" && a.Location == cell), "Repair must recreate native span");
		Check(footprint.All(Passable), "Repaired crossing must be passable again");
		Console.WriteLine("Game: tracked vehicles blocked by water, cross intact bridge, blocked after removal, and cross repaired span.");
		return 0;
	}
}
