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

		var packings = new Dictionary<string, (List<Sheet> Sheets, List<string> Maps, long Bytes)>();
		string currentMap = null;
		SpriteStore.Load = _ => null;
		SpriteStore.Saved = (key, table, ids) =>
		{
			if (packings.TryGetValue(key, out var known))
			{
				known.Maps.Add(currentMap);
				return;
			}

			// Raw files: the host compresses them (the public build precompresses with brotli, served with
			// Content-Encoding: br, so the browser inflates them natively).
			File.WriteAllBytes(Path.Combine(outDir, key + ".table.bin"), table);
			long bytes = 0;
			var sheets = new List<Sheet>();
			for (var i = 0; i < ids.Length; i++)
			{
				var t = WebTexture.All[ids[i]];
				if (t.Data == null)
					throw new InvalidOperationException($"sheet {i} (texture {ids[i]}) of {key} has no pixels");

				// Only the rows sprites were packed into (the last sheet of a group is partly empty).
				var w = t.Size.Width;
				var rows = t.Size.Height;
				while (rows > 0 && t.Data.AsSpan((rows - 1) * w * 4, w * 4).IndexOfAnyExcept((byte)0) < 0)
					rows--;

				// Indexed sheets hold four independent 8-bit sprite planes in the RGBA channels; stored plane after plane
				// they compress far better (about 3x). Kept interleaved where that is smaller (some true-colour sheets).
				var used = t.Data.AsSpan(0, rows * w * 4).ToArray();
				var planar = Planarize(used);
				var interleavedSize = BrotliSize(used);
				var planarSize = BrotliSize(planar);
				var usePlanar = planarSize < interleavedSize;
				File.WriteAllBytes(Path.Combine(outDir, $"{key}.{i}.bin"), usePlanar ? planar : used);
				bytes += Math.Min(planarSize, interleavedSize);
				sheets.Add(new Sheet(w, t.Size.Height, rows, usePlanar, SpriteStore.LastSheetGroups.ElementAtOrDefault(i) ?? ""));
			}

			packings[key] = (sheets, [currentMap], bytes);

			// --report <csv>: sheet pixels per sprite file (what each file costs), for deciding the pack groups.
			if (opts.TryGetValue("report", out var report))
			{
				var tokens = SpriteStore.LastTokens;
				var rows = new Dictionary<string, (string Type, int Sprites, long Area)>();
				foreach (var (token, file) in SpriteStore.LastFiles)
				{
					if (!tokens.TryGetValue(token, out var list) || list == null)
						continue;

					foreach (var sp in list)
					{
						if (sp == null)
							continue;

						rows.TryGetValue(file, out var r);
						rows[file] = (sp.Sheet.Type.ToString(), r.Sprites + 1, r.Area + (long)sp.Bounds.Width * sp.Bounds.Height);
					}
				}

				File.WriteAllLines(report, rows.OrderByDescending(r => r.Value.Area)
					.Select(r => $"{r.Key},{r.Value.Type},{r.Value.Sprites},{r.Value.Area},{SpriteCache.PackGroup?.Invoke(r.Key)}").Prepend("file,type,sprites,area,group"));
			}
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
				sheets = kv.Value.Sheets.Select(s => new { width = s.Width, height = s.Height, rows = s.Rows, planar = s.Planar, group = s.Group }),
				bytes = kv.Value.Bytes,
			}),
		};
		File.WriteAllText(Path.Combine(outDir, "index.json"), JsonSerializer.Serialize(index, new JsonSerializerOptions { WriteIndented = true }));
		foreach (var (key, p) in packings)
		{
			Console.WriteLine($"{key}: {p.Sheets.Count} sheets, about {p.Bytes / 1048576.0:F1} MB brotli, maps {string.Join(", ", p.Maps)}");
			foreach (var g in p.Sheets.GroupBy(s => s.Group))
				Console.WriteLine($"  group '{g.Key}': {g.Count()} sheets");
		}
		return 0;
	}

	sealed record Sheet(int Width, int Height, int Rows, bool Planar, string Group);

	static byte[] Planarize(byte[] rgba)
	{
		var px = rgba.Length / 4;
		var planar = new byte[rgba.Length];
		for (var p = 0; p < px; p++)
		{
			planar[p] = rgba[4 * p];
			planar[px + p] = rgba[4 * p + 1];
			planar[2 * px + p] = rgba[4 * p + 2];
			planar[3 * px + p] = rgba[4 * p + 3];
		}

		return planar;
	}

	/// <summary>Brotli size at a fast quality (to choose a layout; the build compresses at the best quality).</summary>
	static long BrotliSize(byte[] data)
	{
		var dest = new byte[BrotliEncoder.GetMaxCompressedLength(data.Length)];
		return BrotliEncoder.TryCompress(data, dest, out var written, 5, 22) ? written : data.Length;
	}
}
