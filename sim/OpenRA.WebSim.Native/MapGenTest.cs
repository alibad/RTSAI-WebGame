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
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// websim mapgentest --root &lt;vfs&gt; [--out &lt;dir&gt;] [--seeds 1,2,3] [--size 96] [--players 2] [--ticks 6000]
/// Generates maps with MapGen (as the browser does), mounts each where the page would (web/content/maps/&lt;id&gt;/), and
/// plays it: a normal bot against an idle player for the given ticks. A map passes when the bot builds a base and its
/// harvesters bring in money, which needs reachable spawns and ore. Copies each map's files to --out for viewing.
/// </summary>
static class MapGenTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		var root = opts["root"];
		var seeds = (opts.TryGetValue("seeds", out var s) ? s : "1,2,3").Split(',').Select(int.Parse).ToList();
		var requestSize = opts.TryGetValue("size", out var z) ? int.Parse(z) : 0;
		var players = opts.TryGetValue("players", out var p) ? int.Parse(p) : 2;
		var ticks = opts.TryGetValue("ticks", out var t) ? int.Parse(t) : 6000;
		var terrain = opts.TryGetValue("terrain", out var tt) ? tt : "random";
		opts.TryGetValue("out", out var outDir);

		SimHost.Boot(root);
		var failures = 0;
		foreach (var seed in seeds)
		{
			var result = MapGen.Generate(JsonSerializer.Serialize(requestSize > 0 ? new { seed, size = requestSize, players, terrain } : (object)new { seed, players, terrain }));
			using var doc = JsonDocument.Parse(result);
			if (doc.RootElement.TryGetProperty("error", out var error))
			{
				Console.WriteLine($"seed {seed}: generation failed: {error.GetString()}");
				failures++;
				continue;
			}

			var id = doc.RootElement.GetProperty("id").GetString();
			var genMs = doc.RootElement.GetProperty("ms").GetDouble();
			var landscape = doc.RootElement.GetProperty("landscape").GetString();
			var size = doc.RootElement.GetProperty("size").GetInt32();
			var dir = Path.Combine(root, "mods", "rtsai", "web", "content", "maps", id);
			Directory.CreateDirectory(dir);
			foreach (var f in doc.RootElement.GetProperty("files").EnumerateObject())
			{
				var bytes = Convert.FromBase64String(f.Value.GetString());
				File.WriteAllBytes(Path.Combine(dir, f.Name), bytes);
				if (outDir != null)
				{
					Directory.CreateDirectory(Path.Combine(outDir, id));
					File.WriteAllBytes(Path.Combine(outDir, id, f.Name), bytes);
				}
			}

			var scenario = ScenarioSpec.Parse(JsonSerializer.Serialize(new
			{
				seed,
				map = id,
				options = new Dictionary<string, string> { ["fog"] = "False", ["explored"] = "True" },
				players = new object[]
				{
					new { slot = "Multi0", faction = "saudi" },
					new { slot = "Multi1", faction = "iran", bot = "normal" },
				},
			}));

			var wall = Stopwatch.StartNew();
			SimHost.Start(scenario);
			var startMs = wall.Elapsed.TotalMilliseconds;
			var bot = SimHost.World.Players.First(pl => pl.IsBot);
			var cashAtStart = bot.PlayerActor.Trait<PlayerResources>().GetCashAndResources();
			var trees = SimHost.World.Actors.Count(a => a.Info.Name.StartsWith("tree", StringComparison.Ordinal));
			var drills = SimHost.World.Actors.Count(a => a.Info.Name == "oremine" || a.Info.Name.StartsWith("tibtre", StringComparison.Ordinal));
			var oreCells = SimHost.World.Map.AllCells.Count(c => SimHost.World.Map.Resources[c].Type != 0);
			var terrainTypes = SimHost.World.Map.Rules.TerrainInfo.TerrainTypes;
			int Cells(string type) => SimHost.World.Map.AllCells.Count(c => terrainTypes[SimHost.World.Map.GetTerrainIndex(c)].Type == type);
			var (waterCells, cliffCells) = (Cells("Water"), Cells("Cliff"));
			wall.Restart();
			for (var i = 0; i < ticks; i++)
				SimHost.Tick();
			var tickMs = wall.Elapsed.TotalMilliseconds;

			var buildings = SimHost.World.Actors.Count(a => a.Owner == bot && !a.IsDead && a.Info.HasTraitInfo<BuildingInfo>());
			var units = SimHost.World.Actors.Count(a => a.Owner == bot && !a.IsDead && a.Info.HasTraitInfo<MobileInfo>());
			var earned = bot.PlayerActor.Trait<PlayerResources>().Earned;
			var pass = buildings >= 4 && earned > 0;
			if (!pass) failures++;
			Console.WriteLine($"seed {seed}: {id} {landscape} {size}x{size} generated in {genMs:F0} ms, world in {startMs:F0} ms, {ticks} ticks in {tickMs:F0} ms; " +
				$"{waterCells} water, {cliffCells} cliff, {oreCells} ore cells, {drills} ore mines, {trees} trees; bot {buildings} buildings, {units} units, earned {earned} (started {cashAtStart}) " +
				(pass ? "PASS" : "FAIL"));
			SimHost.EndGame();
		}

		Console.WriteLine(failures == 0 ? "all maps playable" : $"{failures} of {seeds.Count} maps failed");
		return failures == 0 ? 0 : 1;
	}
}
