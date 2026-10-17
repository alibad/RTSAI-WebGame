using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
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
		if (opts.TryGetValue("map-file", out var file)) return RealMap(opts["root"], file);
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

	static int RealMap(string root, string file)
	{
		var id = "water-regression-" + Guid.NewGuid().ToString("N");
		var directory = Path.Combine(root, "mods/rtsai/web/content/maps", id);
		ZipFile.ExtractToDirectory(file, directory);
		EditorHost.Open(JsonSerializer.Serialize(new { map = id }));
		var map = SimHost.World.Map;
		var cells = map.AllCells.Where(map.Contains).ToArray();
		Cell Capture(CPos c) => new(map.Tiles[c], map.Height[c], map.Resources[c]);
		bool Water(CPos c) => map.Contains(c) && map.GetTerrainInfo(c).Type.Contains("Water", StringComparison.Ordinal);
		var midX = cells.Average(c => c.X); var midY = cells.Average(c => c.Y);
		var stroke = cells.Where(c => !Water(c) && CVec.Directions.Any(d => Water(c + d)))
			.OrderBy(c => Math.Abs(c.X - midX) + Math.Abs(c.Y - midY)).First();
		var before = cells.ToDictionary(c => c, Capture);
		var point = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(stroke));
		EditorHost.Call("{\"op\":\"brush\",\"brush\":\"water\",\"radius\":3}");
		foreach (var ev in new[] { "down", "up" })
			EditorHost.Call(JsonSerializer.Serialize(new { op = "pointer", @event = ev, x = point.X, y = point.Y, button = 1 }));
		var after = cells.ToDictionary(c => c, Capture);
		var changed = cells.Count(c => before[c] != after[c]);
		Check(changed > 0, "Real coastal stroke must change terrain");
		var distant = cells.Where(c => Math.Max(Math.Abs(c.X - stroke.X), Math.Abs(c.Y - stroke.Y)) > 20).ToArray();
		Check(distant.All(c => before[c] == after[c]), "Real map's distant coasts or islands changed");
		EditorHost.Call("{\"op\":\"undo\"}");
		Check(cells.All(c => before[c] == Capture(c)), "Real map undo must be exact");
		EditorHost.Call("{\"op\":\"redo\"}");
		Check(cells.All(c => after[c] == Capture(c)), "Real map redo must be exact");
		using var exported = JsonDocument.Parse(EditorHost.Call("{\"op\":\"save\",\"title\":\"Hormuz water regression\"}"));
		var reloadedId = id + "-saved";
		var reloaded = Path.Combine(root, "mods/rtsai/web/content/maps", reloadedId);
		Directory.CreateDirectory(reloaded);
		foreach (var f in exported.RootElement.GetProperty("files").EnumerateObject())
			File.WriteAllBytes(Path.Combine(reloaded, f.Name), Convert.FromBase64String(f.Value.GetString()));
		EditorHost.Open(JsonSerializer.Serialize(new { map = reloadedId }));
		map = SimHost.World.Map;
		Check(cells.All(c => after[c] == Capture(c)), "Saved/reopened terrain must preserve every edited cell");
		Console.WriteLine($"Hormuz coast {stroke}: {changed} edited cells; {distant.Length} distant cells unchanged; undo, redo and save/reopen exact.");
		return 0;
	}
}
