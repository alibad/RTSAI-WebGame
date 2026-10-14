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
		public int Client;
		public string Slot;
		public string Faction = "Random";
		public string Bot;
		public string Doctrine;
		public string Color = "E04444";
		public int Team;
		public int SpawnPoint;

		/// <summary>Handicap percent (0-95): the mod's handicap multipliers weaken the player's firepower, armour and production.</summary>
		public int Handicap;

		/// <summary>Credits given on top of the lobby's starting cash (the simulator's AI skill levels).</summary>
		public int Cash;
	}

	public sealed class SpawnSpec
	{
		public string Type;
		public int Player;
		public int X, Y;
		public int Facing = 512;

		/// <summary>Veterancy levels given at spawn (GainsExperience.GiveLevels).</summary>
		public int Level;

		/// <summary>Health percent at spawn (HealthInit).</summary>
		public int Health = 100;

		/// <summary>Opening order on tick 1: "engage" (attack-move to the enemy centre), "hold" (Defend stance), "move".</summary>
		public string Order;
		public int DestX = -1, DestY = -1;
		public bool Deploy;
	}

	/// <summary>
	/// Everything that defines a match: map, seed, lobby, starting actors and an optional scripted opening.
	/// The same JSON is fed to the browser and to the native runner.
	/// </summary>
	public sealed class ScenarioSpec
	{
		public int LocalClient = 1;
		public bool Multiplayer;
		public string Map;
		public string Mission;
		public int Seed = 1;
		public List<PlayerSpec> Players = [];
		public Dictionary<string, string> Options = [];
		public List<SpawnSpec> Spawns = [];

		/// <summary>"battle": on tick 1 every spawned unit attack-moves to the enemy group's centre.</summary>
		public string Script;

		public int DefaultLevel;
		public int DefaultHealth = 100;
		public string DefaultOrder;

		/// <summary>A battle-sandbox run: track the results readout (shots, damage, kills, survivors).</summary>
		public bool Sandbox;

		/// <summary>No starting units: the map's start positions stay empty and only the scenario's spawns exist (the simulator on any map).</summary>
		public bool Bare;
		public string Objective;
		public int Duration = 120;

		public static ScenarioSpec Parse(string json)
		{
			using var doc = JsonDocument.Parse(json);
			var root = doc.RootElement;
			var s = new ScenarioSpec
			{
				Map = Str(root, "map", null),
				Mission = Str(root, "mission", null),
				Objective = Str(root, "objective", null),
				Duration = System.Math.Clamp(Int(root, "duration", 120), 30, 600),
				LocalClient = Int(root, "localClient", 1),
				Multiplayer = root.TryGetProperty("multiplayer", out var mp) && mp.ValueKind == JsonValueKind.True,
				Seed = Int(root, "seed", 1),
				Script = Str(root, "script", null),
				DefaultLevel = Int(root, "level", 0),
				DefaultHealth = Int(root, "health", 100),
				DefaultOrder = Str(root, "order", null),
				Sandbox = root.TryGetProperty("sandbox", out var sbx) && sbx.ValueKind == JsonValueKind.True,
				Bare = root.TryGetProperty("bare", out var bare) && bare.ValueKind == JsonValueKind.True,
			};

			if (root.TryGetProperty("players", out var players))
			{
				foreach (var p in players.EnumerateArray())
				{
					s.Players.Add(new PlayerSpec
					{
						Slot = Str(p, "slot", null),
						Client = Int(p, "client", 1),
						Faction = Str(p, "faction", "Random"),
						Bot = Str(p, "bot", null),
						Doctrine = Str(p, "doctrine", null),
						Color = Str(p, "color", "E04444"),
						Team = Int(p, "team", 0),
						SpawnPoint = Int(p, "spawn", 0),
						Handicap = System.Math.Clamp(Int(p, "handicap", 0), 0, 95),
						Cash = System.Math.Max(0, Int(p, "cash", 0)),
					});
				}
			}

			if (root.TryGetProperty("options", out var options))
				foreach (var o in options.EnumerateObject())
					s.Options[o.Name] = o.Value.ValueKind == JsonValueKind.String ? o.Value.GetString() : o.Value.GetRawText();

			if (root.TryGetProperty("spawns", out var spawns) || root.TryGetProperty("placements", out spawns))
			{
				foreach (var a in spawns.EnumerateArray())
				{
					// Field names of the web sandbox and of the Studio's DuelPlacement are both accepted
					// (type/id, player/side, x/u, y/v, destination {u, v}).
					var type = Str(a, "type", null) ?? Str(a, "id", null);
					var player = Int(a, "player", Int(a, "side", 0));
					var facing = Int(a, "facing", 512);
					var count = Int(a, "count", 1);
					var x = Int(a, "x", Int(a, "u", 0));
					var y = Int(a, "y", Int(a, "v", 0));
					var columns = Int(a, "columns", 1);
					var spacing = Int(a, "spacing", 1);
					int dx = -1, dy = -1;
					if (a.TryGetProperty("destination", out var d) && d.ValueKind == JsonValueKind.Object)
					{
						dx = Int(d, "u", Int(d, "x", -1));
						dy = Int(d, "v", Int(d, "y", -1));
					}

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
							Level = Int(a, "level", s.DefaultLevel),
							Health = Int(a, "health", s.DefaultHealth),
							Order = Str(a, "order", s.DefaultOrder),
							DestX = dx,
							DestY = dy,
							Deploy = a.TryGetProperty("deploy", out var dep) && dep.ValueKind == JsonValueKind.True,
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
