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
using System.Text;
using System.Text.Json;
using OpenRA;
using OpenRA.WebSim;

static class Program
{
	static int Main(string[] args)
	{
		if (args.Length == 0)
		{
			Console.WriteLine("usage: websim pack|extract-content|unpack|run ...");
			return 1;
		}

		var opts = ParseOptions(args.Skip(1).ToArray());
		try
		{
			return args[0] switch
			{
				"pack" => Bundle.Build(opts),
				"extract-content" => PrivateContent.Extract(opts),
				"unpack" => Unpack(opts),
				"run" => Run(opts),
				"uitest" => UiTest(opts),
				"capturetest" => CaptureTest(opts),
				_ => throw new ArgumentException("Unknown command " + args[0]),
			};
		}
		catch (Exception e)
		{
			Console.Error.WriteLine(e);
			return 2;
		}
		finally
		{
			// The engine's log writer is a foreground thread: stop it or the process never exits.
			Log.Dispose();
		}
	}

	static Dictionary<string, string> ParseOptions(string[] args)
	{
		var opts = new Dictionary<string, string>();
		for (var i = 0; i < args.Length; i++)
		{
			if (!args[i].StartsWith("--", StringComparison.Ordinal))
				continue;

			var key = args[i][2..];
			opts[key] = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal) ? args[++i] : "true";
		}

