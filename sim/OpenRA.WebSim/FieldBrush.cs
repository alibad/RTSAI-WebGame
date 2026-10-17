using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Widgets;

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
				stroke.Prepare();
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

			public void Paint(CPos c)
			{
				if (!visited.Add(c)) return;
				if (!map.Contains(c)) { Blocked = "Paint inside the battlefield."; return; }
				var state = Capture(c);
				if (type == null)
				{
					if (GroundPreparation.Water(map, c))
					{ Blocked = "Water and shores are preserved. Start on dry land."; return; }
					if (actors.PreviewsAtCell(c).Any())
					{ Blocked = "Units, buildings and scenery are preserved. Flatten open ground."; return; }
					ground.Add(c);
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
			// Prepare before adding history: a blocked/no-op stroke must not create an invisible undo step.
			public void Prepare()
			{
				if (type == null)
				{
					var plan = GroundPreparation.Plan(map, actors, ground, level, out var note);
					Blocked = note ?? Blocked;
					foreach (var (cell, surface) in plan)
					{
						var old = Capture(cell);
						var target = new State(surface.Tile, surface.Height, old.Resource);
						if (old == target) continue;
						before.Add(cell, old); after.Add(cell, target);
					}
					Apply(after);
				}
				else foreach (var c in before.Keys) after[c] = Capture(c);
			}
			public void Execute() { }

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
