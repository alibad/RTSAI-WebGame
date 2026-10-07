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
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using OpenRA.Graphics;
using OpenRA.WebSim;

/// <summary>
/// Prebakes sprite sheets ahead of time: prepares each map natively exactly as the browser does and writes the
/// packed sprite table and sheet pixels (gzip) with an index, so a first visit restores them instead of decoding and
/// packing every sprite file (the browser's packing is identical: same files, same order, same packer).
///   websim bake --root &lt;vfs&gt; --maps all|twin-fords,harbor-line --out data/public/sprites
/// Output is derived from the bundle it was baked from (its id is recorded); bake only project content for /data.
/// </summary>
static class Bake
{
	public static int Run(Dictionary<string, string> opts)
	{
		var root = opts["root"];
		var outDir = Path.GetFullPath(opts["out"]);
		var bundleId = File.ReadAllText(Path.Combine(root, "ora", "BUNDLE_ID")).Trim();

		if (Directory.Exists(outDir))
			Directory.Delete(outDir, true);
		Directory.CreateDirectory(outDir);

		var packings = new Dictionary<string, (List<int[]> Sheets, List<string> Maps, long Bytes)>();
		string currentMap = null;
		SpriteStore.Load = _ => null;
		SpriteStore.Saved = (key, table, ids) =>
		{
			if (packings.TryGetValue(key, out var known))
			{
				known.Maps.Add(currentMap);
				return;
			}

			long bytes = 0;
			bytes += WriteGz(Path.Combine(outDir, key + ".table.gz"), table);
			var sheets = new List<int[]>();
			for (var i = 0; i < ids.Length; i++)
			{
				var t = WebTexture.All[ids[i]];
				if (t.Data == null)
					throw new InvalidOperationException($"sheet {i} (texture {ids[i]}) of {key} has no pixels");

				bytes += WriteGz(Path.Combine(outDir, $"{key}.{i}.gz"), t.Data.AsSpan(0, 4 * t.Size.Width * t.Size.Height));
				sheets.Add([t.Size.Width, t.Size.Height]);
			}

			packings[key] = (sheets, [currentMap], bytes);
		};
		SpriteCache.Store = new SpriteStore();

		SimHost.Boot(root);

		// "all": every map a player can pick (any MapFolder), the sandbox arena included.
		var maps = opts["maps"] == "all"
			? SimHost.ModData.MapCache.Where(p => p.Visibility.HasFlag(OpenRA.MapVisibility.Lobby)).Select(p => Path.GetFileName(p.Path)).ToArray()
			: opts["maps"].Split(',', StringSplitOptions.RemoveEmptyEntries);
		foreach (var map in maps)
		{
			currentMap = map;
			var t0 = DateTime.UtcNow;
			SimHost.Prepare(map);
			Console.WriteLine($"{map}: prepared in {(DateTime.UtcNow - t0).TotalMilliseconds:F0} ms");
		}

		var index = new
		{
			format = "ORASPR01",
			bundle = bundleId,
			packings = packings.ToDictionary(kv => kv.Key, kv => new
			{
				maps = kv.Value.Maps,
				sheets = kv.Value.Sheets.Select(s => new { width = s[0], height = s[1] }),
				bytes = kv.Value.Bytes,
			}),
		};
		File.WriteAllText(Path.Combine(outDir, "index.json"), JsonSerializer.Serialize(index, new JsonSerializerOptions { WriteIndented = true }));
		foreach (var (key, p) in packings)
			Console.WriteLine($"{key}: {p.Sheets.Count} sheets, {p.Bytes / 1048576.0:F1} MB gzip, maps {string.Join(", ", p.Maps)}");
		return 0;
	}

	static long WriteGz(string path, ReadOnlySpan<byte> data)
	{
		using (var f = File.Create(path))
		using (var gz = new GZipStream(f, CompressionLevel.SmallestSize))
			gz.Write(data);
		return new FileInfo(path).Length;
	}
}
