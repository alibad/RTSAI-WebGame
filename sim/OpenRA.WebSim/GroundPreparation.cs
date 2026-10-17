using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;
using OpenRA.Support;

namespace OpenRA.WebSim
{
	/// <summary>Level fields and corridors, joining their boundary with native, traversable ramp tiles.</summary>
	public static class GroundPreparation
	{
		public readonly record struct Surface(TerrainTile Tile, byte Height);
		static readonly int2[] Corners = [int2.Zero, new(1, 0), new(1, 1), new(0, 1)];

		public static bool Water(Map map, CPos c)
		{
			var terrain = map.Rules.TerrainInfo;
			var name = terrain.TerrainTypes[terrain.GetTerrainInfo(map.Tiles[c]).TerrainType].Type;
			return name is "Water" or "Beach" || name.Contains("Water") ||
				terrain is ITemplatedTerrainInfo t && t.Templates.TryGetValue(map.Tiles[c].Type, out var template) &&
				template.Categories.Any(category => category.Contains("Shore") || category.Contains("Water") || category.Contains("beach"));
		}

		public static Dictionary<CPos, Surface> Plan(Map map, EditorActorLayer actors, HashSet<CPos> painted, byte preferred, out string note)
		{
			note = null;
			bool Open(CPos c) => map.Contains(c) && !Water(map, c) && !actors.PreviewsAtCell(c).Any();
			var ground = painted.Where(Open).ToHashSet();
			// Leave a level shoulder before the slope transition. Levelling moves the isometric surface
			// beneath the pointer; the next resource stamp must still fit at the same screen position.
			foreach (var c in ground.ToArray())
				foreach (var d in CVec.Directions) if (Open(c + d)) ground.Add(c + d);
			// A field is one level surface. Touching its edge joins the whole deposit instead of pinning
			// every ore/gem tile as an obstacle and rejecting the neighbouring brush stroke.
			var queue = new Queue<CPos>(ground);
			while (queue.Count > 0)
			{
				var at = queue.Dequeue();
				foreach (var d in CVec.Directions)
				{
					var c = at + d;
					if (Open(c) && map.Resources[c].Type != 0 && ground.Add(c)) queue.Enqueue(c);
				}
			}

			var result = new Dictionary<CPos, Surface>();
			var pending = new HashSet<CPos>(ground);
			while (pending.Count > 0)
			{
				var core = new HashSet<CPos>();
				queue.Enqueue(pending.First());
				pending.Remove(queue.Peek());
				while (queue.Count > 0)
				{
					var c = queue.Dequeue(); core.Add(c);
					foreach (var d in CVec.Directions) if (pending.Remove(c + d)) queue.Enqueue(c + d);
				}
				if (!TryPlan(map, actors, core, preferred, out var piece))
				{
					// The actual riverbank/structure boundary remains intact; it must not veto the rest of dry land.
					core.RemoveWhere(c => CVec.Directions.Any(d => !map.Contains(c + d) || Water(map, c + d) || actors.PreviewsAtCell(c + d).Any()));
					if (core.Count == 0 || !TryPlan(map, actors, core, preferred, out piece))
					{ note = "The riverbank or structure boundary was kept intact."; continue; }
					note = "The riverbank or structure boundary was kept intact.";
				}
				foreach (var e in piece) result[e.Key] = e.Value;
			}
			return result;
		}

