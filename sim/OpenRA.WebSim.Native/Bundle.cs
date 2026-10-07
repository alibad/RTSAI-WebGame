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
using System.IO;
using System.Linq;
using System.Text;
using OpenRA;
using OpenRA.WebSim;

/// <summary>
/// Builds web-bundle.pack: the engine's mods/common and the RTS AI mod's data with a web mod.yaml.
/// Contains only project and OpenRA (GPL) files. EA content never enters this bundle; it is mounted privately.
/// </summary>
static class Bundle
{
	static readonly HashSet<string> SkippedExtensions = new(StringComparer.OrdinalIgnoreCase)
	{
		// Audio goes into web-audio.pack (mounted lazily, fetched by byte range when first played); video is unused.
		".wav", ".aud", ".ogg", ".mp3", ".vqa", ".bik", ".md", ".pyc",
	};

	static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase) { ".wav", ".aud", ".ogg", ".mp3" };

	public static int Build(Dictionary<string, string> opts)
	{
		var engine = opts["engine"];
		var modRoot = opts["mod"];
		var output = opts["out"];
		var modDir = Path.Combine(modRoot, "mods", "rtsai");

		// Every map the mod ships (5 MB in all) unless --maps lists some.
		var maps = (opts.TryGetValue("maps", out var m) ? m.Split(',', StringSplitOptions.RemoveEmptyEntries)
			: Directory.GetDirectories(Path.Combine(modDir, "maps")).Select(Path.GetFileName)).ToHashSet();

		Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
		long total = 0;
		var count = 0;
		// Written to a temporary file and moved into place, so a concurrent or interrupted run never leaves a torn pack.
		using (var fs = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			void Add(string name, byte[] data)
			{
				pack.Add(name, data);
				total += data.Length;
				count++;
			}

			Add("ora/VERSION", File.ReadAllBytes(Path.Combine(engine, "VERSION")));

			// XCC filename database shipped with OpenRA: lets MixFile resolve names inside the player's .mix packages.
			Add("ora/global mix database.dat", File.ReadAllBytes(Path.Combine(engine, "global mix database.dat")));
			foreach (var f in Files(Path.Combine(engine, "glsl")))
				Add("ora/glsl/" + Rel(Path.Combine(engine, "glsl"), f), File.ReadAllBytes(f));
			foreach (var f in Files(Path.Combine(engine, "mods", "common")))
				Add("ora/mods/common/" + Rel(Path.Combine(engine, "mods", "common"), f), File.ReadAllBytes(f));

			foreach (var f in Files(modDir))
			{
				var rel = Rel(modDir, f);
				if (rel == "mod.yaml")
					continue;

				if (rel.StartsWith("maps/", StringComparison.Ordinal) && !maps.Contains(rel.Split('/')[1]))
					continue;

				Add("mods/rtsai/" + rel, File.ReadAllBytes(f));
			}

			Add("mods/rtsai/mod.yaml", Encoding.UTF8.GetBytes(WebModYaml(File.ReadAllText(Path.Combine(modDir, "mod.yaml")))));
			Add("mods/rtsai/web/web-rules.yaml", Encoding.UTF8.GetBytes(WebRules));
			Add("mods/rtsai/web/web-names.ftl", Encoding.UTF8.GetBytes(WebNames));

			var blank = Path.Combine(modDir, "maps", "blank-shellmap");
			Add("mods/rtsai/maps/web-arena/map.bin", File.ReadAllBytes(Path.Combine(blank, "map.bin")));
			Add("mods/rtsai/maps/web-arena/map.yaml", Encoding.UTF8.GetBytes(ArenaYaml()));
		}

		File.Move(output + ".tmp", output, true);
		Console.WriteLine($"{output}: {count} files, {total / 1048576.0:F1} MB raw, {new FileInfo(output).Length / 1048576.0:F1} MB pack");

		// The mod's own (licensed) audio: a separate pack plus a JSON index of byte offsets for lazy range reads.
		var audioOut = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(output)), "web-audio.pack");
		var index = new StringBuilder("{\"files\":[");
		var audioCount = 0;
		long audioTotal = 0;
		using (var fs = File.Create(audioOut + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			foreach (var f in Directory.EnumerateFiles(modDir, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
			{
				if (!AudioExtensions.Contains(Path.GetExtension(f)) || f.Contains(Path.DirectorySeparatorChar + ".", StringComparison.Ordinal))
					continue;

				var rel = "mods/rtsai/" + Rel(modDir, f);
				var data = File.ReadAllBytes(f);
				var offset = fs.Position + 2 + Encoding.UTF8.GetByteCount(rel) + 4;
				pack.Add(rel, data);
				if (audioCount++ > 0)
					index.Append(',');
				index.Append($"{{\"path\":\"{rel}\",\"offset\":{offset},\"size\":{data.Length}}}");
				audioTotal += data.Length;
			}
		}

		index.Append("]}");
		File.WriteAllText(Path.ChangeExtension(audioOut, ".json.tmp"), index.ToString());
		File.Move(audioOut + ".tmp", audioOut, true);
		File.Move(Path.ChangeExtension(audioOut, ".json.tmp"), Path.ChangeExtension(audioOut, ".json"), true);
		Console.WriteLine($"{audioOut}: {audioCount} files, {audioTotal / 1048576.0:F1} MB (mounted lazily)");
		return 0;
	}

	static IEnumerable<string> Files(string dir)
	{
		return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
			.Where(f => !SkippedExtensions.Contains(Path.GetExtension(f)))
			.Where(f => !f.Contains(Path.DirectorySeparatorChar + ".", StringComparison.Ordinal))
			.OrderBy(f => f, StringComparer.Ordinal);
	}

	static string Rel(string root, string f) => Path.GetRelativePath(root, f).Replace('\\', '/');

	/// <summary>
	/// The web mod.yaml: identical to the mod's except that the AI companion (a gRPC sidecar) is left out and a
	/// small overlay adds what the embedded host needs. Everything that affects the simulation is unchanged.
	/// </summary>
	static string WebModYaml(string yaml)
	{
		yaml = yaml.Replace("\r\n", "\n");
		yaml = yaml.Replace("\tra2|rules/companion.yaml\n", "");

		// The host's no-op load screen lives in OpenRA.WebSim (the mod's own one starts the companion sidecar).
		yaml = yaml.Replace("LoadScreen: RTSAILoadScreen", "LoadScreen: WebLoadScreen");
		var assemblies = yaml.IndexOf("\nAssemblies:", StringComparison.Ordinal);
		var assembliesEnd = yaml.IndexOf('\n', assemblies + 1);
		yaml = yaml.Insert(assembliesEnd, ", OpenRA.WebSim.dll");

		// Append the overlay as the last Rules entry.
		var rules = yaml.IndexOf("\nRules:\n", StringComparison.Ordinal);
		var end = yaml.IndexOf("\n\n", rules + 1, StringComparison.Ordinal);
		yaml = yaml.Insert(end + 1, "\tra2|web/web-rules.yaml\n");

		// Player-facing names (the standalone's), loaded last so they override the RA2 preview strings.
		var fluent = yaml.IndexOf("\nFluentMessages:\n", StringComparison.Ordinal);
		if (fluent >= 0)
		{
			var fluentEnd = yaml.IndexOf("\n\n", fluent + 1, StringComparison.Ordinal);
			yaml = yaml.Insert(fluentEnd + 1, "\tra2|web/web-names.ftl\n");
		}

		return yaml;
	}

	// UI text only (bot names as the standalone build shows them).
	const string WebNames =
		"## Web build: player-facing names (RTSAI-WebGame Bundle.cs)\n" +
		"ra2-bot-normal = Normal AI\n" +
		"ra2-bot-medium = Medium AI\n" +
		"ra2-bot-rush = Rush AI\n" +
		"ra2-bot-turtle = Turtle AI\n" +
		"ra2-bot-naval = Naval AI\n";

	// UI-only and lobby-only changes; nothing here alters unit, weapon or economy rules.
	const string WebRules =
		"# Web build overlay (RTSAI-WebGame). The page draws the UI in HTML, so the in-game widget root is not loaded.\n" +
		"World:\n" +
		"\t-LoadWidgetAtGameStart:\n" +
		"\n" +
		"# A bot seat that issues no orders: the enemy side of scripted battles and fidelity runs.\n" +
		"Player:\n" +
		"\tModularBot@webidle:\n" +
		"\t\tName: web-idle\n" +
		"\t\tType: webidle\n";

	/// <summary>Two-seat arena on the flat blank map: no starting units or crates, units come from the scenario.</summary>
	static string ArenaYaml()
	{
		var west = new MPos(30, 72).ToCPos(MapGridType.RectangularIsometric);
		var east = new MPos(98, 72).ToCPos(MapGridType.RectangularIsometric);
		return string.Join("\n",
			"MapFormat: 11",
			"",
			"RequiresMod: ra2",
			"",
			"Title: Web Arena",
			"",
			"Author: RTSAI-WebGame",
			"",
			"Tileset: TEMPERATE",
			"",
			"MapSize: 130,146",
			"",
			"Bounds: 1,1,128,144",
			"",
			"Visibility: Lobby",
			"",
			"Categories: Conquest",
			"",
			"Players:",
			"\tPlayerReference@Neutral:",
			"\t\tName: Neutral",
			"\t\tOwnsWorld: True",
			"\t\tNonCombatant: True",
			"\t\tFaction: Random",
			"\tPlayerReference@Creeps:",
			"\t\tName: Creeps",
			"\t\tNonCombatant: True",
			"\t\tFaction: Random",
			"\tPlayerReference@Multi0:",
			"\t\tName: Multi0",
			"\t\tPlayable: True",
			"\t\tFaction: Random",
			"\t\tEnemies: Creeps",
			"\tPlayerReference@Multi1:",
			"\t\tName: Multi1",
			"\t\tPlayable: True",
			"\t\tFaction: Random",
			"\t\tEnemies: Creeps",
			"",
			"Actors:",
			"\tActor0: mpspawn",
			$"\t\tLocation: {west.X},{west.Y}",
			"\t\tOwner: Neutral",
			"\tActor1: mpspawn",
			$"\t\tLocation: {east.X},{east.Y}",
			"\t\tOwner: Neutral",
			"",
			"Rules:",
			"\tWorld:",
			"\t\t-StartGameNotification:",
			"\t\t-SpawnStartingUnits:",
			"\t\t-CrateSpawner:",
			"",
			"");
	}
}
