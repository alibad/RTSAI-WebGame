using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using OpenRA.WebSim;

/// <summary>Export individual Classic assets and resolved web configuration; never publish installed archives.</summary>
static class ClassicAssets
{
	public static int Run(Dictionary<string, string> opts)
	{
		var output = Path.GetFullPath(opts["out"]);
		if (Directory.Exists(output)) throw new IOException("Choose a new Classic asset output directory");
		SimHost.Boot(opts["root"]);
		Directory.CreateDirectory(output);
		var art = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".shp", ".pal", ".tem", ".sno", ".des", ".int" };
		var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "allies.mix", "conquer.mix", "interior.mix", "lores.mix", "hires.mix", "local.mix", "russian.mix", "snow.mix", "sounds.mix", "temperat.mix", "expand2.mix", "lores1.mix", "hires1.mix", "desert.mix" };
		var files = new List<object>();
		var mounts = new List<object>();
		foreach (var package in ((OpenRA.FileSystem.FileSystem)SimHost.ModData.DefaultFileSystem).MountedPackages)
		{
			var source = Path.GetFileName(package.Name);
			if (!allowed.Contains(source)) continue;
			var folder = Path.GetFileNameWithoutExtension(source).ToLowerInvariant();
			mounts.Add(new { folder, alias = source.Equals("lores.mix", StringComparison.OrdinalIgnoreCase) ? "lores" : "" });
			foreach (var name in package.Contents.Order(StringComparer.Ordinal))
			{
				if (Path.GetFileName(name) != name) throw new InvalidDataException("Unexpected nested Classic asset: " + name);
				var ext = Path.GetExtension(name).ToLowerInvariant();
				if (!art.Contains(ext) && ext != ".aud") continue;
				using var stream = package.GetStream(name);
				using var memory = new MemoryStream(); stream.CopyTo(memory);
				var bytes = memory.ToArray();
				if (ext == ".aud" && bytes.Length > 512 * 1024) throw new InvalidDataException("Classic sound is too large: " + name);
				var rel = folder + "/" + name.ToLowerInvariant();
				var path = Path.Combine(output, rel); Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllBytes(path, bytes);
				files.Add(new { name = rel, sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), source, bytes = bytes.Length });
			}
		}
		var mod = SimHost.ModData;
		var sections = new Dictionary<string, IEnumerable<string>> { ["Rules"] = mod.Rules, ["Weapons"] = mod.Weapons, ["Sequences"] = mod.Sequences,
			["Cursors"] = mod.CursorDefinitions, ["Chrome"] = mod.Chrome, ["Voices"] = mod.Voices, ["Notifications"] = mod.Notifications };
		File.WriteAllText(Path.Combine(output, "classic-assets.json"), JsonSerializer.Serialize(new { schema = 1, notice = "EA has not endorsed and does not support this product.",
			guidelines = "https://www.ea.com/games/command-and-conquer/news/modding-faq", files, mounts, sections,
			configuration = "Freeze the resolved default web experience in manifest order; no desktop experience picker is exposed.",
			excluded = new[] { "archives", "scores.mix", "general.mix", "speech.mix (EVA)", "movies", "C&C music" } }, new JsonSerializerOptions { WriteIndented = true }));
		Console.WriteLine($"Exported {files.Count} individually hashed Classic art/sound files; no archives, EVA or music.");
		return 0;
	}
}
