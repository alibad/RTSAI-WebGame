using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OpenRA.WebSim;

/// <summary>The recovered Classic mod, not the historical RA2 rectangular adapter.
/// Local previews read the already installed Classic content. No installer, release or original input is modified.
/// Keeping these archives local is deliberate; this command does not authorize redistributing their contents.</summary>
static class ClassicBundle
{
	public static int Build(Dictionary<string, string> opts)
	{
		var output = Path.GetFullPath(opts["out"]);
		for (var dir = Path.GetDirectoryName(output); dir != null; dir = Path.GetDirectoryName(dir))
			if (Directory.Exists(Path.Combine(dir, ".git")) || File.Exists(Path.Combine(dir, ".git")))
				throw new InvalidOperationException("Classic installed-content previews must stay outside Git repositories.");
		var engine = opts["engine"];
		var mods = Path.Combine(opts["mod"], "mods");
		var support = Path.Combine(opts["support"], "Content", "ra", "v2");
		if (!File.Exists(Path.Combine(support, "conquer.mix")))
			throw new FileNotFoundException("Install the existing Classic content before building its local web preview.");
		Directory.CreateDirectory(Path.GetDirectoryName(output));
		using var identity = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
		var inventory = new List<object>();
		var art = new List<(string Path, string File)>();
		using (var stream = File.Create(output + ".tmp"))
		using (var pack = new Pack.Writer(stream))
		{
			void Add(string name, byte[] bytes)
			{
				identity.AppendData(Encoding.UTF8.GetBytes(name + "|" + bytes.Length + "|"));
				identity.AppendData(bytes);
				pack.Add(name, bytes);
			}
			void Asset(string name, string file)
			{
				var bytes = File.ReadAllBytes(file);
				if ((name.EndsWith(".png") || name.EndsWith(".shp")) && bytes.Length >= 32768)
				{
					identity.AppendData(Encoding.UTF8.GetBytes(name + "|" + bytes.Length + "|"));
					identity.AppendData(bytes);
					art.Add((name, file));
				}
				else Add(name, bytes);
			}
			void Tree(string source, string target, bool installed = false)
			{
				foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
				{
					var rel = Path.GetRelativePath(source, file).Replace('\\', '/');
					if (rel.Split('/').Any(p => p.StartsWith('.')) || rel.EndsWith(".pyc") || rel.EndsWith(".vqa")) continue;
					// Classic imports the desktop chrome/strings, not the unrelated RA2 art and soundtrack.
					if (target == "mods/rtsai/" && (rel.StartsWith("standalone/") || rel.StartsWith("modern-factions/") && rel != "modern-factions/loading-tips.ftl" || rel.StartsWith("maps/") || rel.StartsWith("audio/"))) continue;
					// Installed movie/music packages are unrelated to unit editing and remain on disk.
					if (installed && (rel.StartsWith("movies/") || rel is "scores.mix" or "general.mix")) continue;
					var bytes = File.ReadAllBytes(file);
					if (file.EndsWith(".ttf") || file.EndsWith(".otf")) bytes = [];
					if (!installed && (rel.EndsWith(".png") || rel.EndsWith(".shp"))) Asset(target + rel, file);
					else Add(target + rel, bytes);
					if (installed) inventory.Add(new { path = rel, sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), bytes = bytes.Length });
				}
			}
			Add("ora/MOD_ID", Encoding.UTF8.GetBytes("rtsai-classic-core"));
			Add("ora/VERSION", File.ReadAllBytes(Path.Combine(engine, "VERSION")));
			Add("ora/global mix database.dat", File.ReadAllBytes(Path.Combine(engine, "global mix database.dat")));
			Tree(Path.Combine(engine, "glsl"), "ora/glsl/");
			Tree(Path.Combine(engine, "mods/common"), "ora/mods/common/");
			Tree(Path.Combine(mods, "rtsai"), "mods/rtsai/");
			// mod.yaml is written once below, after applying host-only changes.
			var classic = Path.Combine(mods, "rtsai-classic-core");
			foreach (var file in Directory.EnumerateFiles(classic, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
			{
				var rel = Path.GetRelativePath(classic, file).Replace('\\', '/');
				if (rel == "mod.yaml" || rel.Split('/').Any(p => p.StartsWith('.')) || rel.EndsWith(".pyc")) continue;
				Asset("mods/rtsai-classic-core/" + rel, file);
			}
			var yaml = File.ReadAllText(Path.Combine(classic, "mod.yaml")).Replace("\r\n", "\n")
				.Replace("LoadScreen: RTSAILoadScreen", "LoadScreen: WebLoadScreen")
				.Replace("Assemblies: ", "Assemblies: OpenRA.WebSim.dll, ");
			yaml = Bundle.AppendToSection(yaml, "Rules", "ra|web-host.yaml");
			Add("mods/rtsai-classic-core/mod.yaml", Encoding.UTF8.GetBytes(yaml));
			Add("mods/rtsai-classic-core/web-host.yaml", Encoding.UTF8.GetBytes(Bundle.WebRules));
			// A real Classic map supplies terrain, resources and spawn locations. Its rules stay intact.
			var arena = Path.Combine(classic, "maps/a-nuclear-winter");
			Tree(arena, "mods/rtsai-classic-core/maps/web-arena/");
			Tree(Path.Combine(classic, "maps/chernobyl"), "mods/rtsai-classic-core/maps/web-arena-four/");
			Tree(support, "support/Content/ra/v2/", installed: true);
			Add("ora/classic-inputs.json", Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { localOnly = true, mod = "rtsai-classic-core", files = inventory })));
			pack.Add("ora/BUNDLE_ID", Encoding.UTF8.GetBytes(Convert.ToHexString(identity.GetHashAndReset())[..20].ToLowerInvariant()));
		}
		File.Move(output + ".tmp", output, true);
		// The local pack contains its audio; it must not accidentally reuse the adapter's lazy indexes.
		Bundle.WriteLazyPack(Path.Combine(Path.GetDirectoryName(output), "web-art.pack"), art);
		Bundle.WriteLazyPack(Path.Combine(Path.GetDirectoryName(output), "web-audio.pack"), []);
		Console.WriteLine($"Recovered Classic local bundle: {new FileInfo(output).Length / 1048576.0:F1} MB; {inventory.Count} installed inputs indexed.");
		return 0;
	}
}