		static bool TryPlan(Map map, EditorActorLayer actors, HashSet<CPos> core, byte preferred, out Dictionary<CPos, Surface> result)
		{
			result = null;
			var terrain = map.Rules.TerrainInfo;
			if (map.Grid.MaximumTerrainHeight == 0)
			{
				result = core.ToDictionary(c => c, _ => new Surface(terrain.DefaultTerrainTile, 0));
				return true;
			}
			var templates = ((ITemplatedTerrainInfo)terrain).Templates;
			var rampSets = new[] { "Ramps", "RTS AI dirt slopes", "RTS AI rough slopes", "RTS AI sand slopes" }
				.ToDictionary(category => category, category => templates.Values.Where(t => t.Size == new int2(1, 1) && t.Categories.Contains(category) && t[0] is TerrainTileInfo ti && ti.Height == 0 && ti.RampType is > 0 and <= 18)
					.GroupBy(t => t[0].RampType).ToDictionary(g => g.Key, g => g.First().Id));
			var ramps = rampSets["Ramps"];
			if (ramps.Count == 0) return false;
			var tiler = new RampTiler(map, ramps.Values.Prepend(terrain.DefaultTerrainTile.Type).Distinct());
			var levels = Enumerable.Range(0, map.Grid.MaximumTerrainHeight + 1).OrderBy(h => Math.Abs(h - preferred)).ThenBy(h => h);
			foreach (var level in levels)
				foreach (var margin in new[] { 3, 6, 12, (int)map.Grid.MaximumTerrainHeight + 4 }.Distinct())
				{
					var apron = new HashSet<CPos>(core);
					foreach (var cell in core)
						foreach (var c in EditorFieldBrush.Footprint(cell, margin)) if (map.Tiles.Contains(c)) apron.Add(c);
					var hm = new RampTiler.HeightMap(map);
					var sums = new Matrix<int>(hm.Target.Size);
					var counts = new Matrix<int>(hm.Target.Size);
					var fixedCorners = new Dictionary<int2, (int Min, int Max)>();
					foreach (var c in map.AllCells)
					{
						var locked = !map.Contains(c) || !apron.Contains(c) || !core.Contains(c) && (map.Resources[c].Type != 0 || actors.PreviewsAtCell(c).Any() || Water(map, c));
						if (locked) hm.MarkUntileable(c);
						var xy = hm.CPosToXy(c);
						var shape = map.Grid.Ramps[map.Ramp[c]];
						for (var i = 0; i < 4; i++)
						{
							var p = xy + Corners[i];
							if (!sums.ContainsXY(p)) continue;
							var height = map.Height[c] + shape.Corners[i].Z / (map.Grid.TileScale / 2);
							sums[p] += height; counts[p]++;
							if (locked)
							{
								var old = fixedCorners.GetValueOrDefault(p, (height, height));
								fixedCorners[p] = (Math.Min(old.Item1, height), Math.Max(old.Item2, height));
							}
						}
					}
					foreach (var e in counts.Enumerate())
						if (e.Value > 0 && hm.Adjustable[e.Xy])
						{
							hm.Target[e.Xy] = (byte)Math.Clamp((sums[e.Xy] + e.Value / 2) / e.Value, 0, map.Grid.MaximumTerrainHeight);
							hm.UpperBound[e.Xy] = map.Grid.MaximumTerrainHeight;
						}
					var fits = true;
					foreach (var c in core)
						foreach (var offset in Corners)
						{
							var p = hm.CPosToXy(c) + offset;
							if (!hm.Adjustable.ContainsXY(p)) { fits = false; break; }
							if (!hm.Adjustable[p])
							{
								if (!fixedCorners.TryGetValue(p, out var h) || h.Min != level || h.Max != level) fits = false;
								continue;
							}
							hm.Target[p] = hm.LowerBound[p] = hm.UpperBound[p] = (byte)level;
						}
					if (!fits) continue;
					tiler.PullHeightMap(hm);
					if (!hm.Constrain(RampTiler.AdjustmentMode.Minimal)) continue;
					var (heights, shapes) = tiler.GenerateRampsAndHeights(hm, new MersenneTwister(1));
					if (heights == null || core.Any(c => shapes[c] != 0 || heights[c] != level)) continue;
					result = [];
					foreach (var c in apron)
					{
						if (!map.Contains(c) || !hm.Tileable[c] || !hm.IsInternalCell(c)) continue;
						var tile = map.Tiles[c]; var ramp = shapes[c];
						if (core.Contains(c) || ramp == 0 && map.Ramp[c] != 0) tile = terrain.DefaultTerrainTile;
						else if (ramp != map.Ramp[c])
						{
							var source = templates[map.Tiles[c].Type];
							var category = rampSets.Keys.FirstOrDefault(source.Categories.Contains) ?? "Ramps";
							var set = rampSets[category];
							tile = new TerrainTile(set.GetValueOrDefault(ramp, ramps[ramp]), 0);
						}
						result[c] = new Surface(tile, heights[c]);
					}
					return true;
				}
			return false;
		}
	}
}
