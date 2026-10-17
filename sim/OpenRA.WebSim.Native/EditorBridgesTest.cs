using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Traits;
using OpenRA.GameRules;
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
		foreach (var c in map.AllCells) map.Height[c] = 0;
		var cell = new MPos((map.Bounds.Left + map.Bounds.Right)/2, (map.Bounds.Top + map.Bounds.Bottom)/2).ToCPos(map);
		int Count() => map.AllCells.SelectMany(layer.PreviewsAtCell).Distinct().Count(p => p.Type.StartsWith("lobrd"));
		string Pointer(string ev, CPos at)
		{
			var point = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(at));
			// Use the native terrain picker, as a real pointer does (projected cell centers may be occluded).
			var hit = SimHost.WorldRenderer.Viewport.ViewToWorld(SimHost.WorldRenderer.Viewport.WorldToViewPx(point));
			if (hit != at)
				point = (from y in Enumerable.Range(-30,61) from x in Enumerable.Range(-30,61)
					let candidate = point + new int2(x,y)
					where SimHost.WorldRenderer.Viewport.ViewToWorld(SimHost.WorldRenderer.Viewport.WorldToViewPx(candidate)) == at
					orderby x*x+y*y select candidate).First();

			return EditorHost.Call(JsonSerializer.Serialize(new { op = "pointer", @event = ev, x = point.X, y = point.Y, button = 1 }));
		}
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"actor\",\"type\":\"lobrdg_a\",\"owner\":\"Neutral\"}");
		foreach (var ev in new[] { "move", "down", "up" }) Pointer(ev, cell);
		Check(Count() == 0, "Raw span must not be placeable on dry grass");
		var from = cell + new CVec(0, -4); var to = cell + new CVec(0, 4);
		Check(EditorBridgeBrush.Plan(SimHost.World, from, to, "wood").Error != null, "Crossing must reject an all-land route");
		var waterTile = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates.Values.First(t => t.Size == new int2(1, 1) && t[0] != null && map.Rules.TerrainInfo.TerrainTypes[t[0].TerrainType].Type == "Water");
		var corridor = Enumerable.Range(-4, 9).SelectMany(y => Enumerable.Range(-1, 3).Select(x => cell + new CVec(x,y))).ToArray();
		foreach (var c in corridor) { map.Height[c] = 0; if (c.Y > from.Y && c.Y < to.Y) map.Tiles[c] = new TerrainTile(waterTile.Id, 0); }
		var before = corridor.Select(c => (map.Tiles[c], map.Height[c], map.Resources[c])).ToArray();
		var plan = EditorBridgeBrush.Plan(SimHost.World, from, to, "wood");
		Check(plan.Error == null && plan.Actors.Count == 9, "Complete crossing plan: " + plan.Error);
		Check(plan.Actors.First().Type == "lobrdg_r_ne" && plan.Actors.Last().Type == "lobrdg_r_sw", "Both bank ramps are required");
		map.Height[from] = 1;
		Check(EditorBridgeBrush.Plan(SimHost.World, from, to, "wood").Error != null, "Uneven bank must be rejected");
		map.Height[from] = 0;
		Check(EditorBridgeBrush.Plan(SimHost.World, from + new CVec(0,1), to, "wood").Error != null, "A ramp in water must be rejected");
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"bridge\",\"material\":\"wood\"}");
		Pointer("down", from); Pointer("move", to); var result = Pointer("up", to);
		Check(Count() == 9, "One drag must place spans and both ramps: " + result);
		Check(EditorBridgeBrush.Plan(SimHost.World, from, to, "wood").Error != null, "An overlapping crossing must be rejected");
		Check(before.SequenceEqual(corridor.Select(c => (map.Tiles[c], map.Height[c], map.Resources[c]))), "Crossing must preserve terrain, height and resources");
		EditorHost.Call("{\"op\":\"undo\"}"); Check(Count() == 0, "One undo must remove the whole crossing");
		EditorHost.Call("{\"op\":\"redo\"}"); Check(Count() == 9, "One redo must restore the whole crossing");
		using var saved = JsonDocument.Parse(EditorHost.Call("{\"op\":\"save\",\"title\":\"Bridge regression\"}"));
		var yaml = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(saved.RootElement.GetProperty("files").GetProperty("map.yaml").GetString()));
		Check(yaml.Contains("lobrdg_r_ne") && yaml.Contains("lobrdg_r_sw") && yaml.Contains("lobrdg_a"), "Export must contain the whole crossing");
		Console.WriteLine($"Editor: {bridges.Length} bridge previews; {actors.Length} actor previews; dry-ground/wet-bank/height/overlap rejection, complete crossing, atomic undo/redo, source preservation and export passed.");

		var editorCenter = cell;
		SimHost.Start(new ScenarioSpec { Map = "web-arena", Bare = true,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = "saudi", Bot = "webidle" }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" } });
		var world = SimHost.World; map = world.Map;
		cell = map.AllCells.Where(map.Contains).First(c => c.ToMPos(map).U == 24 && c.ToMPos(map).V == 60);
		from = cell + new CVec(0,-4); to = cell + new CVec(0,4);
		corridor = Enumerable.Range(-4,9).SelectMany(y => Enumerable.Range(-1,3).Select(x => cell + new CVec(x,y))).ToArray();
		var clear = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates.Values.First(t => t.Size == new int2(1,1) && t[0] != null && map.Rules.TerrainInfo.TerrainTypes[t[0].TerrainType].Type == "Clear");
		foreach (var c in corridor) { map.Height[c] = 0; map.Resources[c] = default; map.Tiles[c] = new TerrainTile(c.Y > from.Y && c.Y < to.Y ? waterTile.Id : clear.Id, 0); }
		var li = map.Rules.Actors[SystemActors.World].TraitInfos<LocomotorInfo>().First(i => i.Name == "tracked");
		var loco = new Locomotor(world.WorldActor, li); loco.WorldLoaded(world, SimHost.WorldRenderer);
		bool CrossingOpen() => Enumerable.Range(1,8).All(i => loco.MovementCostToEnterCell(null, from + new CVec(0,i-1), from + new CVec(0,i), BlockedByActor.None, null) != PathGraph.MovementCostForUnreachableCell);
		Check(!CrossingOpen(), "Water must block the entire tracked route before bridge placement");
		var owner = world.Players.First(p => p.Playable);
		var placed = plan.Actors.Select(r => world.CreateActor(r.Type, [new LocationInit(r.Get<LocationInit>().Value + (cell-editorCenter)), new OwnerInit(owner)])).ToArray();
		Check(CrossingOpen(), "Both ramps and all spans must make a bank-to-bank route passable");
		var middle = placed[4]; var missingLocation = middle.Location;
		middle.Dispose(); SimHost.Tick();
		Check(!CrossingOpen(), "A missing middle span must break the bank-to-bank route");
		var dead = world.CreateActor("lobrdg_a_d", [new LocationInit(missingLocation), new OwnerInit(owner)]);
		var segment = dead.TraitsImplementing<object>().First(t => t.GetType().Name == "BridgePlaceholder");
		var contract = segment.GetType().GetInterfaces().Single(t => t.Name == "IBridgeSegment");
		contract.GetMethod("Repair").Invoke(segment, [dead]); SimHost.Tick();
		Check(CrossingOpen(), "Repairing the middle span must restore the complete tracked route");
		Console.WriteLine("Game: full bank-to-bank tracked route blocked by water, opened by crossing, broken by missing span, restored by native repair.");

		// Exercise new artwork in a live world, including ownership, damage and native rubble spawning.
		foreach (var type in new[] { "caairp", "cahosp", "caoild", "caoutp", "cathosp" })
		{
			Check(map.Rules.Actors[type].HasTraitInfo<CapturableInfo>(), type + " lost native capture mechanics");
			var location = new MPos(12,40).ToCPos(map);
			var tech = world.CreateActor(type, [new LocationInit(location), new OwnerInit(world.Players.First(p => p.InternalName == "Neutral"))]);
			tech.ChangeOwner(owner); SimHost.Tick();
			tech.Trait<IHealth>().InflictDamage(tech, tech, new Damage(tech.Trait<IHealth>().MaxHP*3/4), true);
			Sync.RunUnsynced(world, () => world.TickRender(SimHost.WorldRenderer));
			tech.Kill(tech); SimHost.Tick();
			Sync.RunUnsynced(world, () => world.TickRender(SimHost.WorldRenderer));
			var rubbleType = type == "cathosp" ? "cahosp.rubble" : type + ".rubble";
			var rubble = world.Actors.FirstOrDefault(a => a.Info.Name == rubbleType && a.Location == location);
			Check(rubble != null, type + " failed to create native rubble");
			rubble.Dispose(); SimHost.Tick();
		}
		Check(map.Rules.Actors["caoild"].HasTraitInfo<CashTricklerInfo>(), "Oil income was lost");
		Check(map.Rules.Actors["caoutp"].HasTraitInfo<RepairsUnitsInfo>(), "Outpost repair was lost");
		Console.WriteLine("World artwork: five tech buildings retain capture; ownership, damaged rendering, death and rubble passed; oil income and outpost repair traits preserved.");

		return 0;
	}
}
