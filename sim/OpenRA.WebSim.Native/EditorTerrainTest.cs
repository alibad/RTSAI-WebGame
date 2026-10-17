using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Text.Json;
using OpenRA;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;
using OpenRA.WebSim;

static class EditorTerrainTest
{
	readonly record struct State(ushort Tile, byte Variant, byte Height, byte Resource, byte Density);
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var id = "terrain-regression-" + Guid.NewGuid().ToString("N");
		var path = Path.Combine(opts["root"], "mods/rtsai/web/content/maps", id);
		ZipFile.ExtractToDirectory(opts["map-file"], path);
		EditorHost.Open(JsonSerializer.Serialize(new { map = id }));
		var world = SimHost.World; var map = world.Map; var wr = SimHost.WorldRenderer;
		var actors = world.WorldActor.Trait<EditorActorLayer>();
		var locomotorInfo = map.Rules.Actors[SystemActors.World].TraitInfos<LocomotorInfo>().First(i => i.Name == "tracked");
		var locomotor = new Locomotor(world.WorldActor, locomotorInfo);
		locomotor.WorldLoaded(world, wr);
		State Capture(CPos c) => new(map.Tiles[c].Type, map.Tiles[c].Index, map.Height[c], map.Resources[c].Type, map.Resources[c].Index);
		Dictionary<CPos, (float SpriteY, float GroundY)> ResourcePositions()
		{
			Sync.RunUnsynced(world, () => world.TickRender(wr));
			var renderer = world.WorldActor.TraitsImplementing<IResourceRenderer>().OfType<ResourceRenderer>().First();
			var layer = (TerrainSpriteLayer)typeof(ResourceRenderer).GetField("spriteLayer", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(renderer);
			var vertices = (Vertex[])typeof(TerrainSpriteLayer).GetField("vertices", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(layer);
			return map.AllCells.Where(c => map.Resources[c].Type != 0).ToDictionary(c => c, c =>
			{
				var uv = c.ToMPos(map);
				return (vertices[(uv.V * map.MapSize.Width + uv.U) * 4].Y, wr.Screen3DPosition(map.CenterOfCell(c)).Y);
			});
		}
		void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
		int2 Point(int x, int y) => new(1890 + (x - 592) * 5 / 3, 960 + (y - 622) * 5 / 3);
		CPos Hit(int2 p) => wr.Viewport.ViewToWorld(wr.Viewport.WorldToViewPx(p));
		string Pointer(string ev, int2 p) => EditorHost.Call($"{{\"op\":\"pointer\",\"event\":\"{ev}\",\"x\":{p.X},\"y\":{p.Y},\"button\":1}}");
		foreach (var test in new[] { ("reported river-side failure", Point(234, 900), Point(234, 900)), ("beside existing gems", Point(650, 740), Point(650, 740)), ("field edge", Point(800, 480), Point(800, 480)), ("connected corridor", Point(340, 880), Point(850, 680)) })
		{
			var before = map.AllCells.ToDictionary(c => c, Capture);
			var rendered = ResourcePositions();
			var water = map.AllCells.Where(c => GroundPreparation.Water(map, c)).ToHashSet();
			var core = new HashSet<CPos>();
			for (var i = 0; i <= 100; i++)
				foreach (var c in EditorFieldBrush.Footprint(Hit(new int2(test.Item2.X + (test.Item3.X - test.Item2.X) * i / 100, test.Item2.Y + (test.Item3.Y - test.Item2.Y) * i / 100)), 4))
					if (map.Contains(c) && !water.Contains(c) && !actors.PreviewsAtCell(c).Any()) core.Add(c);
			EditorHost.Call("{\"op\":\"brush\",\"brush\":\"flatten\",\"radius\":4}");
			var watch = Stopwatch.StartNew();
			Pointer("down", test.Item2); Pointer("move", test.Item3);
			using var up = JsonDocument.Parse(Pointer("up", test.Item3));
			var added = up.RootElement.GetProperty("placement").GetProperty("added").GetInt32();
			Check(added > 0 || core.All(c => map.Ramp[c] == 0) && core.Select(c => map.Height[c]).Distinct().Count() == 1, test.Item1 + " must prepare dry ground: " + up.RootElement);
			Check(water.All(c => before[c] == Capture(c)), "Water and shore geometry changed");
			Check(before.All(e => e.Value.Resource == map.Resources[e.Key].Type && e.Value.Density == map.Resources[e.Key].Index), "Terrain preparation changed resource data");
			var moved = ResourcePositions();
			Check(rendered.All(e => Math.Abs((moved[e.Key].SpriteY - e.Value.SpriteY) - (moved[e.Key].GroundY - e.Value.GroundY)) < 0.01f), "Existing resource sprites must follow their ground height");
			var flat = core.Count(c => map.Ramp[c] == 0);
			Check(flat >= core.Count * 9 / 10, test.Item1 + $" must create a coherent flat field, got {flat}/{core.Count} cells");
			if (test.Item1 == "connected corridor")
			{
				var start = Hit(test.Item2); var end = Hit(test.Item3);
				var seen = new HashSet<CPos> { start }; var queue = new Queue<CPos>(); queue.Enqueue(start);
				while (queue.Count > 0)
				{
					var c = queue.Dequeue();
					foreach (var d in CVec.Directions)
					{
						var n = c + d;
						if (core.Contains(n) && !seen.Contains(n) && locomotor.MovementCostToEnterCell(null, c, n, BlockedByActor.None, null) != PathGraph.MovementCostForUnreachableCell)
						{ seen.Add(n); queue.Enqueue(n); }
					}
				}
				Check(seen.Contains(end), "A tracked vehicle must have a continuous route through the prepared corridor");
			}
			if (added > 0) EditorHost.Call("{\"op\":\"undo\"}");
			Check(before.All(e => e.Value == Capture(e.Key)), "One undo must restore every tile, height and resource");
			Console.WriteLine($"{test.Item1}: {added} changes; {flat}/{core.Count} level cells; undo exact; {watch.ElapsedMilliseconds} ms.");
		}
		Console.WriteLine("Cairo terrain regression passed, including tracked-vehicle connectivity.");
		return 0;
	}
}
