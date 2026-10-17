using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.WebSim;

static class EditorWaterTest
{
	readonly record struct Cell(TerrainTile Tile, byte Height, ResourceTile Resource);
	static void Check(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		EditorHost.Open("{\"new\":{\"width\":96,\"height\":96,\"title\":\"Coastal water regression\"}}");
		var map = SimHost.World.Map;
		var cells = map.AllCells.Where(map.Contains).ToArray();
		Cell Capture(CPos c) => new(map.Tiles[c], map.Height[c], map.Resources[c]);
		int Distance(CPos a, CPos b) => Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
		var midX = cells.Average(c => c.X); var midY = cells.Average(c => c.Y);
		var center = cells.OrderBy(c => Math.Abs(c.X - midX) + Math.Abs(c.Y - midY)).First();
		var island = cells.First(c => Distance(c, center) > 35 && Distance(c, center) < 40
			&& Enumerable.Range(-3, 7).All(x => Enumerable.Range(-3, 7).All(y => map.Contains(c + new CVec(x, y)))));
		var water = map.Grid.Type == MapGridType.Rectangular ? (ushort)(map.Tileset == "DESERT" ? 256 : 1) : (ushort)322;
		foreach (var c in cells)
			map.Tiles[c] = new TerrainTile(Distance(c, center) <= 12 || Distance(c, island) <= 2 ? (ushort)0 : water, 0);
		var islandBefore = cells.Where(c => Distance(c, island) <= 3).ToDictionary(c => c, Capture);
		foreach (var stroke in new[] { center + new CVec(11, 0), center + new CVec(-11, 0) })
		{
			var before = cells.ToDictionary(c => c, Capture);
			var point = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(stroke));
			EditorHost.Call("{\"op\":\"brush\",\"brush\":\"water\",\"radius\":3}");
			foreach (var ev in new[] { "down", "up" })
				EditorHost.Call(JsonSerializer.Serialize(new { op = "pointer", @event = ev, x = point.X, y = point.Y, button = 1 }));
			var after = cells.ToDictionary(c => c, Capture);
			var changed = cells.Count(c => before[c] != after[c]);
			Check(changed > 0, "Coastal stroke must change terrain");
			Check(islandBefore.All(e => Capture(e.Key) == e.Value), "A coastal stroke erased a distant island");
			// The other stroke's shore pieces are allowed to be retiled when strokes join.
			Check(cells.Where(c => Distance(c, center) > 32).All(c => before[c] == after[c]), "Water brush changed distant terrain");
			EditorHost.Call("{\"op\":\"undo\"}");
			Check(cells.All(c => before[c] == Capture(c)), "Undo must restore every tile, height and resource exactly");
			EditorHost.Call("{\"op\":\"redo\"}");
			Check(cells.All(c => after[c] == Capture(c)), "Redo must restore the edited terrain exactly");
			Console.WriteLine($"Coastal stroke {stroke}: {changed} cells changed; distant island preserved; undo/redo exact.");
		}
		Console.WriteLine("Water locality regression passed on " + map.Grid.Type + ".");
		return 0;
	}
}
