using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA.Graphics;
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Support;

namespace OpenRA.WebSim
{
	/// <summary>Round resource fields and level ground, with one history entry per continuous stroke.</summary>
	public sealed class EditorFieldBrush : IEditorBrush
	{
		readonly EditorViewportControllerWidget controller;
		readonly WorldRenderer wr;
		readonly IResourceLayer resources;
		readonly IResourceRenderer[] renderers;
		readonly string type;
		readonly int radius;
		FieldAction stroke;
		int2? previous;
		public int Added { get; private set; }
		public string Blocked { get; private set; }
		public bool Flatten => type == null;

		public EditorFieldBrush(EditorViewportControllerWidget controller, WorldRenderer wr, string type, int radius)
		{
			this.controller = controller;
			this.wr = wr;
			this.type = type;
			this.radius = Math.Clamp(radius, 0, 4);
			resources = wr.World.WorldActor.Trait<IResourceLayer>();
			renderers = wr.World.WorldActor.TraitsImplementing<IResourceRenderer>().ToArray();
		}

		public static IEnumerable<CPos> Footprint(CPos center, int radius)
		{
			for (var y = -radius; y <= radius; y++)
				for (var x = -radius; x <= radius; x++)
					if (x * x + y * y <= radius * radius + radius)
						yield return center + new CVec(x, y);
		}

		public bool HandleMouseInput(MouseInput mi)
		{
			if (mi.Button == MouseButton.Right)
			{
				if (mi.Event == MouseInputEvent.Up) controller.ClearBrush();
				return true;
			}
			if (mi.Button != MouseButton.Left) return false;
			var map = wr.World.Map;
			var point = wr.Viewport.ViewToWorldPx(mi.Location);
			if (mi.Event == MouseInputEvent.Down)
			{
				stroke?.Undo();
				var cell = wr.Viewport.ViewToWorld(mi.Location);
				stroke = new FieldAction(map, resources, wr.World.WorldActor.Trait<EditorActorLayer>(), type, map.Height.Contains(cell) ? map.Height[cell] : (byte)0);
				previous = point;
				Added = 0; Blocked = null;
			}
			if (stroke == null) return true;
			// Interpolate in screen space, then use the native terrain hit test at each sample.
			var from = previous ?? point;
			var tileSize = map.Rules.TerrainInfo.TileSize;
			var steps = Math.Clamp((int)Math.Ceiling(Math.Max(Math.Abs(point.X - from.X) / (tileSize.Width / 4.0), Math.Abs(point.Y - from.Y) / (tileSize.Height / 4.0))), 1, 1024);
			for (var i = 1; i <= steps; i++)
			{
				var sample = new int2(from.X + (point.X - from.X) * i / steps, from.Y + (point.Y - from.Y) * i / steps);
				var center = wr.Viewport.ViewToWorld(wr.Viewport.WorldToViewPx(sample));
				foreach (var cell in Footprint(center, radius)) stroke.Paint(cell);
			}
			previous = point;
			if (mi.Event == MouseInputEvent.Up)
			{
				if (stroke.Count > 0) wr.World.WorldActor.Trait<EditorActionManager>().Add(stroke);
				Added = stroke.Count;
				Blocked = stroke.Blocked;
				stroke = null; previous = null;
			}
			return true;
		}

		public void Tick() { }
		public void TickRender(WorldRenderer renderer, Actor self) { }
		public IEnumerable<IRenderable> RenderAboveShroud(Actor self, WorldRenderer renderer)
		{
			if (Flatten || stroke != null) yield break;
			var map = wr.World.Map;
			foreach (var cell in Footprint(wr.Viewport.ViewToWorld(Viewport.LastMousePos), radius))
				if (map.Contains(cell) && resources.CanAddResource(type, cell))
					foreach (var r in renderers.SelectMany(r => r.RenderPreview(wr, type, map.CenterOfCell(cell)))) yield return r;
		}
		public IEnumerable<IRenderable> RenderAnnotations(Actor self, WorldRenderer renderer) => [];
		public void Dispose() { stroke?.Undo(); stroke = null; }

		sealed class FieldAction(Map map, IResourceLayer resources, EditorActorLayer actors, string type, byte level) : IEditorAction
		{
			readonly record struct State(TerrainTile Tile, byte Height, ResourceTile Resource);
			readonly Dictionary<CPos, State> before = [];
			readonly Dictionary<CPos, State> after = [];
			readonly HashSet<CPos> visited = [];
			readonly HashSet<CPos> ground = [];
			public int Count => before.Count;
			public string Blocked { get; private set; }
			public string Text => type == null ? $"Flattened {Count} ground tiles" : $"Painted {Count} {type} tiles";
			State Capture(CPos c) => new(map.Tiles[c], map.Height[c], map.Resources[c]);
			bool Water(CPos c)
			{
				var terrain = map.Rules.TerrainInfo;
				var name = terrain.TerrainTypes[terrain.GetTerrainInfo(map.Tiles[c]).TerrainType].Type;
				return name is "Water" or "Beach" || name.Contains("Water") ||
					terrain is ITemplatedTerrainInfo t && t.Templates.TryGetValue(map.Tiles[c].Type, out var template) &&
					template.Categories.Any(category => category.Contains("Shore") || category.Contains("Water") || category.Contains("beach"));
			}

