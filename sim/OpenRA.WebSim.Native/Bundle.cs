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
/// Contains project and OpenRA (GPL) files. With --ea (public isometric only) it also carries original Westwood art for
/// the nine original countries, under EA's free, non-commercial C&amp;C modding guidelines ("EA has not endorsed and
/// does not support this product."): only the art files listed and hashed in the directory's EA-INPUTS.json, only
/// .shp/.vxl/.hva/.pal, under mods/rtsai/web/ea/ with ea-content.json beside them. When the generated content plays
/// original unit voices (content/ea-audio.json, tools/ea_voices.py), exactly those clips, listed and hashed under
/// "audio" in EA-INPUTS.json, go into web-audio.pack under mods/rtsai/web/ea/audio/ (fetched when first played): short
/// .wav clips only, never archives, music (theme.mix or any score) or video.
/// The private RA2 content of the local profile still never enters a bundle; it is mounted privately.
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

	/// <summary>The only original (EA) files the core bundle may carry: art. Original voice and sound clips go to
	/// web-audio.pack (<see cref="OriginalAudio"/>); never archives (.mix/.bag/.idx), music or video.</summary>
	public static readonly HashSet<string> OriginalArtExtensions = new(StringComparer.OrdinalIgnoreCase) { ".shp", ".vxl", ".hva", ".pal" };
	public const string OriginalArtDir = "mods/rtsai/web/ea/";
	public const string OriginalArtNotice = "EA has not endorsed and does not support this product.";

	/// <summary>Original unit voice and sound clips (RA2's audio.idx names, .wav, never EVA), read when first played.</summary>
	public const string OriginalAudioDir = OriginalArtDir + "audio/";
	public static readonly System.Text.RegularExpressions.Regex OriginalClipName = new(@"^(?!ceva)[a-z0-9][a-z0-9_-]{0,15}\.wav$");

	/// <summary>A voice or sound clip is short; anything larger would be music or speech the build must not carry.</summary>
	public const int OriginalClipMaxBytes = 512 * 1024;

	public static int Build(Dictionary<string, string> opts)
	{
		var engine = opts["engine"];
		var modRoot = opts["mod"];
		var output = opts["out"];
		var modDir = Path.Combine(modRoot, "mods", "rtsai");
		var classic = opts.TryGetValue("game-mode", out var gameMode) && gameMode == "classic";
		if (gameMode != null && gameMode is not ("classic" or "isometric")) throw new ArgumentException("Unsupported game mode");
		if (classic && opts.ContainsKey("ea"))
			throw new ArgumentException("Original art is isometric only; Classic/top-down keeps the stand-ins");
		var modId = classic ? "rtsai-topdown" : "rtsai";
		var primaryDir = Path.Combine(modRoot, "mods", modId);

		// Every map the mod ships (5 MB in all) unless --maps lists some.
		var maps = (opts.TryGetValue("maps", out var m) ? m.Split(',', StringSplitOptions.RemoveEmptyEntries)
			: Directory.GetDirectories(Path.Combine(primaryDir, "maps")).Select(Path.GetFileName)).ToHashSet();

		Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
		var lazyArt = !opts.ContainsKey("no-lazy-art");
		var art = new List<(string Path, string File)>();
		var originals = opts.TryGetValue("ea", out var eaDir) ? OriginalArt(eaDir, opts.TryGetValue("content", out var eaContent) ? eaContent : "content") : null;
		var originalAudio = originals != null ? OriginalAudio(eaDir, opts.TryGetValue("content", out var audioContent) ? audioContent : "content") : null;
		// The cursor art stays in the core bundle: the page draws the mod's cursors from the start of every game, and a
		// host may serve web-art.pack late or not at all (it is a fallback for sprites the prebaked sheets lack).
		var keepInCore = CursorSources(modDir);
		long total = 0;
		var count = 0;
		using var contentHash = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
		// Written to a temporary file and moved into place, so a concurrent or interrupted run never leaves a torn pack.
		using (var fs = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			void Add(string name, byte[] data)
			{
				// The web hosts draw no text in the engine (the page does; WebPlatform.CreateFont ignores the data), so
				// fonts ship as empty files: the engine still finds every font it loads.
				if (name.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".otf", StringComparison.OrdinalIgnoreCase))
					data = [];

				contentHash.AppendData(Encoding.UTF8.GetBytes($"{name}|{data.Length}|"));
				contentHash.AppendData(data);
				pack.Add(name, data);
				total += data.Length;
				count++;
			}

			Add("ora/MOD_ID", Encoding.UTF8.GetBytes(modId));
			Add("ora/VERSION", File.ReadAllBytes(Path.Combine(engine, "VERSION")));

			// XCC filename database shipped with OpenRA: lets MixFile resolve names inside the player's .mix packages.
			if (!opts.ContainsKey("no-mix-database"))
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
				if (lazyArt && !rel.Contains("maps/", StringComparison.Ordinal) && ArtExtensions.Contains(Path.GetExtension(f)) && bytes.Length >= LazyArtMinBytes
					&& !keepInCore.Contains(rel))
				{
					// Part of the bundle's identity (sprites baked from it depend on it), stored in web-art.pack.
					contentHash.AppendData(Encoding.UTF8.GetBytes($"mods/rtsai/{rel}|{bytes.Length}|"));
					contentHash.AppendData(bytes);
					art.Add(("mods/rtsai/" + rel, f));
					continue;
				}

				Add("mods/rtsai/" + rel, bytes);
			}

			var publicProfile = File.Exists(Path.Combine(modDir, "standalone", "base-kit.yaml"));
			var content = opts.TryGetValue("content", out var contentPath) ? contentPath : "content";
			if (publicProfile && Directory.Exists(content))
				foreach (var f in Files(content))
					Add("mods/rtsai/web/content/" + Rel(content, f), File.ReadAllBytes(f));
			if (originals != null)
			{
				if (!publicProfile || !Directory.Exists(content))
					throw new ArgumentException("Original art needs the public profile and its generated content");

				// Large sprites are read by byte range (web-art.pack) like the mod's own; voxels, palettes and small
				// sprites (all needed while a world loads) stay in the core bundle. All of it is the bundle's identity.
				foreach (var (name, file, _, _) in originals)
				{
					var bytes = File.ReadAllBytes(file);
					var path = OriginalArtDir + name;
					if (lazyArt && Path.GetExtension(name).Equals(".shp", StringComparison.OrdinalIgnoreCase) && bytes.Length >= LazyArtMinBytes)
					{
						contentHash.AppendData(Encoding.UTF8.GetBytes($"{path}|{bytes.Length}|"));
						contentHash.AppendData(bytes);
						art.Add((path, file));
					}
					else
						Add(path, bytes);
				}

				// The record is part of the bundle's identity, so the original clips (in web-audio.pack) are too.
				var record = System.Text.Json.JsonSerializer.Serialize(new
				{
					notice = OriginalArtNotice,
					guidelines = "EA's C&C Franchise Modding Guidelines (free, non-commercial; no C&C music)",
					files = originals.Select(o => new { name = o.Name, sha256 = o.Sha256, source = o.Source }),
					audio = originalAudio?.Select(o => new { name = o.Name, sha256 = o.Sha256, source = o.Source }),
				}, new System.Text.Json.JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
				Add(OriginalArtDir + "ea-content.json", Encoding.UTF8.GetBytes(record));
				Console.WriteLine($"original art: {originals.Count} files ({originals.Sum(o => new FileInfo(o.File).Length) / 1048576.0:F1} MB)");
				if (originalAudio != null)
					Console.WriteLine($"original voices and sounds: {originalAudio.Count} clips ({originalAudio.Sum(o => new FileInfo(o.File).Length) / 1024.0:F0} KB, in web-audio.pack)");
			}

			Add("mods/rtsai/mod.yaml", Encoding.UTF8.GetBytes(WebModYaml(File.ReadAllText(Path.Combine(modDir, "mod.yaml")), !classic && publicProfile && Directory.Exists(content), false, originals != null, originalAudio != null)));
			if (classic)
			{
				foreach (var file in Files(primaryDir))
				{
					var rel = Rel(primaryDir, file);
					if (rel == "mod.yaml" || rel.StartsWith("maps/", StringComparison.Ordinal) && !maps.Contains(rel.Split('/')[1])) continue;
					Add("mods/rtsai-topdown/" + rel, File.ReadAllBytes(file));
				}
				Add("mods/rtsai-topdown/mod.yaml", Encoding.UTF8.GetBytes(WebModYaml(File.ReadAllText(Path.Combine(primaryDir, "mod.yaml")), Directory.Exists(content), true)));
			}
			Add("mods/rtsai/web/web-rules.yaml", Encoding.UTF8.GetBytes(WebRules));
			Add("mods/rtsai/web/web-names.ftl", Encoding.UTF8.GetBytes(WebNames));

			var blank = Path.Combine(primaryDir, "maps", classic ? "blank" : "blank-shellmap");
			Add($"mods/{modId}/maps/web-arena/map.bin", File.ReadAllBytes(Path.Combine(blank, "map.bin")));
			Add($"mods/{modId}/maps/web-arena/map.yaml", Encoding.UTF8.GetBytes(ArenaYaml(classic)));
			Add($"mods/{modId}/maps/web-arena-four/map.bin", File.ReadAllBytes(Path.Combine(blank, "map.bin")));
			Add($"mods/{modId}/maps/web-arena-four/map.yaml", Encoding.UTF8.GetBytes(FourSeatArenaYaml(classic)));

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
			.Where(f => AudioExtensions.Contains(Path.GetExtension(f)) && !HiddenWithin(modDir, f))
			.OrderBy(f => f, StringComparer.Ordinal)
			.Select(f => ("mods/rtsai/" + Rel(modDir, f), f));

		// The original countries' unit voices and the dog's barks and bite: exactly the clips the content plays.
		if (originalAudio != null)
			audio = audio.Concat(originalAudio.Select(o => (OriginalAudioDir + o.Name, o.File)));
		WriteLazyPack(Path.Combine(outDir, "web-audio.pack"), audio);
		WriteLazyPack(Path.Combine(outDir, "web-art.pack"), art);
		return 0;
	}

	/// <summary>
	/// The original art files of a verified directory (tools/prepare-ea-art.py): every file of its EA-INPUTS.json,
	/// allowlisted (.shp .vxl .hva .pal), hashed and present, and every file the generated content draws among them.
	/// </summary>
	static List<(string Name, string File, string Sha256, string Source)> OriginalArt(string dir, string content)
	{
		using var manifest = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "EA-INPUTS.json")));
		var result = new List<(string Name, string File, string Sha256, string Source)>();
		foreach (var f in manifest.RootElement.GetProperty("files").EnumerateArray())
		{
			var name = f.GetProperty("name").GetString();
			var sha = f.GetProperty("sha256").GetString();
			if (name.Contains('/') || name.Contains('\\') || name.StartsWith('.') || !OriginalArtExtensions.Contains(Path.GetExtension(name)))
				throw new InvalidDataException($"Original art {name}: only .shp, .vxl, .hva and .pal files may be bundled");

			var file = Path.Combine(dir, name);
			var actual = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
			if (actual != sha)
				throw new InvalidDataException($"Original art {name} differs from EA-INPUTS.json");

			result.Add((name, file, sha, f.GetProperty("source").GetString()));
		}

		using var drawn = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(content, "ea-files.json")));
		var names = result.Select(r => r.Name).ToHashSet(StringComparer.Ordinal);
		foreach (var f in drawn.RootElement.GetProperty("files").EnumerateArray())
			if (!names.Contains(f.GetString()))
				throw new InvalidDataException($"Generated content draws {f.GetString()}, which EA-INPUTS.json does not list");

		return result.OrderBy(r => r.Name, StringComparer.Ordinal).ToList();
	}

	/// <summary>
	/// The original voice and sound clips the generated content plays (content/ea-audio.json, tools/ea_voices.py), or null
	/// when it plays none (original art only). Every clip must be listed under "audio" in EA-INPUTS.json with its hash,
	/// be a short RIFF WAVE file with an allowlisted name, and be played: exactly the listed clips are bundled.
	/// </summary>
	static List<(string Name, string File, string Sha256, string Source)> OriginalAudio(string dir, string content)
	{
		var playedPath = Path.Combine(content, "ea-audio.json");
		if (!File.Exists(playedPath))
			return null;

		using var manifest = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "EA-INPUTS.json")));
		if (!manifest.RootElement.TryGetProperty("audio", out var audio))
			throw new InvalidDataException("The generated content plays original clips, but EA-INPUTS.json records none");

		var folder = audio.GetProperty("folder").GetString();
		if (folder != "audio")
			throw new InvalidDataException($"Original clips in an unexpected folder {folder}");

		var result = new List<(string Name, string File, string Sha256, string Source)>();
		foreach (var f in audio.GetProperty("files").EnumerateArray())
		{
			var name = f.GetProperty("name").GetString();
			var sha = f.GetProperty("sha256").GetString();
			if (name == null || !OriginalClipName.IsMatch(name))
				throw new InvalidDataException($"Original clip {name}: only unit voice and sound clips (.wav) may be bundled");

			var file = Path.Combine(dir, folder, name);
			var bytes = File.ReadAllBytes(file);
			if (bytes.Length > OriginalClipMaxBytes)
				throw new InvalidDataException($"Original clip {name}: {bytes.Length} bytes is not a voice or sound clip");

			if (bytes.Length < 12 || Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" || Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
				throw new InvalidDataException($"Original clip {name} is not a RIFF WAVE file");

			var actual = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
			if (actual != sha)
				throw new InvalidDataException($"Original clip {name} differs from EA-INPUTS.json");

			result.Add((name, file, sha, f.GetProperty("source").GetString()));
		}

		using var played = System.Text.Json.JsonDocument.Parse(File.ReadAllText(playedPath));
		var clips = played.RootElement.GetProperty("clips").EnumerateArray().Select(c => c.GetString()).ToHashSet(StringComparer.Ordinal);
		var listed = result.Select(r => r.Name).ToHashSet(StringComparer.Ordinal);
		foreach (var c in clips.Where(c => !listed.Contains(c)))
			throw new InvalidDataException($"Generated content plays {c}, which EA-INPUTS.json does not list");

		foreach (var c in listed.Where(c => !clips.Contains(c)))
			throw new InvalidDataException($"EA-INPUTS.json lists {c}, which the generated content never plays");

		return result.OrderBy(r => r.Name, StringComparer.Ordinal).ToList();
	}

	/// <summary>
	/// The mod's own cursor images (relative to the mod folder): the sources named in the cursor yaml files that mod.yaml
	/// lists under Cursors ("ra2|standalone/art/cursors.png: mouse"); "ra2|" is this mod's folder.
	/// </summary>
	static HashSet<string> CursorSources(string modDir)
	{
		var result = new HashSet<string>(StringComparer.Ordinal);
		var lines = File.ReadAllLines(Path.Combine(modDir, "mod.yaml"));
		var inCursors = false;
		foreach (var line in lines)
		{
			if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
			{
				inCursors = line.TrimEnd() == "Cursors:";
				continue;
			}

			var yaml = line.Trim();
			if (!inCursors || yaml.Length == 0 || yaml.StartsWith('#') || !yaml.StartsWith("ra2|", StringComparison.Ordinal))
				continue;

			var file = Path.Combine(modDir, yaml["ra2|".Length..]);
			if (!File.Exists(file))
				continue;

			foreach (var c in File.ReadAllLines(file))
			{
				// One tab in: "<package>|<path>: <palette>" (a cursor image and its palette).
				if (!c.StartsWith('\t') || c.StartsWith("\t\t", StringComparison.Ordinal))
					continue;

				var src = c.Trim().Split(':')[0].Trim();
				if (src.StartsWith("ra2|", StringComparison.Ordinal))
					result.Add(src["ra2|".Length..]);
			}
		}

		return result;
	}

	/// <summary>A pack read by byte range (never downloaded whole), with a JSON index of each file's offset.</summary>
	static void WriteLazyPack(string output, IEnumerable<(string Path, string File)> files)
	{
		var index = new StringBuilder("{\"files\":[");
		var count = 0;
		long total = 0;
		using (var fs = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(fs))
		{
			foreach (var (rel, f) in files)
			{
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
			.Where(f => !Path.GetFileName(f).EndsWith("PROVENANCE.json", StringComparison.OrdinalIgnoreCase)) // asset records, not game data
			.Where(f => !HiddenWithin(dir, f))
			.OrderBy(f => f, StringComparer.Ordinal);
	}

	static string Rel(string root, string f) => Path.GetRelativePath(root, f).Replace('\\', '/');

	static bool HiddenWithin(string root, string file) => Rel(root, file).Split('/').Any(part => part.StartsWith(".", StringComparison.Ordinal));

	/// <summary>
	/// The web mod.yaml: identical to the mod's (the AI co-commander's CompanionBridge included; the page's host relays
	/// its RPCs) plus a small overlay for what the embedded host needs. Everything that affects the simulation is unchanged.
	/// </summary>
	static string WebModYaml(string yaml, bool expansion, bool classic = false, bool originals = false, bool originalAudio = false)
	{
		yaml = yaml.Replace("\r\n", "\n");

		// The host's no-op load screen lives in OpenRA.WebSim (the mod's own one starts the companion sidecar).
		yaml = yaml.Replace("LoadScreen: RTSAILoadScreen", "LoadScreen: WebLoadScreen");
		var assemblies = yaml.IndexOf("\nAssemblies:", StringComparison.Ordinal);
		var assembliesEnd = yaml.IndexOf('\n', assemblies + 1);
		yaml = yaml.Insert(assembliesEnd, ", OpenRA.WebSim.dll");

		// Append the overlay as the last Rules entry.
		var rules = yaml.IndexOf("\nRules:\n", StringComparison.Ordinal);
		var end = yaml.IndexOf("\n\n", rules + 1, StringComparison.Ordinal);
		yaml = yaml.Insert(end + 1, "\tra2|web/web-rules.yaml\n");
		if (expansion && classic)
		{
			var folders = yaml.IndexOf("\nMapFolders:\n", StringComparison.Ordinal);
			yaml = yaml.Insert(folders + "\nMapFolders:\n".Length, "\tra2|web/content/maps: System\n");
		}
		if (expansion && !classic)
		{
			yaml = yaml.Insert(end + 1, "\tra2|web/content/countries.yaml\n");
			var sequences = yaml.IndexOf("\nSequences:\n", StringComparison.Ordinal);
			var seqEnd = yaml.IndexOf("\n\n", sequences + 1, StringComparison.Ordinal);
			yaml = yaml.Insert(seqEnd + 1, "\tra2|web/content/country-sequences.yaml\n");
			var notifications = yaml.IndexOf("\nNotifications:\n", StringComparison.Ordinal);
			var notificationEnd = yaml.IndexOf("\n\n", notifications + 1, StringComparison.Ordinal);
			yaml = yaml.Insert(notificationEnd + 1, "\tra2|web/content/country-notifications.yaml\n");
			var folders = yaml.IndexOf("\nMapFolders:\n", StringComparison.Ordinal);
			yaml = yaml.Insert(folders + "\nMapFolders:\n".Length, "\tra2|web/content/maps: System\n");
		}

		// Original art for the original countries: at the very END of each section, after the mod's own campaigns/country*
		// files, so its FactionImages and render traits override the stand-ins those files assign.
		if (originals)
		{
			yaml = AppendToSection(yaml, "Rules", "ra2|web/content/ea-art.yaml");
			yaml = AppendToSection(yaml, "Sequences", "ra2|web/content/ea-sequences.yaml");
			yaml = AppendToSection(yaml, "ModelSequences", "ra2|web/content/ea-models.yaml");
		}

		// Original voices: the voice-only rules (after ea-art.yaml), the twin voice sets and the dog's bite Report.
		if (originalAudio)
		{
			yaml = AppendToSection(yaml, "Rules", "ra2|web/content/ea-audio.yaml");
			yaml = AppendToSection(yaml, "Voices", "ra2|web/content/ea-voices.yaml");
			yaml = AppendToSection(yaml, "Weapons", "ra2|web/content/ea-weapons.yaml");
		}

		// Player-facing names (the standalone's), loaded last so they override the RA2 preview strings.
		var fluent = yaml.IndexOf("\nFluentMessages:\n", StringComparison.Ordinal);
		if (fluent >= 0)
		{
			var fluentEnd = yaml.IndexOf("\n\n", fluent + 1, StringComparison.Ordinal);
			yaml = yaml.Insert(fluentEnd + 1, "\tra2|web/web-names.ftl\n");
		}

		return yaml;
	}

	/// <summary>Appends an entry after the last entry of a top-level manifest list (before the next top-level key).</summary>
	public static string AppendToSection(string yaml, string section, string entry)
	{
		var header = "\n" + section + ":\n";
		var start = yaml.IndexOf(header, StringComparison.Ordinal);
		if (start < 0)
			throw new InvalidDataException($"mod.yaml has no {section} section");

		var pos = start + header.Length;
		var end = pos;
		while (pos < yaml.Length)
		{
			var eol = yaml.IndexOf('\n', pos);
			if (eol < 0)
				eol = yaml.Length;

			var line = yaml[pos..eol];
			if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
				break;

			if (line.Trim().Length > 0)
				end = Math.Min(eol + 1, yaml.Length);

			pos = eol + 1;
		}

		return yaml.Insert(end, "\t" + entry + "\n");
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
		"# The map editor's world too: the page draws the editor (EditorHost drives the engine's brushes).\n" +
		"EditorWorld:\n" +
		"\t-LoadWidgetAtGameStart:\n" +
		"\n" +
		"# A bot seat that issues no orders: the enemy side of scripted battles and fidelity runs.\n" +
		"Player:\n" +
		"\tModularBot@webidle:\n" +
		"\t\tName: web-idle\n" +
		"\t\tType: webidle\n";

	/// <summary>Two-seat arena on the flat blank map: no starting units or crates, units come from the scenario.</summary>
	static string FourSeatArenaYaml(bool classic)
	{
		var grid = classic ? MapGridType.Rectangular : MapGridType.RectangularIsometric;
		var north = new MPos(classic ? 40 : 64, classic ? 20 : 30).ToCPos(grid);
		var south = new MPos(classic ? 40 : 64, classic ? 60 : 114).ToCPos(grid);
		var players = "\tPlayerReference@Multi2:\n\t\tName: Multi2\n\t\tPlayable: True\n\t\tFaction: Random\n\t\tEnemies: Creeps\n\tPlayerReference@Multi3:\n\t\tName: Multi3\n\t\tPlayable: True\n\t\tFaction: Random\n\t\tEnemies: Creeps\n";
		var actors = $"\tActor2: mpspawn\n\t\tLocation: {north.X},{north.Y}\n\t\tOwner: Neutral\n\tActor3: mpspawn\n\t\tLocation: {south.X},{south.Y}\n\t\tOwner: Neutral\n";
		return ArenaYaml(classic).Replace("Title: Web Arena", "Title: Web Arena Four").Replace("Actors:\n", players + "\nActors:\n").Replace("Rules:\n", actors + "\nRules:\n").Replace("\t\t-SpawnStartingUnits:\n", "");
	}

	static string ArenaYaml(bool classic)
	{
		var grid = classic ? MapGridType.Rectangular : MapGridType.RectangularIsometric;
		var west = new MPos(classic ? 20 : 30, classic ? 40 : 72).ToCPos(grid);
		var east = new MPos(classic ? 60 : 98, classic ? 40 : 72).ToCPos(grid);
		return string.Join("\n",
			"MapFormat: 11",
			"",
			classic ? "RequiresMod: rtsai-topdown" : "RequiresMod: ra2",
			"",
			"Title: Web Arena",
			"",
			"Author: RTSAI-WebGame",
			"",
			"Tileset: TEMPERATE",
			"",
			classic ? "MapSize: 80,80" : "MapSize: 130,146",
			"",
			classic ? "Bounds: 1,1,78,78" : "Bounds: 1,1,128,144",
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
