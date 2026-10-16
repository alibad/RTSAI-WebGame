#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available to you under the terms of the GNU General Public License
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version. For more
 * information, see COPYING.
 */
#endregion

using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA.Graphics;
using OpenRA.Mods.Common.EditorBrushes;
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Primitives;
using OpenRA.Support;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Lakes and rivers for the browser editor, with shores. A stroke paints open water while it is dragged; on release
	/// all the water painted with this brush in the session is retiled the way the random map generator paints coasts
	/// (TSMapGenerator: a smoothed land plan, its borders tiled with the rules' "Segmented" shore pieces by the
	/// Terraformer, open water filled in), so lakes get beaches instead of square edges and strokes that touch merge.
	/// One stroke is one undoable action.
	/// </summary>
	public sealed class EditorWaterBrush : IEditorBrush
	{
		// The random map generator's coast settings (RTSAI-Mod rules/map-generators.yaml, TSMapGenerator@rtsai).
		public const ushort WaterTile = 322;
		const string ShoreSegment = "Shore";
		static ushort WaterFor(Map map) => map.Grid.Type == MapGridType.Rectangular ? (ushort)(map.Tileset == "DESERT" ? 256 : 1) : WaterTile;
		static string ShoreFor(Map map) => map.Grid.Type == MapGridType.Rectangular ? "Beach" : ShoreSegment;
		const int MinimumLandSeaThickness = 4, TerrainSmoothing = 4, SmoothingThreshold = 833, MinimumBeachDeviation = 3;

		/// <summary>How far water and its shores keep from a change of ground height (shore pieces are flat).</summary>
		const int LevelMargin = 3;

		/// <summary>The session's water plan and the tiles it replaced; reset when a map opens.</summary>
		internal sealed class Session
		{
			public Matrix<bool> Plan;
			public Dictionary<MPos, (TerrainTile Tile, byte Height, ResourceTile Resource)> Base = [];
			public Dictionary<MPos, TerrainTile> Painted = [];

			public Session Clone() => new() { Plan = Plan?.Clone(), Base = new(Base), Painted = new(Painted) };
		}

		internal static Session Current = new();

		/// <summary>Why the last stroke changed nothing (shown by the page), or null.</summary>
		public static string LastError;

		public static void Reset()
		{
			Current = new Session();
			LastError = null;
		}

		static bool Same(TerrainTile a, TerrainTile b) => a.Type == b.Type && a.Index == b.Index;

		/// <summary>Whether this map's tileset has the generator's water and shore pieces.</summary>
		public static bool Supported(Map map) =>
			map.Rules.TerrainInfo is ITemplatedTerrainInfo t && t.Templates.ContainsKey(WaterFor(map)) && MultiBrush.LoadCollection(map, "Segmented").Length > 0;

		readonly WorldRenderer worldRenderer;
		readonly World world;
		readonly EditorViewportControllerWidget editorWidget;
		readonly EditorActionManager actions;
		readonly int radius;
		WaterEditorAction stroke;
		CPos? last;

		public EditorWaterBrush(EditorViewportControllerWidget editorWidget, WorldRenderer wr, int radius)
		{
			this.editorWidget = editorWidget;
			worldRenderer = wr;
			world = wr.World;
			actions = world.WorldActor.Trait<EditorActionManager>();
			this.radius = Math.Clamp(radius, 2, 8);
		}

		public bool HandleMouseInput(MouseInput mi)
		{
			if (mi.Button == MouseButton.Right)
			{
				if (mi.Event == MouseInputEvent.Up)
					editorWidget.ClearBrush();
				return true;
			}

			if (mi.Button != MouseButton.Left && !(mi.Event == MouseInputEvent.Move && stroke != null))
				return false;

			var cell = worldRenderer.Viewport.ViewToWorld(mi.Location);
			if (mi.Event == MouseInputEvent.Down)
			{
				stroke = new WaterEditorAction(world.Map, radius);
				last = null;
			}

			if (stroke == null)
				return true;

			// The line from the last cell, so a fast stroke leaves no gaps.
			var from = last ?? cell;
			var steps = Math.Max(Math.Abs(cell.X - from.X), Math.Abs(cell.Y - from.Y));
			for (var i = 0; i <= steps; i++)
			{
				var t = steps == 0 ? 0 : (float)i / steps;
				stroke.Stamp(new CPos(from.X + (int)MathF.Round((cell.X - from.X) * t), from.Y + (int)MathF.Round((cell.Y - from.Y) * t)));
			}

			last = cell;
			if (mi.Event == MouseInputEvent.Up)
			{
				actions.Add(stroke);
				stroke = null;
			}

			return true;
		}

		public void Tick() { }
		public void TickRender(WorldRenderer wr, Actor self) { }
		public IEnumerable<IRenderable> RenderAboveShroud(Actor self, WorldRenderer wr) => [];
		public IEnumerable<IRenderable> RenderAnnotations(Actor self, WorldRenderer wr) => [];

		public void Dispose()
		{
			// A stroke cut short (the brush changed mid-drag) leaves no preview water behind.
			stroke?.Restore();
			stroke = null;
		}

		/// <summary>The tiles, heights and ore of every cell, in MapCoords order.</summary>
		sealed record CellsState(TerrainTile[] Tiles, byte[] Heights, ResourceTile[] Resources);

		/// <summary>One stroke: the open water painted as a preview, then the session's water retiled with shores.</summary>
		sealed class WaterEditorAction : IEditorAction
		{
			// Water already on the map that a stroke touches joins it: open water and the shore and beach pieces around
			// it, so the new shores go around the old ones instead of over them.
			static readonly System.Text.RegularExpressions.Regex WaterCategory = new(@"^(Water|ZMM Water|Shore Pieces|ZMM Shore Pieces|Sand \(beach\).*|RTS AI water edges)$");

			readonly Map map;
			readonly int radius;
			readonly Rectangle bounds;
			readonly Matrix<bool> stamped;
			readonly MPos[] cells;
			readonly CellsState before;
			readonly Session beforeSession;
			CPos? first;
			CellsState after;
			Session afterSession;

			public string Text { get; private set; } = "Painted water";

			public WaterEditorAction(Map map, int radius)
			{
				this.map = map;
				this.radius = radius;
				bounds = CellLayerUtils.CellBounds(map);
				stamped = new Matrix<bool>(bounds.Width, bounds.Height);
				cells = map.AllCells.MapCoords.ToArray();
				before = Capture();
				beforeSession = Current.Clone();
			}

			CellsState Capture() => new(cells.Select(c => map.Tiles[c]).ToArray(), cells.Select(c => map.Height[c]).ToArray(), cells.Select(c => map.Resources[c]).ToArray());

			/// <summary>Adds a disc of water around a cell, shown at once as open water.</summary>
			public void Stamp(CPos center)
			{
				first ??= center;
				for (var dy = -radius; dy <= radius; dy++)
					for (var dx = -radius; dx <= radius; dx++)
					{
						if (dx * dx + dy * dy > radius * radius + radius)
							continue;

						var c = new CPos(center.X + dx, center.Y + dy);
						var xy = new int2(c.X - bounds.Left, c.Y - bounds.Top);
						if (!stamped.ContainsXY(xy) || stamped[xy])
							continue;

						stamped[xy] = true;
						if (map.Tiles.Contains(c))
							map.Tiles[c] = new TerrainTile(WaterFor(map), 0);
					}
			}

			public void Restore() => Apply(before);

			public void Execute()
			{
				// Back to the map before this stroke, then the cells earlier strokes painted (unless edited since) back to
				// what they were before any water: the session's whole water is tiled again, as one plan.
				Restore();
				var session = Current.Clone();
				foreach (var (mpos, tile) in session.Painted)
					if (Same(map.Tiles[mpos], tile))
					{
						var b = session.Base[mpos];
						map.Tiles[mpos] = b.Tile;
						map.Height[mpos] = b.Height;
						map.Resources[mpos] = b.Resource;
					}

				var pre = Capture();
				// Water keeps to the level ground where the stroke starts: shore pieces are flat, so on a hillside they
				// would leave gaps. Earlier strokes and the water they joined stay as they are.
				var level = first is CPos f && map.Height.Contains(f) ? map.Height[f] : (byte)0;
				var flat = LevelGround(level);
				var plan = Matrix<bool>.Zip(stamped, flat, (a, b) => a && b);
				if (session.Plan != null)
					plan = Matrix<bool>.Zip(session.Plan, plan, (a, b) => a || b);
				MergeTouchingWater(plan);
				if (!plan.Data.Any(w => w))
				{
					Restore();
					LastError = "Water needs level ground: start the stroke on flat land.";
					Text = "Water (no level ground)";
					after = before;
					afterSession = beforeSession;
					Current = beforeSession.Clone();
					return;
				}

				// Each shore piece and water cell is painted at the ground height where it lies (no height given).

				var land = MatrixUtils.BooleanBlotch(plan.Map(w => !w), TerrainSmoothing, SmoothingThreshold, Terraformer.FractionMax, MinimumLandSeaThickness, true);
				var brushes = MultiBrush.LoadCollection(map, "Segmented");
				var paths = CellLayerUtils.FromMatrixPoints(MatrixUtils.BordersToPoints(land), map.Tiles)
					.Select(points => TilingPath.QuickCreate(map, brushes, points, MinimumBeachDeviation, ShoreFor(map), ShoreFor(map)).ExtendEdge(4))
					.ToList();
				var terraformer = new Terraformer(null, map, Game.ModData, [], Symmetry.Mirror.None, 1);
				var sides = terraformer.PaintLoopsAndFill(
					new MersenneTwister(plan.Data.Count(w => w)), paths, Terraformer.Side.In, [new MultiBrush().WithTemplate(map, WaterFor(map), CVec.Zero)], null, null, null);
				if (sides == null)
				{
					// The shores didn't fit (a stroke too thin or squeezed against other water): nothing changes.
					Restore();
					LastError = "The shores didn't fit there. Try a wider stroke or more room.";
					Text = "Water (didn't fit)";
					after = before;
					afterSession = beforeSession;
					Current = beforeSession.Clone();
					return;
				}

				for (var i = 0; i < cells.Length; i++)
				{
					var mpos = cells[i];
					var changed = !Same(map.Tiles[mpos], pre.Tiles[i]) || map.Height[mpos] != pre.Heights[i];
					// No ore on the water and its shores.
					if (changed && map.Resources[mpos].Type != 0)
						map.Resources[mpos] = default;
					if (!changed)
						continue;

					session.Base.TryAdd(mpos, (pre.Tiles[i], pre.Heights[i], pre.Resources[i]));
					session.Painted[mpos] = map.Tiles[mpos];
				}

				session.Plan = plan;
				LastError = null;
				after = Capture();
				afterSession = session;
				Current = session.Clone();
			}

			/// <summary>Cells at the given height with no slope within LevelMargin cells (CPos-aligned, like the plan).</summary>
			Matrix<bool> LevelGround(byte level)
			{
				var level0 = new Matrix<bool>(bounds.Width, bounds.Height);
				for (var y = 0; y < bounds.Height; y++)
					for (var x = 0; x < bounds.Width; x++)
					{
						var c = new CPos(x + bounds.Left, y + bounds.Top);
						level0[x, y] = !map.Height.Contains(c) || (map.Height[c] == level && map.Ramp[c] == 0);
					}

				var flat = new Matrix<bool>(bounds.Width, bounds.Height);
				for (var y = 0; y < bounds.Height; y++)
					for (var x = 0; x < bounds.Width; x++)
					{
						var ok = true;
						for (var dy = -LevelMargin; ok && dy <= LevelMargin; dy++)
							for (var dx = -LevelMargin; ok && dx <= LevelMargin; dx++)
								if (level0.ContainsXY(x + dx, y + dy) && !level0[x + dx, y + dy])
									ok = false;
						flat[x, y] = ok;
					}

				return flat;
			}

			/// <summary>Adds the water bodies (open water and their shores) that the plan touches.</summary>
			void MergeTouchingWater(Matrix<bool> plan)
			{
				var templates = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates;
				bool IsWater(CPos c) =>
					map.Tiles.Contains(c) && templates.TryGetValue(map.Tiles[c].Type, out var t) && t.Categories.Any(WaterCategory.IsMatch);

				var queue = new Queue<int2>(plan.Enumerate().Where(e => e.Value).Select(e => e.Xy));
				while (queue.Count > 0)
				{
					var xy = queue.Dequeue();
					foreach (var d in new[] { new int2(1, 0), new int2(-1, 0), new int2(0, 1), new int2(0, -1) })
					{
						var n = xy + d;
						if (!plan.ContainsXY(n) || plan[n] || !IsWater(new CPos(n.X + bounds.Left, n.Y + bounds.Top)))
							continue;

						plan[n] = true;
						queue.Enqueue(n);
					}
				}
			}

			public void Do()
			{
				Apply(after);
				Current = afterSession.Clone();
			}

			public void Undo()
			{
				Apply(before);
				Current = beforeSession.Clone();
			}

			void Apply(CellsState state)
			{
				for (var i = 0; i < cells.Length; i++)
				{
					var c = cells[i];
					if (!Same(map.Tiles[c], state.Tiles[i]))
						map.Tiles[c] = state.Tiles[i];
					if (map.Height[c] != state.Heights[i])
						map.Height[c] = state.Heights[i];
					if (map.Resources[c].Type != state.Resources[i].Type || map.Resources[c].Index != state.Resources[i].Index)
						map.Resources[c] = state.Resources[i];
				}
			}
		}
	}
}
