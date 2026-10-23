using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.WebSim;

/// <summary>Observe a complete, ordinary bot skirmish. No injected armies, orders, resources or forced victory.</summary>
static class SkirmishAudit
{
	public static int Run(Dictionary<string, string> opts)
	{
		var scenario = ScenarioSpec.Parse(File.ReadAllText(opts["scenario"]));
		if (scenario.Sandbox || scenario.Bare || scenario.Spawns.Count != 0 || scenario.Script != null ||
			scenario.Players.Count != 2 || scenario.Players.Any(p => p.Bot == null))
			throw new ArgumentException("Use two bots and ordinary lobby starting forces; no sandbox, scripted army or opening.");
		var cap = int.Parse(opts.GetValueOrDefault("ticks", "45000"));
		if (cap <= 0) throw new ArgumentException("Tick cap must be positive.");
		var wall = Stopwatch.StartNew();
		SimHost.Boot(opts["root"]);
		SimHost.Start(scenario);
		var world = SimHost.World;
		var players = world.Players.Where(p => p.Playable && !p.NonCombatant).ToArray();
		var samples = new List<object>();
		var firstSeen = players.ToDictionary(p => p.InternalName, _ => new Dictionary<string, int>());
		var firstLoss = new Dictionary<string, int>();
		object Sample(Player p)
		{
			var live = world.Actors.Where(a => a.Owner == p && a.IsInWorld && !a.IsDead).ToArray();
			var res = p.PlayerActor.TraitOrDefault<PlayerResources>();
			var stats = p.PlayerActor.TraitOrDefault<PlayerStatistics>();
			var power = p.PlayerActor.TraitOrDefault<PowerManager>();
			if (stats != null && stats.DeathsCost > 0) firstLoss.TryAdd(p.InternalName, world.WorldTick);
			foreach (var a in live) firstSeen[p.InternalName].TryAdd(a.Info.Name, world.WorldTick);
			return new { slot = p.InternalName, faction = p.Faction.InternalName, win = p.WinState.ToString(),
				cash = res?.Cash, ore = res?.Resources, earned = res?.Earned,
				powerProvided = power?.PowerProvided, powerDrained = power?.PowerDrained,
				killsValue = stats?.KillsCost, lossesValue = stats?.DeathsCost,
				armyValue = stats?.ArmyValue,
				roster = live.GroupBy(a => a.Info.Name).OrderBy(g => g.Key).ToDictionary(g => g.Key, g => g.Count()) };
		}
		void Record() => samples.Add(new { tick = world.WorldTick, players = players.Select(Sample).ToArray() });
		Record();
		// Defeat and the opponent's victory can resolve on adjacent ticks. Observe the actual victory.
		while (world.WorldTick < cap && !players.Any(p => p.WinState == WinState.Won) && !players.All(p => p.WinState == WinState.Lost))
		{
			SimHost.Tick();
			if (world.WorldTick == 25 && opts.ContainsKey("check-training"))
				foreach (var p in players)
				{
					var fighters = world.Actors.Where(a => a.Owner == p && a.IsInWorld && !a.IsDead && a.Info.TraitInfos<ArmamentInfo>().Any()).ToArray();
					if (fighters.Length == 0) throw new InvalidDataException("Training check needs ordinary armed starting forces.");
					foreach (var fighter in fighters)
					{
						var training = fighter.TraitsImplementing<IFirepowerModifier>().Any(m => m.GetFirepowerModifier() == 60);
						if (training != (p.BotType == "medium")) throw new InvalidDataException($"Unexpected training modifier: {p.InternalName}/{fighter.Info.Name}");
					}
				}
			if (world.WorldTick % 25 == 0) Record();
		}
		Record();
		var completed = players.Any(p => p.WinState == WinState.Won);
		var result = new { schema = "rtsai.skirmish-audit/v1", completed,
			reason = completed ? "conquest" : players.All(p => p.WinState == WinState.Lost) ? "mutual-defeat" : "tick-cap", scenario = JsonDocument.Parse(File.ReadAllText(opts["scenario"])).RootElement,
			ticks = world.WorldTick, gameMinutes = world.WorldTick / 1500.0, wallSeconds = wall.Elapsed.TotalSeconds,
			firstLoss, firstSeen, samples };
		File.WriteAllText(opts["out"], JsonSerializer.Serialize(result));
		Console.WriteLine(JsonSerializer.Serialize(new { completed, ticks = world.WorldTick, firstLoss,
			players = players.Select(p => new { slot = p.InternalName, faction = p.Faction.InternalName, win = p.WinState.ToString() }) }));
		return completed ? 0 : 1;
	}
}