			public void Paint(CPos c)
			{
				if (!visited.Add(c)) return;
				if (!map.Contains(c)) { Blocked = "Paint inside the battlefield."; return; }
				var state = Capture(c);
				if (type == null)
				{
					var terrain = map.Rules.TerrainInfo;
					if (Water(c))
					{ Blocked = "Water and shores are preserved. Start on dry land."; return; }
					if (actors.PreviewsAtCell(c).Any())
					{ Blocked = "Units, buildings and scenery are preserved. Flatten open ground."; return; }
					// The tileset's default tile is flat, buildable clear ground in both game modes.
					ground.Add(c);
					var target = new State(terrain.DefaultTerrainTile, level, state.Resource);
					if (target != state) { before.Add(c, state); after.Add(c, target); }
					return;
				}
				else
				{
					if (!resources.CanAddResource(type, c))
					{
						Blocked = map.Ramp[c] != 0 ? "This is a slope. Use Flatten ground first."
							: resources.GetResource(c).Type == type ? "This tile already has a full resource deposit."
							: "This ground cannot hold resources. Flatten dry ground first.";
						return;
					}
					resources.AddResource(type, c, resources.GetMaxDensity(type));
				}
				if (Capture(c) != state) before.Add(c, state);
			}
			public void Execute()
			{
				if (type == null) Apply(after);
				if (type == null && map.Grid.MaximumTerrainHeight > 0 && !JoinEdges())
				{
					Undo(); before.Clear(); after.Clear();
					Blocked = "There isn't room to join this level to the surrounding ground. Try a wider area away from water or buildings.";
				}
				foreach (var c in before.Keys) after[c] = Capture(c);
			}

			// Retile a small apron around the plateau with native ramps. Pin everything outside it, plus water,
			// existing resource fields and actors, so levelling never leaves vertical gaps or moves another base.
			bool JoinEdges()
			{
				var templates = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates;
				var ramps = templates.Values.Where(t => t.Size == new int2(1, 1) && t.Categories.Contains("Ramps") && t[0] is TerrainTileInfo ti && ti.Height == 0 && ti.RampType is > 0 and <= 18)
					.GroupBy(t => t[0].RampType).ToDictionary(g => g.Key, g => g.First().Id);
				if (ramps.Count == 0) return false;
				var core = ground;
				var apron = new HashSet<CPos>(core);
				foreach (var cell in core)
					foreach (var c in Footprint(cell, Math.Abs(before.GetValueOrDefault(cell, Capture(cell)).Height - level) + 3)) apron.Add(c);
				var hm = new RampTiler.HeightMap(map);
				var corners = new[] { int2.Zero, new int2(1, 0), new int2(1, 1), new int2(0, 1) };
				var sums = new Matrix<int>(hm.Target.Size);
				var counts = new Matrix<int>(hm.Target.Size);
				foreach (var c in map.AllCells)
				{
					var ti = map.Rules.TerrainInfo.GetTerrainInfo(map.Tiles[c]);
					if (!map.Contains(c) || !apron.Contains(c) || (!core.Contains(c) && (map.Resources[c].Type != 0 || actors.PreviewsAtCell(c).Any() || Water(c)))) hm.MarkUntileable(c);
					var xy = hm.CPosToXy(c);
					var shape = map.Grid.Ramps[map.Ramp[c]];
					for (var i = 0; i < 4; i++)
					{
						var p = xy + corners[i];
						if (!sums.ContainsXY(p)) continue;
						sums[p] += map.Height[c] + shape.Corners[i].Z / (map.Grid.TileScale / 2);
						counts[p]++;
					}
				}
				foreach (var e in counts.Enumerate())
					if (e.Value > 0 && hm.Adjustable[e.Xy]) hm.Target[e.Xy] = (byte)Math.Clamp((sums[e.Xy] + e.Value / 2) / e.Value, 0, map.Grid.MaximumTerrainHeight);
				foreach (var c in core)
					foreach (var offset in corners)
					{
						var p = hm.CPosToXy(c) + offset;
						if (!hm.Adjustable.ContainsXY(p) || !hm.Adjustable[p]) return false;
						hm.Target[p] = hm.LowerBound[p] = hm.UpperBound[p] = level;
					}
				var tiler = new RampTiler(map, ramps.Values.Prepend(map.Rules.TerrainInfo.DefaultTerrainTile.Type).Distinct());
				tiler.PullHeightMap(hm);
				if (!hm.Constrain(RampTiler.AdjustmentMode.Minimal)) return false;
				var (heights, shapes) = tiler.GenerateRampsAndHeights(hm, new MersenneTwister(1));
				if (heights == null) return false;
				foreach (var c in apron)
				{
					if (!map.Contains(c) || !hm.Tileable[c] || !hm.IsInternalCell(c)) continue;
					var shape = shapes[c];
					if (map.Height[c] == heights[c] && map.Ramp[c] == shape) continue;
					before.TryAdd(c, Capture(c));
					map.Height[c] = heights[c];
					map.Tiles[c] = shape == 0 ? map.Rules.TerrainInfo.DefaultTerrainTile : new TerrainTile(ramps[shape], 0);
				}
				return true;
			}
			public void Do() => Apply(after);
			public void Undo() => Apply(before);
			void Apply(Dictionary<CPos, State> states)
			{
				foreach (var (cell, state) in states)
				{
					map.Tiles[cell] = state.Tile;
					map.Height[cell] = state.Height;
					map.Resources[cell] = state.Resource;
				}
			}
		}
	}
}
