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
using OpenRA;
using OpenRA.WebSim;

/// <summary>
/// LOCAL/ADMIN ONLY. Copies the RA2 packages the mod mounts (the inner .mix files of the player's own
/// ra2.mix / language.mix) into a private pack for the local browser build. The output must stay in a
/// private cache outside every repository: it is EA content and is never committed, bundled or deployed.
/// The support directory is only read (logs are disabled), and no links are created into it.
/// </summary>
static class PrivateContent
{
	// mod.yaml ContentPackages that live inside ra2.mix / language.mix, by tileset need.
	static readonly string[] Common =
	[
		"ra2mix|cache.mix", "ra2mix|conquer.mix", "ra2mix|generic.mix", "ra2mix|isogen.mix", "ra2mix|load.mix",
		"ra2mix|local.mix", "ra2mix|neutral.mix", "ra2mix|sidec01.mix", "ra2mix|sidec02.mix", "lang|cameo.mix",
	];

	static readonly Dictionary<string, string[]> Tilesets = new()
	{
		["temperate"] = ["ra2mix|isotemp.mix", "ra2mix|tem.mix", "ra2mix|temperat.mix"],
		["snow"] = ["ra2mix|isosnow.mix", "ra2mix|sno.mix", "ra2mix|snow.mix"],
		["urban"] = ["ra2mix|isourb.mix", "ra2mix|urb.mix", "ra2mix|urban.mix"],
	};

	public static int Extract(Dictionary<string, string> opts)
	{
		var root = opts["root"];
		var support = opts["support"];
		var output = opts["out"];
		var tilesets = (opts.TryGetValue("tilesets", out var t) ? t : "temperate").Split(',');

		var full = Path.GetFullPath(output);
		for (var dir = Path.GetDirectoryName(full); dir != null; dir = Path.GetDirectoryName(dir))
			if (Directory.Exists(Path.Combine(dir, ".git")) || File.Exists(Path.Combine(dir, ".git")))
				throw new InvalidOperationException($"Refusing to write EA content inside a repository ({dir}). Use a private cache directory.");

		SimHost.Boot(root, support, logFiles: false);
		var fs = SimHost.ModData.ModFiles;

		var names = Common.Concat(tilesets.SelectMany(ts => Tilesets[ts])).ToList();
		long total = 0;
		Directory.CreateDirectory(Path.GetDirectoryName(full));
		using (var file = File.Create(full))
		using (var pack = new Pack.Writer(file))
		{
			foreach (var name in names)
			{
				if (!fs.TryOpen(name, out var s))
				{
					Console.WriteLine($"  missing {name}");
					continue;
				}

				byte[] data;
				using (s)
					data = s.ReadAllBytes();

				// content|ra2.mix -> a folder named ra2.mix holding its inner packages (FileSystem mounts folders like packages).
				var parts = name.Split('|');
				var outer = parts[0] == "lang" ? "language.mix" : "ra2.mix";
				pack.Add($"support/Content/ra2/{outer}/{parts[1]}", data);
				total += data.Length;
				Console.WriteLine($"  {name,-24} {data.Length / 1048576.0,6:F1} MB");
			}
		}

		Console.WriteLine($"{full}: {total / 1048576.0:F1} MB private content ({string.Join(",", tilesets)})");
		return 0;
	}
}
