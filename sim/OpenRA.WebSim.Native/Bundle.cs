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

	// Sprite art read only while a map's sprites are decoded and packed: large files go to web-art.pack, read by
	// byte range on demand, so a visit that restores prebaked sheets never downloads them.
	static readonly HashSet<string> ArtExtensions = new(StringComparer.OrdinalIgnoreCase) { ".shp", ".png", ".tem", ".sno", ".urb" };
	const int LazyArtMinBytes = 32 * 1024;

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
		var lazyArt = !opts.ContainsKey("no-lazy-art");
		var art = new List<string>();
		long total = 0;
		var count = 0;
		using var contentHash = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
		// Written to a temporary file and moved into place, so a concurrent or interrupted run never leaves a torn pack.
		using (var fs = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			void Add(string name, byte[] data)
			{
				contentHash.AppendData(Encoding.UTF8.GetBytes($"{name}|{data.Length}|"));
				contentHash.AppendData(data);
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

				var bytes = File.ReadAllBytes(f);
				if (lazyArt && !rel.StartsWith("maps/", StringComparison.Ordinal) && ArtExtensions.Contains(Path.GetExtension(f)) && bytes.Length >= LazyArtMinBytes)
				{
					// Part of the bundle's identity (sprites baked from it depend on it), stored in web-art.pack.
					contentHash.AppendData(Encoding.UTF8.GetBytes($"mods/rtsai/{rel}|{bytes.Length}|"));
					contentHash.AppendData(bytes);
					art.Add(f);
					continue;
				}

				Add("mods/rtsai/" + rel, bytes);
			}

			Add("mods/rtsai/mod.yaml", Encoding.UTF8.GetBytes(WebModYaml(File.ReadAllText(Path.Combine(modDir, "mod.yaml")))));
			Add("mods/rtsai/web/web-rules.yaml", Encoding.UTF8.GetBytes(WebRules));
			Add("mods/rtsai/web/web-names.ftl", Encoding.UTF8.GetBytes(WebNames));

			var blank = Path.Combine(modDir, "maps", "blank-shellmap");
			Add("mods/rtsai/maps/web-arena/map.bin", File.ReadAllBytes(Path.Combine(blank, "map.bin")));
			Add("mods/rtsai/maps/web-arena/map.yaml", Encoding.UTF8.GetBytes(ArenaYaml()));

			// The bundle's identity (a hash of every file above): caches and prebaked sprites built from this content
			// are keyed by it, so repacking identical content keeps them and any change invalidates them.
			var id = Convert.ToHexString(contentHash.GetHashAndReset())[..20].ToLowerInvariant();
			pack.Add("ora/BUNDLE_ID", Encoding.UTF8.GetBytes(id));
			Console.WriteLine($"bundle id {id}");
		}

		File.Move(output + ".tmp", output, true);
		Console.WriteLine($"{output}: {count} files, {total / 1048576.0:F1} MB raw, {new FileInfo(output).Length / 1048576.0:F1} MB pack");

		var outDir = Path.GetDirectoryName(Path.GetFullPath(output));

		// The mod's own (licensed) audio: a separate pack plus a JSON index of byte offsets for lazy range reads.
		var audio = Directory.EnumerateFiles(modDir, "*", SearchOption.AllDirectories)
			.Where(f => AudioExtensions.Contains(Path.GetExtension(f)) && !f.Contains(Path.DirectorySeparatorChar + ".", StringComparison.Ordinal))
			.OrderBy(f => f, StringComparer.Ordinal);
		WriteLazyPack(Path.Combine(outDir, "web-audio.pack"), modDir, audio);
		WriteLazyPack(Path.Combine(outDir, "web-art.pack"), modDir, art);
		return 0;
	}

	/// <summary>A pack read by byte range (never downloaded whole), with a JSON index of each file's offset.</summary>
	static void WriteLazyPack(string output, string modDir, IEnumerable<string> files)
	{
		var index = new StringBuilder("{\"files\":[");
		var count = 0;
		long total = 0;
		using (var fs = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			foreach (var f in files)
			{
				var rel = "mods/rtsai/" + Rel(modDir, f);
				var data = File.ReadAllBytes(f);
				var offset = fs.Position + 2 + Encoding.UTF8.GetByteCount(rel) + 4;
				pack.Add(rel, data);
				if (count++ > 0)
					index.Append(',');
				index.Append($"{{\"path\":\"{rel}\",\"offset\":{offset},\"size\":{data.Length}}}");
				total += data.Length;
			}
		}

		index.Append("]}");
		var json = Path.ChangeExtension(output, ".json");
		File.WriteAllText(json + ".tmp", index.ToString());
		File.Move(output + ".tmp", output, true);
		File.Move(json + ".tmp", json, true);
		Console.WriteLine($"{output}: {count} files, {total / 1048576.0:F1} MB (mounted lazily)");
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
		"ra2-bot-naval = Naval AI\n" +
		"web-idle = Idle AI\n";

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
