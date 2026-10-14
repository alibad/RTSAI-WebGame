using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.WebSim;

/// <summary>
/// A charging tower against the page's audio gate. The scenario (scenarios/tower-*.json) gives one side power plants and a
/// tesla coil or prism tower and the other side infantry in its range; the match runs with the gate the browser installs
/// (--gate browser, SimHost.GateAudio, every lazily mounted file counted as fetched), the gate runtimes up to
/// rt-04dcc660ef36 installed (--gate old: it asked the file system where a sound sits before the engine loaded it, which
/// made a missing sound look present and its load throw), or none (--gate none: the engine alone). Passes when the
/// tower fires and nothing throws; with --expect-error, when the match throws (the old gate and a missing sound).
///   websim soundtest --root &lt;vfs&gt; --scenario scenarios/tower-tesla.json [--gate browser|old|none] [--ticks 1500]
/// </summary>
static class SoundTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var gate = opts.GetValueOrDefault("gate", "browser");
		if (gate == "browser")
			SimHost.GateAudio(_ => true);
		else if (gate == "old")
			OpenRA.Sound.AudioReady = name =>
			{
				SimHost.LoosePath(name);
				return true;
			};
		else
			OpenRA.Sound.AudioReady = null;

		var spec = ScenarioSpec.Parse(File.ReadAllText(opts["scenario"]));
		SimHost.Start(spec);
		var world = SimHost.World;
		var players = SimHost.PlayablePlayers();
		int Targets() => world.Actors.Count(a => a.Owner == players[1] && a.IsInWorld && !a.IsDead && a.TraitOrDefault<Mobile>() != null);
		string[] Towers() => world.Actors.Where(a => a.IsInWorld && !a.IsDead && a.Info.Name is "tesla" or "atesla")
			.Select(a => $"{a.Owner.Faction.InternalName}:{a.Info.Name}").Distinct().ToArray();

		// A scenario that places towers stops once their targets are dead; one without (bots building their own bases,
		// e.g. scenarios/ai-towers.json) runs for --ticks.
		var placed = spec.Spawns.Count > 0;
		var before = Targets();
		var towers = Towers();
		var ticks = int.Parse(opts.GetValueOrDefault("ticks", "1500"));
		Exception error = null;
		var tick = 0;
		try
		{
			for (; tick < ticks && (!placed || Targets() > 0); tick++)
				SimHost.Tick();
		}
		catch (Exception e)
		{
			error = e;
		}

		var after = error == null ? Targets() : -1;
		var fired = error == null && (!placed || after < before);
		var expectError = opts.ContainsKey("expect-error");
		var passed = expectError ? error != null : error == null && fired && (towers.Length > 0 || !placed);
		Console.WriteLine(JsonSerializer.Serialize(new
		{
			scenario = Path.GetFileName(opts["scenario"]), gate, towers, towersAtEnd = Towers(), ticks = tick, targetsBefore = before,
			targetsAfter = after, skippedSounds = SimHost.SkippedSounds, error = error?.GetBaseException().Message, passed
		}));
		return passed ? 0 : 1;
	}
}
