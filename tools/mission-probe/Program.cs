using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;
using OpenRA.WebSim;

// usage: MissionProbe <vfs root> <scenario.json> <ticks> [plan] [difficulty] (see MissionProbe.csproj)
// plan "idle": the player does nothing. plan "sweep": the whole force attack-moves through the named waypoints in
// order (a crude stand-in for a player), moving on when the force is near each one or after a time limit.
// plans "stealth", "boarding", "finale": the scripted players of Scripted.cs (Glass Island, Black Platform, Every Light On).
static class Probe
{
	static int Main(string[] args)
	{
		var root = args[0];
		var spec = ScenarioSpec.Parse(File.ReadAllText(args[1]));
		var ticks = int.Parse(args[2]);
		var plan = args.Length > 3 ? args[3] : "idle";
		if (args.Length > 4) spec.Options["difficulty"] = args[4];
		SimHost.Boot(root);
		SimHost.Start(spec);
		var world = SimHost.World;
		var human = world.LocalPlayer;
		var named = world.WorldActor.Trait<SpawnMapActors>().Actors;
		var watch = named.Keys.Where(k => k.Contains("Checkpoint") || k.Contains("Pier") || k.Contains("Clinic") || k.Contains("Watch") || k.Contains("Town")
			|| k.StartsWith("Dome", StringComparison.Ordinal) || k.StartsWith("Gen", StringComparison.Ordinal) || k is "Tanya" or "Specialist" or "CurtainControl" or "PictureRelay" or "SaudiConyard").ToArray();
		var script = Scripted.For(plan, world, human, named, Missions.Catalog.Single(m => m.Id == spec.Mission));
		var steps = plan == "idle" || script != null ? [] : plan.Split(',');
		var step = 0; var stepStart = 0;
		var lastState = "";
		for (var i = 0; i < ticks; i++)
		{
			script?.Invoke(i);
			if (step < steps.Length)
			{
				var target = named[steps[step]];
				var force = world.Actors.Where(a => a.Owner == human && a.IsInWorld && !a.IsDead && a.TraitOrDefault<IMove>() != null
					&& a.Info.Name != "sapc" && a.Info.Name != "lcrf" && a.Info.Name != "harv").ToArray();
				if (i == stepStart)
					foreach (var a in force)
						SimHost.IssueScripted(new Order("AttackMove", a, Target.FromCell(world, target.Location), false));
				var near = force.Count(a => (a.CenterPosition - target.CenterPosition).HorizontalLengthSquared < 6L * 6 * 1024 * 1024);
				if (i > stepStart + 25 && (near * 2 >= force.Length || i > stepStart + 25 * 150))
				{
					Console.WriteLine($"{world.WorldTick / 1500.0:F2} min: plan step {steps[step]} done ({near}/{force.Length} near)");
					step++; stepStart = i + 1;
				}
			}

			SimHost.Tick();
			if (i % 25 != 0 && human.WinState == WinState.Undefined)
				continue;
			var state = string.Join(" ", System.Text.Json.JsonDocument.Parse(Missions.StateJson()).RootElement.GetProperty("objectives").EnumerateArray()
				.Select(o => o.GetProperty("status").GetString()[0] + (o.GetProperty("progress").GetString() is { Length: > 0 } p && !p.Contains("seconds") ? $"({p})" : "")));
			if (state != lastState || i % 1500 == 0 || human.WinState != WinState.Undefined)
			{
				var dead = watch.Where(n => named[n].IsDead || !named[n].IsInWorld).ToArray();
				var units = world.Actors.Count(a => a.Owner == human && a.IsInWorld && !a.IsDead && a.TraitOrDefault<IMove>() != null);
				var enemy = world.Actors.Count(a => a.Owner.InternalName == "Orion Group" && a.IsInWorld && !a.IsDead && a.TraitOrDefault<IMove>() != null);
				var hurt = watch.Where(n => !named[n].IsDead && named[n].IsInWorld && named[n].TraitOrDefault<IHealth>() is { } h && h.HP < h.MaxHP)
					.Select(n => $"{n} {100 * named[n].Trait<IHealth>().HP / named[n].Trait<IHealth>().MaxHP}%");
				Console.WriteLine($"{world.WorldTick / 1500.0:F2} min: {state} | units {units} vs {enemy} | down: {string.Join(",", dead)} | hurt: {string.Join(",", hurt)} | events {string.Join(",", Missions.FiredEvents)}");
				lastState = state;
			}

			if (human.WinState != WinState.Undefined)
			{
				Console.WriteLine($"RESULT {human.WinState} at {world.WorldTick / 1500.0:F2} min");
				Log.Dispose();
				return 0;
			}
		}

		Console.WriteLine($"RESULT undecided at {world.WorldTick / 1500.0:F2} min");
		Log.Dispose();
		return 0;
	}
}
