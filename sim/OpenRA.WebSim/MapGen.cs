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
using OpenRA.FileSystem;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Support;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Random maps from the engine's own map generator (the mod's TSMapGenerator@rtsai, rules/map-generators.yaml), made
	/// where the game runs: in the browser, nothing is uploaded or fetched. The page mounts the returned files under
	/// web/content/maps/&lt;id&gt;/, where SimHost.MapPath finds them before the MapCache.
	/// </summary>
	public static class MapGen
	{
		public const string Generator = "rtsai";

		/// <summary>Every option the generator declares, with the value a player gets unless they choose otherwise.</summary>
		static readonly Dictionary<string, string> Defaults = new()
		{
			["hidden_defaults"] = "hidden_defaults",
			["hidden_tileset_overrides"] = "temperat",
			["TerrainType"] = "Lakes",
			["Players"] = "2",
			["Symmetry"] = "2Rotations",
			["Resources"] = "Medium",
			["Buildings"] = "None",
			["Density"] = "Players",
			["Coastlines"] = "Beaches",
		};

		/// <summary>The generator's landscapes (TerrainType choices), what players see, and how often "random" picks each.</summary>
		static readonly (string Choice, string Name, int Weight)[] Landscapes =
		[
			("Lakes", "Lakes", 3),
			("Puddles", "Ponds", 2),
			("Plains", "Plains", 2),
			("Parks", "Parkland", 2),
			("Woodlands", "Woodlands", 2),
			("Rocky", "Rocky hills", 2),
			("MountainLakes", "Mountain lakes", 1),
			("Mountains", "Mountains", 1),
			("Flat", "Open ground", 0),
		];

		/// <summary>How many seeds to try before giving up: some layouts leave no room for every start position.</summary>
		const int Attempts = 8;

		/// <summary>
		/// Generates a map. `json`: {"seed": int, "size": int (cells a side; default by players), "players": int,
		/// "terrain": a TerrainType choice or "random", "resources": "Low" | "Medium" | "High"}; anything left out takes
		/// the default. When a seed's layout cannot fit everything, the next seeds are tried.
		/// Returns {"id", "title", "landscape", "players", "size", "seed", "ms", "files": {name: base64}} or {"error"}.
		/// </summary>
		public static string Generate(string json)
		{
			var start = System.Diagnostics.Stopwatch.GetTimestamp();
			try
			{
				using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
				var req = doc.RootElement;
				int Int(string name, int fallback) => req.TryGetProperty(name, out var v) && v.TryGetInt32(out var i) ? i : fallback;
				string Str(string name) => req.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

				var seed = Int("seed", Environment.TickCount & int.MaxValue);
				var players = Math.Clamp(Int("players", 2), 1, 8);
				var size = Math.Clamp(Int("size", players <= 2 ? 96 : players <= 4 ? 128 : 160), 48, 192);

				// "random" picks a landscape from the seed, so the same request always makes the same map.
				var terrain = Str("terrain") ?? Defaults["TerrainType"];
				if (terrain == "random")
				{
					var roll = new MersenneTwister(seed).Next(Landscapes.Sum(l => l.Weight));
					terrain = Landscapes.First(l => (roll -= l.Weight) < 0).Choice;
				}

				var landscape = Landscapes.FirstOrDefault(l => l.Choice == terrain).Name
					?? throw new InvalidOperationException($"Unknown landscape {terrain}.");

				var modData = SimHost.ModData;
				var info = modData.DefaultRules.Actors[SystemActors.EditorWorld].TraitInfos<MapGeneratorBaseInfo>()
					.FirstOrDefault(g => g.Type == Generator)
					?? throw new InvalidOperationException("This build has no map generator.");

				Map map = null;
				MapGenerationException last = null;
				for (var attempt = 0; attempt < Attempts && map == null; attempt++)
				{
					var options = new Dictionary<string, string>(Defaults)
					{
						["Seed"] = (seed + attempt).ToString(CultureInfo.InvariantCulture),
						["Players"] = players.ToString(CultureInfo.InvariantCulture),
						["TerrainType"] = terrain,
					};
					if (Str("resources") is string resources) options["Resources"] = resources;

					// Mirror symmetry and two-fold rotation only work for an even number of players.
					if (players % 2 == 1)
						options["Symmetry"] = "None";

					var args = new MapGenerationArgs
					{
						Generator = info.Type,
						Tileset = "TEMPERATE",
						Size = new Size(size, size),
						Title = $"{landscape} {(seed + attempt) % 10000:D4}",
						Author = "RTS AI map generator",
						Options = options,
					};

					if (!info.ValidateArgs(modData, args))
						throw new InvalidOperationException("These map settings are not valid.");

					try
					{
						map = info.Generate(modData, args);
						seed += attempt;
					}
					catch (MapGenerationException e)
					{
						// "Not enough room for player spawns", an unfixable heightmap: the next seed lays the land out anew.
						last = e;
					}
				}

				if (map == null)
					throw last;

				// A map's uid hashes its preview, whose terrain colours come from Game.CosmeticRandom. Drawn from the seed, the
				// same request gives the same uid in every browser, so multiplayer guests can make the host's map themselves.
				using var package = new ZipFileLoader.ReadWriteZipFile();
				var cosmetic = Game.CosmeticRandom;
				Game.CosmeticRandom = new MersenneTwister(seed);
				try
				{
					map.Save(package);
				}
				finally
				{
					Game.CosmeticRandom = cosmetic;
				}

				var id = "gen-" + map.Uid[..16].ToLowerInvariant();
				var files = new StringBuilder();
				foreach (var name in package.Contents)
				{
					using var s = package.GetStream(name);
					files.Append(files.Length == 0 ? "" : ",").Append(Snapshot.Json(name)).Append(':')
						.Append(Snapshot.Json(Convert.ToBase64String(s.ReadAllBytes())));
				}

				var ms = System.Diagnostics.Stopwatch.GetElapsedTime(start).TotalMilliseconds;
				var playable = new MapPlayers(map.PlayerDefinitions).Players.Values.Count(p => p.Playable);
				return $"{{\"id\":{Snapshot.Json(id)},\"title\":{Snapshot.Json(map.Title)},\"landscape\":{Snapshot.Json(landscape)}," +
					$"\"players\":{playable},\"size\":{size},\"seed\":{seed},\"ms\":{ms.ToString("F0", CultureInfo.InvariantCulture)},\"files\":{{{files}}}}}";
			}
			catch (Exception e) when (e is MapGenerationException || e is InvalidOperationException || e is JsonException || e is YamlException)
			{
				Log.Write("debug", "Map generation failed: " + e);
				return $"{{\"error\":{Snapshot.Json(e is MapGenerationException ? "Couldn't fit a map for this many players. Try again." : e.Message)}}}";
			}
		}
	}
}
