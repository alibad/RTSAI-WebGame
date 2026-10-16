using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.WebSim;

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
		void Brush(string type) => EditorHost.Call($"{{\"op\":\"brush\",\"brush\":\"resource\",\"type\":\"{type}\"}}");
		string Pointer(string ev, CPos cell, int button = 1)
		{
			var p = SimHost.WorldRenderer.ScreenPxPosition(map.CenterOfCell(cell));
			return EditorHost.Call($"{{\"op\":\"pointer\",\"event\":\"{ev}\",\"x\":{p.X},\"y\":{p.Y},\"button\":{button}}}");
		}
		void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
		Brush("Gems"); Pointer("down", start);
		using (var up = JsonDocument.Parse(Pointer("up", start)))
			Check(up.RootElement.GetProperty("placement").GetProperty("added").GetInt32() == 1, "Gem click must report a changed tile");
		Check(map.Resources[start].Type == 2, "Gem click must write Gems, not Ore");
		EditorHost.Call("{\"op\":\"undo\"}"); Check(map.Resources[start].Type == 0, "Undo must remove the clicked gem");
		EditorHost.Call("{\"op\":\"redo\"}"); Check(map.Resources[start].Type == 2, "Redo must restore the gem");
		EditorHost.Call("{\"op\":\"undo\"}");
		Pointer("down", start); Pointer("move", end);
		using (var up = JsonDocument.Parse(Pointer("up", end)))
			Check(up.RootElement.GetProperty("placement").GetProperty("added").GetInt32() >= row.Length - 6, "A coalesced fast drag must paint the whole segment");
		Check(row.Skip(3).Take(row.Length - 6).All(c => map.Resources[c].Type == 2), "Gem drag must have no holes on flat ground");
		EditorHost.Call("{\"op\":\"undo\"}"); Check(row.All(c => map.Resources[c].Type == 0), "One undo must remove the whole stroke");
		Brush("Ore"); Pointer("down", start); Pointer("up", start);
		Check(map.Resources[start].Type == 1, "Ore remains a separate resource");
		var slope = row[1]; map.Ramp[slope] = 1;
		Brush("Gems"); Pointer("down", slope);
		using (var up = JsonDocument.Parse(Pointer("up", slope)))
		{
			var result = up.RootElement.GetProperty("placement");
			Check(result.GetProperty("added").GetInt32() == 0 && result.GetProperty("blocked").GetString().Contains("slope"), "Blocked slopes need explicit feedback");
		}
		Check(map.Resources[slope].Type == 0, "Resource rules must still reject slopes");
		using (var stopped = JsonDocument.Parse(Pointer("up", end, 2)))
			Check(stopped.RootElement.GetProperty("brush").GetString() == "select", "Right-click must stop the brush in both engine and UI");
		Console.WriteLine("Editor resources passed: gem click, continuous fast drag, one-stroke undo/redo, distinct ore, slope feedback and right-click stop.");
		return 0;
	}
}