		return opts;
	}

	/// <summary>Builds a native VFS root exactly like the browser's: the bundle, plus private content if given.</summary>
	static int Unpack(Dictionary<string, string> opts)
	{
		var root = opts["root"];
		if (Directory.Exists(root))
			throw new IOException($"{root} already exists; pick a fresh directory.");

		var n = Pack.Unpack(File.ReadAllBytes(opts["pack"]), root);
		Console.WriteLine($"unpacked {n} files into {root}");
		if (opts.TryGetValue("private", out var priv))
		{
			var m = Pack.Unpack(File.ReadAllBytes(priv), root);
			Console.WriteLine($"unpacked {m} private content files");
		}

		return 0;
	}

	/// <summary>
	/// Native twin of tools/playtest.mjs: drives the page's commands (Ui.Command) through a short skirmish and
	/// prints the UI state after each step, so command bugs show with full stack traces.
	/// </summary>
	static int UiTest(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		Console.WriteLine("setup: " + SetupInfo.Json()[..Math.Min(400, SetupInfo.Json().Length)]);
		SimHost.Start(ScenarioSpec.Parse(File.ReadAllText(opts["scenario"])));
		void Ticks(int n) { for (var i = 0; i < n; i++) { SimHost.Tick(); Snapshot.Build(); } }
		string Cmd(string json) { var r = Ui.Command(json); Console.WriteLine($"cmd {json} -> {r}"); return r; }
		Ticks(5);
		var world = SimHost.World;
		var mcv = world.Actors.First(a => a.Owner == world.LocalPlayer && a.Info.Name.Contains("mcv"));
		SimHost.Select([mcv.ActorID], false);
		Cmd("{\"cmd\":\"deploy\"}");
		Ticks(60);
		Console.WriteLine("state: " + Ui.State()[..Math.Min(1500, Ui.State().Length)]);
		var power = world.Map.Rules.Actors.Keys.FirstOrDefault(k => k.EndsWith("powr")) ?? "gapowr";
		Cmd($"{{\"cmd\":\"produce\",\"queue\":\"Building\",\"item\":\"{power}\"}}");
		for (var i = 0; i < 2000 && !Ui.State().Contains("\"done\":true"); i++)
			Ticks(1);
		Console.WriteLine($"ready after tick {world.WorldTick}");
		Cmd($"{{\"cmd\":\"produce\",\"queue\":\"Building\",\"item\":\"{power}\"}}");
		Console.WriteLine("mode: " + world.OrderGenerator?.GetType().Name);
		var yard = world.Actors.First(a => a.Owner == world.LocalPlayer && a.Info.HasTraitInfo<OpenRA.Mods.Common.Traits.BuildingInfo>());
		var yp = SimHost.WorldRenderer.ScreenPxPosition(yard.CenterPosition);
		foreach (var (dx, dy) in new[] { (150, 60), (-150, 60), (150, -60), (0, 140), (220, 0) })
		{
			Console.WriteLine("cursor: " + SimHost.Cursor(new int2(yp.X + dx, yp.Y + dy), Modifiers.None));
			SimHost.Click(new int2(yp.X + dx, yp.Y + dy), MouseButton.Left, Modifiers.None);
			Ticks(3);
			if (world.Actors.Any(a => a.Info.Name == power && a.Owner == world.LocalPlayer))
			{
				Console.WriteLine($"placed at {dx},{dy}");
				break;
			}
			if (world.OrderGenerator is not OpenRA.Mods.Common.Orders.PlaceBuildingOrderGenerator)
				Cmd($"{{\"cmd\":\"produce\",\"queue\":\"Building\",\"item\":\"{power}\"}}");
		}
		Ticks(30);
		Console.WriteLine("state: " + Ui.State()[..Math.Min(600, Ui.State().Length)]);
		foreach (var m in new[] { "sell", "repair", "attackmove", "guard", "none" })
			Cmd($"{{\"cmd\":\"mode\",\"mode\":\"{m}\"}}");
		Console.WriteLine($"capture: vertices {Capture.VertexCount} batches {Capture.BatchCount} model cmds {Capture.ModelCmdCount}; others {Snapshot.UnsupportedRenderables}");
		Console.WriteLine("icon bytes: " + Ui.Icon(power).Length);
		return 0;
	}

	/// <summary>Runs a scenario and reports what the renderer capture records (voxels, beams, lines).</summary>
	static int CaptureTest(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		SimHost.Start(ScenarioSpec.Parse(File.ReadAllText(opts["scenario"])));
		var ticks = opts.TryGetValue("ticks", out var t) ? int.Parse(t) : 200;
		var maxV = 0; var maxB = 0; var maxM = 0; var others = 0;
		for (var i = 0; i < ticks; i++)
		{
			SimHost.Tick();
			Snapshot.Build();
			maxV = Math.Max(maxV, Capture.VertexCount);
			maxB = Math.Max(maxB, Capture.BatchCount);
			maxM = Math.Max(maxM, Capture.ModelCmdCount);
			others = Math.Max(others, Snapshot.UnsupportedRenderables);
			if (i % 50 == 49)
				Console.WriteLine($"tick {SimHost.World.WorldTick}: vertices {Capture.VertexCount} batches {Capture.BatchCount} model cmds {Capture.ModelCmdCount} failed {Snapshot.UnsupportedRenderables} snapshot {Snapshot.Bytes.Length} B, model buffers {string.Join(",", Capture.ModelBuffers.Select(kv => kv.Key + ":" + kv.Value.Bytes().Length))}");
		}

		Console.WriteLine($"max: vertices {maxV} batches {maxB} model cmds {maxM} failed {others}");
		return 0;
	}

	static int Run(Dictionary<string, string> opts)
	{
		var root = opts["root"];
		var scenario = ScenarioSpec.Parse(File.ReadAllText(opts["scenario"]));
		var ticks = opts.TryGetValue("ticks", out var t) ? int.Parse(t) : 500;

		Dictionary<int, byte[]> replay = null;
		if (opts.TryGetValue("replay", out var replayFile))
			replay = SessionLog.ReadPackets(File.ReadAllText(replayFile));

		var wall = Stopwatch.StartNew();
		SimHost.Boot(root);
		var bootMs = wall.Elapsed.TotalMilliseconds;
		SimHost.Start(scenario, replay);
		var startMs = wall.Elapsed.TotalMilliseconds - bootMs;
		Console.WriteLine($"boot {bootMs:F0} ms, start {startMs:F0} ms; {string.Join(", ", SimHost.Timings.Select(kv => $"{kv.Key} {kv.Value:F0}"))}");
		Console.WriteLine($"actors {SimHost.World.Actors.Count()} players {SimHost.World.Players.Length} map {SimHost.World.Map.Title}");
			Console.WriteLine($"player names: {string.Join(", ", SimHost.World.Players.Where(p => p.Playable).Select(p => p.ResolvedPlayerName))}");

		var snapshot = opts.ContainsKey("snapshot");
		if (snapshot)
		{
			Snapshot.StartInfoJson(out var terrain);
			Console.WriteLine($"terrain vertices {terrain.Length / 48}");
		}

		if (opts.ContainsKey("dump"))
		{
			foreach (var a in SimHost.World.Actors.Where(a => a.Owner.Playable && a.OccupiesSpace != null).Take(12))
				Console.WriteLine($"  {a.ActorID} {a.Info.Name} owner={a.Owner.InternalName} inWorld={a.IsInWorld} dead={a.IsDead} pos={a.CenterPosition} cell={a.Location}");
		}

		var tickTimes = new List<double>();
		var snapTimes = new List<double>();
		var snapBytes = new List<int>();
		for (var i = 0; i < ticks; i++)
		{
			var s = Stopwatch.GetTimestamp();
			SimHost.Tick();
			tickTimes.Add(Stopwatch.GetElapsedTime(s).TotalMilliseconds);
			if (snapshot)
			{
				snapBytes.Add(Snapshot.Build());
				snapTimes.Add(Snapshot.LastBuildMs);
			}

			if (opts.ContainsKey("progress") && (i + 1) % 50 == 0)
			{
				var alive = SimHost.PlayablePlayers().Select(p => SimHost.World.Actors.Count(a => a.Owner == p && a.IsInWorld && !a.IsDead)).ToList();
				Console.WriteLine($"  tick {SimHost.World.WorldTick}: alive {string.Join(" vs ", alive)}, last 50 ticks mean {tickTimes.TakeLast(50).Average():F2} ms, hash {SimHost.Connection.SyncHashes.LastOrDefault()}");
			}
		}

		var units = SimHost.World.Actors.Count(a => a.IsInWorld && a.Owner.Playable);
		Console.WriteLine($"ticks {ticks}: world tick {SimHost.World.WorldTick}, playable-owned actors left {units}");
		Console.WriteLine($"tick ms: {Stats(tickTimes)}");
		if (snapshot)
			Console.WriteLine($"snapshot ms: {Stats(snapTimes)}; bytes: mean {snapBytes.Average():F0} max {snapBytes.Max()}; unsupported renderables {Snapshot.UnsupportedRenderables}");

		var gc = GC.GetGCMemoryInfo();
		Console.WriteLine($"managed heap {GC.GetTotalMemory(false) / 1048576.0:F0} MB, working set {Environment.WorkingSet / 1048576.0:F0} MB, peak committed {gc.TotalCommittedBytes / 1048576.0:F0} MB");

		if (opts.TryGetValue("hashes", out var hashFile))
		{
			File.WriteAllLines(hashFile, SimHost.Connection.SyncHashes.Select((h, i) => $"{i + 1} {h}"));
			Console.WriteLine($"wrote {SimHost.Connection.SyncHashes.Count} sync hashes to {hashFile}");
		}

		if (opts.TryGetValue("log", out var logFile))
			File.WriteAllText(logFile, SessionLog.Write(scenario, SimHost.Connection));

		if (opts.TryGetValue("timings", out var timingFile))
			File.WriteAllLines(timingFile, tickTimes.Select(x => x.ToString("F3")));

		return 0;
	}

	static string Stats(List<double> v)
	{
		if (v.Count == 0)
			return "n/a";

		var sorted = v.OrderBy(x => x).ToList();
		double P(double q) => sorted[Math.Min(sorted.Count - 1, (int)(q * sorted.Count))];
		return $"mean {v.Average():F2} p50 {P(0.5):F2} p95 {P(0.95):F2} max {sorted[^1]:F2}";
	}
}
