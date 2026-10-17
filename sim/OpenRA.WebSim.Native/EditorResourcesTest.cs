using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.WebSim;
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;

static class EditorResourcesTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		EditorHost.Open("{\"new\":{\"width\":32,\"height\":32,\"title\":\"Resource regression\"}}");
		var map = SimHost.World.Map;
		var rows = map.AllCells.Where(map.Contains).GroupBy(c => c.ToMPos(map).V).OrderBy(g => g.Key).ToArray();
		var row = rows[rows.Length / 2].OrderBy(c => c.ToMPos(map).U).ToArray();
		var start = row[3]; var end = row[^4];
		// Use the native hit test, including the isometric grid's projection and viewport rounding.
		CPos Pick(CPos cell)
		{
			var wr = SimHost.WorldRenderer;
			return wr.Viewport.ViewToWorld(wr.Viewport.WorldToViewPx(wr.ScreenPxPosition(map.CenterOfCell(cell))));
		}
		var clicked = Pick(start);
		void Brush(string type) => EditorHost.Call($"{{\"op\":\"brush\",\"brush\":\"resource\",\"type\":\"{type}\"}}");
		string Pointer(string ev, CPos cell, int button = 1)
		{
			var p = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(cell));
			return EditorHost.Call($"{{\"op\":\"pointer\",\"event\":\"{ev}\",\"x\":{p.X},\"y\":{p.Y},\"button\":{button}}}");
		}
		void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
		void RenderMatchesResources()
		{
			var world = SimHost.World;
			Sync.RunUnsynced(world, () => world.TickRender(SimHost.WorldRenderer));
			var layer = world.WorldActor.Trait<IResourceLayer>();
			foreach (var renderer in world.WorldActor.TraitsImplementing<IResourceRenderer>())
				foreach (var c in map.AllCells.Where(map.Contains))
					Check(renderer.GetRenderedResourceType(c) == layer.GetResource(c).Type, "Rendered resource disagrees with layer at " + c);
		}
		Brush("Gems"); Pointer("down", start);
		using (var up = JsonDocument.Parse(Pointer("up", start)))
			Check(up.RootElement.GetProperty("placement").GetProperty("added").GetInt32() == 1, "Gem click must report a changed tile");
		Check(map.Resources[clicked].Type == 2, "Gem click must write Gems at the native hit cell");
		EditorHost.Call("{\"op\":\"undo\"}"); Check(map.Resources[clicked].Type == 0, "Undo must remove the clicked gem");
		EditorHost.Call("{\"op\":\"redo\"}"); Check(map.Resources[clicked].Type == 2, "Redo must restore the gem");
		EditorHost.Call("{\"op\":\"undo\"}");
		Pointer("down", start); Pointer("move", end);
		using (var up = JsonDocument.Parse(Pointer("up", end)))
			Check(up.RootElement.GetProperty("placement").GetProperty("added").GetInt32() >= row.Length - 6, "A coalesced fast drag must paint the whole segment");
		Check(row.Skip(3).Take(row.Length - 6).Select(Pick).All(c => map.Resources[c].Type == 2), "Gem drag must have no holes on flat ground");
		EditorHost.Call("{\"op\":\"undo\"}"); Check(map.AllCells.All(c => map.Resources[c].Type == 0), "One undo must remove the whole stroke");
		Brush("Ore"); Pointer("down", start); Pointer("up", start);
		Check(map.Resources[clicked].Type == 1, "Ore remains a separate resource");
		EditorHost.Call("{\"op\":\"undo\"}");
		var middle = row[row.Length / 2];
		var middleHit = Pick(middle);
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"resource\",\"type\":\"Gems\",\"radius\":4}");
		Pointer("down", middle); Pointer("up", middle);
		RenderMatchesResources();
		Check(EditorFieldBrush.Footprint(middleHit, 4).All(c => map.Resources[c].Type == 2), "A nine-cell brush must fill its entire round footprint");
		Check(map.AllCells.Count(c => map.Resources[c].Type == 2) == 69, "A nine-cell click must paint exactly 69 cells");
		EditorHost.Call("{\"op\":\"undo\"}");
		Check(map.AllCells.All(c => map.Resources[c].Type == 0), "One undo removes the whole wide field");
		RenderMatchesResources();
		// Real native slope tiles and elevations, rather than only a synthetic ramp flag.
		var templates = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates;
		var ramps = templates.Values.Where(t => t.Size == new int2(1, 1) && t.Categories.Contains("Ramps") && t[0] is TerrainTileInfo ti && ti.Height == 0 && ti.RampType is > 0 and <= 18)
			.GroupBy(t => t[0].RampType).ToDictionary(g => g.Key, g => g.First().Id);
		var hm = new RampTiler.HeightMap(map);
		for (var y = 0; y < hm.Target.Size.Y; y++)
			for (var x = 0; x < hm.Target.Size.X; x++)
			{
				var c = hm.XyToCPos(new int2(x, y));
				hm.Target[x, y] = (byte)Math.Clamp(4 - Math.Max(Math.Abs(c.X - middle.X), Math.Abs(c.Y - middle.Y)) / 3, 0, 4);
			}
		var tiler = new RampTiler(map, ramps.Values.Prepend((ushort)0).Distinct());
		Check(hm.Constrain(RampTiler.AdjustmentMode.Minimal), "Test hillside must fit");
		var (heights, shapes) = tiler.GenerateRampsAndHeights(hm, new OpenRA.Support.MersenneTwister(1));
		foreach (var c in map.AllCells.Where(hm.IsInternalCell))
		{
			map.Height[c] = heights[c];
			map.Tiles[c] = shapes[c] == 0 ? map.Rules.TerrainInfo.DefaultTerrainTile : new TerrainTile(ramps[shapes[c]], 0);
		}
		var flatStart = row[row.Length / 2 + 4];
		var flatHit = Pick(flatStart);
		var level = map.Height[flatHit];
		var before = map.AllCells.ToDictionary(c => c, c => (map.Tiles[c].Type, map.Tiles[c].Index, map.Height[c], map.Resources[c].Type, map.Resources[c].Index));
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"flatten\",\"radius\":4}");
		Pointer("down", flatStart);
		using (var up = JsonDocument.Parse(Pointer("up", flatStart)))
			Check(up.RootElement.GetProperty("placement").GetProperty("added").GetInt32() > 0, "Flattening a hillside must change terrain: " + up.RootElement);
		Check(EditorFieldBrush.Footprint(flatHit, 4).All(c => map.Ramp[c] == 0 && map.Height[c] == level), "The whole prepared field must have one height and no slopes");
		EditorHost.Call("{\"op\":\"undo\"}");
		Check(before.All(e => e.Value == (map.Tiles[e.Key].Type, map.Tiles[e.Key].Index, map.Height[e.Key], map.Resources[e.Key].Type, map.Resources[e.Key].Index)), "One undo must restore every terrain tile, height and resource, including joined edges");
		EditorHost.Call("{\"op\":\"redo\"}");
		var fieldCell = flatHit;
		// Find a screen point that hits the plateau after its height changed.
		var fieldPoint = map.AllCells.First(c => Pick(c) == fieldCell);
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"resource\",\"type\":\"Gems\",\"radius\":2}");
		Pointer("down", fieldPoint); Pointer("up", fieldPoint);
		RenderMatchesResources();
		Check(EditorFieldBrush.Footprint(fieldCell, 2).All(c => map.Resources[c].Type == 2), "Prepared ground must accept a dense gem field");
		EditorHost.Call("{\"op\":\"undo\"}");
		RenderMatchesResources();
		foreach (var c in map.AllCells) map.Ramp[c] = 1;
		var slope = row[10];
		Brush("Gems"); Pointer("down", slope);
		using (var up = JsonDocument.Parse(Pointer("up", slope)))
		{
			var result = up.RootElement.GetProperty("placement");
			Check(result.GetProperty("added").GetInt32() == 0 && result.GetProperty("blocked").GetString().Contains("slope"), "Blocked slopes need explicit feedback");
		}
		Check(map.AllCells.All(c => map.Resources[c].Type != 2), "Resource rules must still reject slopes");
		using (var stopped = JsonDocument.Parse(Pointer("up", end, 2)))
			Check(stopped.RootElement.GetProperty("brush").GetString() == "select", "Right-click must stop the brush in both engine and UI");
		Console.WriteLine("Editor resources passed: click, continuous drag, 69-cell gem field, whole-stroke undo/redo, hillside flattening with joined edges, exact terrain restoration, gems on prepared ground, distinct ore, slope feedback and right-click stop.");
		return 0;
	}
}
