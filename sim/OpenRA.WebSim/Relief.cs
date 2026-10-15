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
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OpenRA.FileSystem;
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Primitives;
using OpenRA.Support;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The ground of a real place: a map from the Earth compiler (flat) gets the place's hills and valleys from elevation
	/// data, built with the engine's own slope tiles (RampTiler, as the random map generator uses them). Every slope is at
	/// most one level per cell, so ground units walk anywhere they could before; bases, ore fields and water keep level
	/// ground, as the engine requires (no buildings or ore on slopes, water is flat).
	/// </summary>
	public static class Relief
	{
		/// <summary>The most height levels a place gets: mountains are pressed into this many.</summary>
		const int MaximumLevels = 10;

		/// <summary>One level is at least this share of a cell's width in metres: flat places stay nearly flat.</summary>
		const float MinimumLevelPerCell = 0.2f;

		/// <summary>Level ground kept around start positions and ore mines (cells).</summary>
		const int SpawnLevelRadius = 7;
		const int MineLevelRadius = 3;

		/// <summary>The slope tiles for each ground: grass (the stock ramps), and the RTS AI sand, rough and dirt slopes.</summary>
		static readonly (string Category, int Set)[] SlopeCategories =
		[
			("Ramps", Grass), ("RTS AI dirt slopes", Dirt), ("RTS AI rough slopes", Rough), ("RTS AI sand slopes", Sand),
		];

		// The Earth compiler's ground classes: its corner-transition templates are 1000 + 16 * set + corner mask.
		const int Grass = -1, Dirt = 1, Rough = 2, Sand = 3;
		const int TransitionBase = 1000;

		static readonly Regex WaterCategory = new(@"^(Water|ZMM Water|Shore Pieces|ZMM Shore Pieces|Sand \(beach\).*|RTS AI water edges)$");

		/// <summary>
		/// Shapes a map's ground from elevation. `json`: {"files": {name: base64} (map.yaml, map.bin, map.png),
		/// "elevation": base64 float32 metres, "columns", "rows": the grid, one point per cell corner, laid out as the Earth
		/// compiler's evidence square (point (i, j) is corner X - Y = i - 1, X + Y = j - 1), "metersPerCell",
		/// "keep": [{"u", "v", "r"}] (MPos and radius: more level ground, e.g. the sites a mission may use)}.
		/// Returns {"files", "levels", "metersPerLevel", "slopes", "lowest", "highest"} or {"error"}.
		/// </summary>
		public static string Apply(string json)
		{
			try
			{
				using var doc = JsonDocument.Parse(json);
				var r = doc.RootElement;
				var columns = r.GetProperty("columns").GetInt32();
				var rows = r.GetProperty("rows").GetInt32();
				var metersPerCell = r.GetProperty("metersPerCell").GetSingle();
				var raw = Convert.FromBase64String(r.GetProperty("elevation").GetString());
				if (raw.Length != columns * rows * 4)
					throw new InvalidOperationException("The elevation grid doesn't match its size.");

				var elevation = new float[columns * rows];
				Buffer.BlockCopy(raw, 0, elevation, 0, raw.Length);

				var source = new ZipFileLoader.ReadWriteZipFile();
				foreach (var file in r.GetProperty("files").EnumerateObject())
					source.Update(file.Name, Convert.FromBase64String(file.Value.GetString()));

				var map = new Map(SimHost.ModData, source);

				var keep = new List<(MPos Cell, int Radius)>();
				if (r.TryGetProperty("keep", out var k) && k.ValueKind == JsonValueKind.Array)
					foreach (var e in k.EnumerateArray())
						keep.Add((new MPos(e.GetProperty("u").GetInt32(), e.GetProperty("v").GetInt32()), e.GetProperty("r").GetInt32()));

				float Elevation(int2 corner)
				{
					var i = Math.Clamp(corner.X - corner.Y + 1, 0, columns - 1);
					var j = Math.Clamp(corner.X + corner.Y + 1, 0, rows - 1);
					return elevation[j * columns + i];
				}

				var result = Raise(map, Elevation, metersPerCell, keep);

				using var package = new ZipFileLoader.ReadWriteZipFile();
				map.Save(package);
				var files = new StringBuilder();
				foreach (var name in package.Contents)
				{
					using var s = package.GetStream(name);
					files.Append(files.Length == 0 ? "" : ",").Append(Snapshot.Json(name)).Append(':')
						.Append(Snapshot.Json(Convert.ToBase64String(s.ReadAllBytes())));
				}

				return $"{{\"files\":{{{files}}},{result}}}";
			}
			catch (Exception e) when (e is InvalidOperationException || e is JsonException || e is FormatException || e is KeyNotFoundException || e is YamlException)
			{
				Log.Write("debug", "Relief failed: " + e);
				return $"{{\"error\":{Snapshot.Json(e.Message)}}}";
			}
		}

		/// <summary>
		/// Raises the map's ground to the elevation (metres at each cell corner, RampTiler corner space). Returns the JSON
		/// fields describing what was made. When the slopes can't be fitted, the relief is flattened and tried again.
		/// </summary>
		static string Raise(Map map, Func<int2, float> elevationAt, float metersPerCell, List<(MPos Cell, int Radius)> keep)
		{
			var probe = new RampTiler.HeightMap(map);
			var size = probe.Target.Size;
			var meters = new Matrix<float>(size);
			var inside = new List<float>();
			for (var y = 0; y < size.Y; y++)
			{
				for (var x = 0; x < size.X; x++)
				{
					var corner = probe.XyToCPos(new int2(x, y));
					var e = elevationAt(new int2(corner.X, corner.Y));
					meters[x, y] = e;
					if (map.Contains(corner))
						inside.Add(e);
				}
			}

			inside.Sort();
			var lowest = inside.Count > 0 ? inside[inside.Count * 3 / 100] : 0;
			var highest = inside.Count > 0 ? inside[inside.Count * 97 / 100] : 0;
			var perLevel = Math.Max((highest - lowest) / MaximumLevels, Math.Max(1, MinimumLevelPerCell * metersPerCell));

			// Too steep to fit (mountains next to level bases, say): less relief, then none.
			for (var attempt = 0; attempt < 4; attempt++, perLevel *= 1.7f)
			{
				var levels = meters.Map(e => Math.Clamp((e - lowest) / perLevel, 0, MaximumLevels));
				var made = Shape(map, levels, keep, attempt == 3);
				if (made != null)
					return string.Create(CultureInfo.InvariantCulture,
						$"\"levels\":{made.Value.Levels},\"slopes\":{made.Value.Slopes},\"metersPerLevel\":{perLevel:F1},\"lowest\":{lowest:F0},\"highest\":{highest:F0}");
			}

			return "\"levels\":0,\"slopes\":0";
		}

		/// <summary>
		/// Fits the engine's slope tiles to target levels (per cell corner) and paints them, keeping each cell's ground
		/// (sand stays sand on a slope). Water and the level areas stay level. Returns null if the slopes don't fit.
		/// </summary>
		static (int Levels, int Slopes)? Shape(Map map, Matrix<float> levels, List<(MPos Cell, int Radius)> keep, bool flat)
		{
			var templates = ((ITemplatedTerrainInfo)map.Rules.TerrainInfo).Templates;
			var heightMap = new RampTiler.HeightMap(map);
			var size = heightMap.Target.Size;
			var cells = map.AllCells.MapCoords.ToArray();
			var original = cells.ToDictionary(c => c, c => (map.Tiles[c], map.Height[c]));

			bool IsWater(MPos uv) =>
				templates.TryGetValue(map.Tiles[uv].Type, out var t) && t.Categories.Any(WaterCategory.IsMatch);

			int CornerLevel(int2 xy) => (int)MathF.Round(levels[xy]);

			// Water: each body at the level of its lowest corner (a river runs in its valley), flat, left untiled.
			var water = new CellLayer<bool>(map);
			foreach (var uv in cells)
				water[uv] = IsWater(uv);

			var seen = new CellLayer<bool>(map);
			foreach (var start in cells)
			{
				if (!water[start] || seen[start])
					continue;

				var body = new List<MPos>();
				var queue = new Queue<CPos>();
				queue.Enqueue(start.ToCPos(map));
				seen[start] = true;
				while (queue.Count > 0)
				{
					var c = queue.Dequeue();
					body.Add(c.ToMPos(map));
					foreach (var d in Neighbours8)
					{
						var n = c + d;
						if (water.Contains(n) && water[n] && !seen[n])
						{
							seen[n] = true;
							queue.Enqueue(n);
						}
					}
				}

				var level = flat ? 0 : body.Min(uv => Corners(heightMap, uv.ToCPos(map)).Min(xy => (int)MathF.Floor(levels[xy])));
				foreach (var uv in body)
					map.Height[uv] = (byte)level;
			}

			// Level ground: start positions, ore mines and their fields, and the places the page asks for (bases).
			var level0 = new CellLayer<bool>(map);
			void KeepAround(CPos centre, int radius)
			{
				for (var dy = -radius; dy <= radius; dy++)
					for (var dx = -radius; dx <= radius; dx++)
						if (dx * dx + dy * dy <= radius * radius + radius && level0.Contains(centre + new CVec(dx, dy)))
							level0[centre + new CVec(dx, dy)] = true;
			}

			foreach (var actor in map.ActorDefinitions)
			{
				var location = actor.Value.NodeWithKeyOrDefault("Location");
				if (location == null)
					continue;

				var at = FieldLoader.GetValue<CPos>("Location", location.Value.Value);
				if (actor.Value.Value == "mpspawn")
					KeepAround(at, SpawnLevelRadius);
				else if (actor.Value.Value == "oremine")
					KeepAround(at, MineLevelRadius);
			}

			foreach (var uv in cells)
				if (map.Resources[uv].Type != 0)
					KeepAround(uv.ToCPos(map), 1);

			foreach (var (centre, radius) in keep)
				if (map.Contains(centre))
					KeepAround(centre.ToCPos(map), radius);

			foreach (var uv in cells)
				if (water[uv])
					level0[uv] = false;

			// The top and bottom rows: a raised cell is drawn higher up the screen, so near the top edge it would leave the
			// map, and near the bottom it would leave a gap below. Corners there are held down; the land slopes to them.
			var top = map.Bounds.Top;
			var bottom = map.Bounds.Bottom - 1;
			var ceiling = new Matrix<int>(size);
			for (var y = 0; y < size.Y; y++)
			{
				for (var x = 0; x < size.X; x++)
				{
					var c = heightMap.XyToCPos(new int2(x, y));
					var row = c.X + c.Y;
					ceiling[x, y] = Math.Clamp(Math.Min(row - 2 - top - 3, bottom - row), 0, MaximumLevels);
				}
			}

			foreach (var uv in cells)
			{
				var cpos = uv.ToCPos(map);
				if (water[uv] || !heightMap.IsInternalCell(cpos))
					heightMap.MarkUntileable(cpos);
			}

			// Each level area takes the median level of its corners (one level per connected area, so they fit).
			var levelOf = new CellLayer<int>(map);
			var areaSeen = new CellLayer<bool>(map);
			foreach (var start in cells)
			{
				if (!level0[start] || areaSeen[start])
					continue;

				var area = new List<CPos>();
				var queue = new Queue<CPos>();
				queue.Enqueue(start.ToCPos(map));
				areaSeen[start] = true;
				while (queue.Count > 0)
				{
					var c = queue.Dequeue();
					area.Add(c);
					foreach (var d in Neighbours8)
					{
						var n = c + d;
						if (level0.Contains(n) && level0[n] && !areaSeen[n])
						{
							areaSeen[n] = true;
							queue.Enqueue(n);
						}
					}
				}

				var corners = area.SelectMany(c => Corners(heightMap, c)).Where(heightMap.Adjustable.ContainsXY).ToList();
				var sorted = corners.Select(CornerLevel).Order().ToList();
				var level = flat || sorted.Count == 0 ? 0 : sorted[sorted.Count / 2];
				level = Math.Min(level, corners.Count == 0 ? 0 : corners.Min(xy => ceiling[xy]));
				foreach (var c in area)
					levelOf[c] = level;
			}

			for (var y = 0; y < size.Y; y++)
			{
				for (var x = 0; x < size.X; x++)
				{
					if (!heightMap.Adjustable[x, y])
						continue;

					heightMap.Target[x, y] = (byte)(flat ? 0 : Math.Min(CornerLevel(new int2(x, y)), ceiling[x, y]));
					heightMap.UpperBound[x, y] = (byte)Math.Min(heightMap.UpperBound[x, y], ceiling[x, y]);
				}
			}

			foreach (var uv in cells)
			{
				if (!level0[uv])
					continue;

				var cpos = uv.ToCPos(map);
				var level = (byte)levelOf[cpos];
				foreach (var xy in Corners(heightMap, cpos))
				{
					if (!heightMap.Adjustable.ContainsXY(xy) || !heightMap.Adjustable[xy])
						continue;

					heightMap.Target[xy] = level;
					heightMap.LowerBound[xy] = level;
					heightMap.UpperBound[xy] = level;
				}
			}

			var rampTiler = new RampTiler(map, SlopeTemplates(templates, Grass).Values.Prepend((ushort)0).Distinct());
			rampTiler.PullHeightMap(heightMap);
			if (!heightMap.Constrain(RampTiler.AdjustmentMode.LowerMiddle))
				return Undo(map, original);

			var (heights, ramps) = rampTiler.GenerateRampsAndHeights(heightMap, new MersenneTwister(map.MapSize.Width * 7919 + map.MapSize.Height));
			if (heights == null)
				return Undo(map, original);

			// Paint: a slope keeps the cell's ground (the majority of its corners), level cells keep their tile.
			var slopeSets = SlopeCategories.ToDictionary(s => s.Set, s => SlopeTemplates(templates, s.Set));
			var slopes = 0;
			var highest = 0;
			foreach (var uv in cells)
			{
				var cpos = uv.ToCPos(map);
				if (heightMap.Tileable[cpos] && heightMap.IsInternalCell(cpos))
				{
					map.Height[uv] = heights[cpos];
					var ramp = ramps[cpos];
					if (ramp != 0)
					{
						var ground = Ground(map.Tiles[uv].Type);
						var set = slopeSets.TryGetValue(ground, out var s) && s.ContainsKey(ramp) ? s : slopeSets[Grass];
						if (!set.TryGetValue(ramp, out var template))
							return Undo(map, original);

						map.Tiles[uv] = new TerrainTile(template, 0);
						if (map.Resources[uv].Type != 0)
							map.Resources[uv] = default;
						slopes++;
					}
				}

				highest = Math.Max(highest, map.Height[uv]);
			}

			return (highest, slopes);
		}

		static (int Levels, int Slopes)? Undo(Map map, Dictionary<MPos, (TerrainTile Tile, byte Height)> original)
		{
			foreach (var (uv, (tile, height)) in original)
			{
				map.Tiles[uv] = tile;
				map.Height[uv] = height;
			}

			return null;
		}

		/// <summary>The Earth compiler's ground under a tile: a corner-transition template's set where it covers two or more corners.</summary>
		static int Ground(ushort template)
		{
			var index = template - TransitionBase;
			if (index < 16 || index >= 64)
				return Grass;

			var mask = index % 16;
			var corners = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
			return corners >= 2 ? index / 16 : Grass;
		}

		/// <summary>One single-cell slope template per ramp type for a ground (a category of the tileset), if it has them.</summary>
		static Dictionary<byte, ushort> SlopeTemplates(IReadOnlyDictionary<ushort, TerrainTemplateInfo> templates, int set)
		{
			var category = SlopeCategories.First(s => s.Set == set).Category;
			var byRamp = new Dictionary<byte, ushort>();
			foreach (var t in templates.Values.OrderBy(t => t.Id))
			{
				if (t.Size != new int2(1, 1) || !t.Categories.Contains(category) || t[0] is not TerrainTileInfo tile)
					continue;

				// The generator leaves out the second pair of saddles (19, 20): 17 and 18 have the same corners.
				if (tile.RampType != 0 && tile.RampType <= 18 && tile.Height == 0)
					byRamp.TryAdd(tile.RampType, t.Id);
			}

			return byRamp;
		}

		static IEnumerable<int2> Corners(RampTiler.HeightMap heightMap, CPos cell)
		{
			var xy = heightMap.CPosToXy(cell);
			yield return xy;
			yield return xy + new int2(1, 0);
			yield return xy + new int2(0, 1);
			yield return xy + new int2(1, 1);
		}

		static readonly CVec[] Neighbours8 =
		[
			new(-1, -1), new(0, -1), new(1, -1), new(-1, 0), new(1, 0), new(-1, 1), new(0, 1), new(1, 1),
		];
	}
}
