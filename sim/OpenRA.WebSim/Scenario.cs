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

using System.Collections.Generic;
using System.Text.Json;

namespace OpenRA.WebSim
{
	public sealed class PlayerSpec
	{
		public string Slot;
		public string Faction = "Random";
		public string Bot;
		public string Color = "E04444";
		public int Team;
		public int SpawnPoint;
	}

	public sealed class SpawnSpec
	{
		public string Type;
		public int Player;
		public int X, Y;
		public int Facing = 512;
	}

	/// <summary>
	/// Everything that defines a match: map, seed, lobby, starting actors and an optional scripted opening.
	/// The same JSON is fed to the browser and to the native runner.
	/// </summary>
	public sealed class ScenarioSpec
	{
		public string Map;
		public int Seed = 1;
		public List<PlayerSpec> Players = [];
		public Dictionary<string, string> Options = [];
		public List<SpawnSpec> Spawns = [];

		/// <summary>"battle": on tick 1 every spawned unit attack-moves to the enemy group's centre.</summary>
		public string Script;

		public static ScenarioSpec Parse(string json)
		{
			using var doc = JsonDocument.Parse(json);
			var root = doc.RootElement;
			var s = new ScenarioSpec
			{
				Map = Str(root, "map", null),
				Seed = Int(root, "seed", 1),
				Script = Str(root, "script", null),
			};

			if (root.TryGetProperty("players", out var players))
			{
				foreach (var p in players.EnumerateArray())
				{
					s.Players.Add(new PlayerSpec
					{
						Slot = Str(p, "slot", null),
						Faction = Str(p, "faction", "Random"),
						Bot = Str(p, "bot", null),
						Color = Str(p, "color", "E04444"),
						Team = Int(p, "team", 0),
						SpawnPoint = Int(p, "spawn", 0),
					});
				}
			}

			if (root.TryGetProperty("options", out var options))
				foreach (var o in options.EnumerateObject())
					s.Options[o.Name] = o.Value.ValueKind == JsonValueKind.String ? o.Value.GetString() : o.Value.GetRawText();

			if (root.TryGetProperty("spawns", out var spawns))
			{
				foreach (var a in spawns.EnumerateArray())
				{
					var type = Str(a, "type", null);
					var player = Int(a, "player", 0);
					var facing = Int(a, "facing", 512);
					var count = Int(a, "count", 1);
					var x = Int(a, "x", 0);
					var y = Int(a, "y", 0);
					var columns = Int(a, "columns", 1);
					var spacing = Int(a, "spacing", 1);

					// "count" lays a block of identical actors out in a grid starting at (x, y).
					for (var i = 0; i < count; i++)
					{
						s.Spawns.Add(new SpawnSpec
						{
							Type = type,
							Player = player,
							Facing = facing,
							X = x + i % columns * spacing,
							Y = y + i / columns * spacing,
						});
					}
				}
			}

			return s;
		}

		static string Str(JsonElement e, string name, string def)
		{
			return e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : def;
		}

		static int Int(JsonElement e, string name, int def)
		{
			return e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;
		}
	}
}
