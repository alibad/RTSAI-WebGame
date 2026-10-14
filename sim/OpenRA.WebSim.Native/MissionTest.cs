using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Activities;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Regression scenarios exercise objective transitions and convoy routing using real engine actors.</summary>
/// <remarks>Modes: success (default); failure (the first protected actor, or the first protect objective's targets, or
/// a squad, is lost); detected (a player unit walks into every sensor zone in turn); squad (the whole squad is lost).</remarks>
static class MissionTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var id = opts["mission"];
		var def = Missions.Catalog.Single(m => m.Id == id);
		var mode = opts.GetValueOrDefault("mode", "success");
		SimHost.Start(new ScenarioSpec
		{
			Map = id, Mission = id, Seed = 2026, Players = [new PlayerSpec { Slot = def.Slot, Faction = def.Faction }],
			Options = new() { ["difficulty"] = opts.GetValueOrDefault("difficulty", "normal"), ["startingcash"] = "10000", ["fog"] = "False" }
		});
		var world = SimHost.World; var human = world.LocalPlayer;
		var named = world.WorldActor.Trait<SpawnMapActors>().Actors;
		for (var i = 0; i < 10; i++) SimHost.Tick();
		if (human.WinState != WinState.Undefined) throw new Exception(id + ": mission ended before any objectives");
		if (mode is "failure" or "squad")
		{
			var squad = def.Objectives.FirstOrDefault(o => o.Kind == "squad" && !o.Secondary)?.Targets;
			var lost = mode == "squad" ? squad ?? throw new Exception(id + ": no squad")
				: def.Protect.Length > 0 ? def.Protect.Take(1).ToArray()
				: def.Objectives.FirstOrDefault(o => o.Kind == "protect" && !o.Secondary)?.Targets ?? squad;
			foreach (var name in lost) named[name].Kill(named[name]);
			for (var i = 0; i < 10; i++) SimHost.Tick();
			if (human.WinState != WinState.Lost) throw new Exception(id + ": critical loss did not end mission");
			Console.WriteLine(JsonSerializer.Serialize(new { mission = id, mode, lost, passed = true })); return 0;
		}
		if (mode == "detected")
		{
			// A unit of the player's walks into each zone (waiting out its sweep) while the enemy's units and guns are
			// cleared away; each trip fires its alarm events, and the stay-undetected objective fails once its
			// allowance is spent: the mission is lost if that objective is primary.
			var seen = 0;
			var watch = def.Objectives.Select((o, i) => (o, i)).First(x => x.o.Kind == "undetected");
			void Clear()
			{
				foreach (var a in world.Actors.Where(a => a.Owner.InternalName == def.Enemy && (a.TraitOrDefault<Mobile>() != null || a.TraitsImplementing<AttackBase>().Any())).ToArray())
					a.Kill(a);
			}
			Clear();
			foreach (var sensor in def.Sensors)
			{
				var scout = Spawn(world, "e1", human, named[sensor.Actor].Location + new CVec(2, 0));
				for (var i = 0; i < 1500 && human.WinState == WinState.Undefined; i++)
				{
					SimHost.Tick();
					if (i % 25 == 0) Clear();
					if (Missions.Tripped(sensor.Actor)) break;
				}
				if (!Missions.Tripped(sensor.Actor) && human.WinState == WinState.Undefined) throw new Exception(id + ": sensor " + sensor.Actor + " did not trip");
				seen++;
				var alarm = def.Events.FirstOrDefault(e => e.When.Detected == sensor.Actor);
				for (var i = 0; i < 50 && human.WinState == WinState.Undefined; i++) SimHost.Tick();
				if (alarm != null && !Missions.FiredEvents.Contains(alarm.Id)) throw new Exception(id + ": alarm " + alarm.Id + " did not fire");
				scout.Kill(scout);
				if (human.WinState != WinState.Undefined) break;
			}
			var status = JsonDocument.Parse(Missions.StateJson()).RootElement.GetProperty("objectives")[watch.i].GetProperty("status").GetString();
			if (status != "failed" || human.WinState != (watch.o.Secondary ? WinState.Undefined : WinState.Lost))
				throw new Exception(id + ": detection left the objective " + status + " and the mission " + human.WinState);
			Console.WriteLine(JsonSerializer.Serialize(new { mission = id, mode, sensorsTripped = seen, outcome = human.WinState.ToString(), events = Missions.FiredEvents, passed = true })); return 0;
		}
		// Remove opposition to isolate routes/objectives from combat balance in this regression.
		// Capture targets remain alive so their ownership transition is tested separately.
		var capture = def.Objectives.Where(o => o.Kind == "capture").SelectMany(o => o.Targets).ToHashSet();
		foreach (var a in world.Actors.Where(a => a.Owner.InternalName == def.Enemy && !capture.Any(n => named[n] == a)).ToArray()) a.Kill(a);
		foreach (var target in capture) named[target].ChangeOwner(human);
		foreach (var o in def.Objectives)
		{
			if (o.Kind == "build")
				for (var i = 0; i < o.Types.Length; i++) Spawn(world, o.Types[i], human, new MPos(8 + i * 5, 10).ToCPos(world.Map));
			if (o.Kind == "reach")
			{
				for (var i = 0; i < o.Count; i++)
				{
					var start = named[string.IsNullOrEmpty(o.Via) ? o.Target : o.Via].Location + new CVec(i, 0);
					var actor = Spawn(world, o.Types.First(), human, start, o.Deploy);
					if (!string.IsNullOrEmpty(o.Via))
					{
						SimHost.Tick(); // registers a real amphibious actor at the sea gate
						actor.QueueActivity(new Move(actor, named[o.Target].Location));
					}
				}
			}
			if (o.Kind == "scout")
				foreach (var target in o.Targets) Spawn(world, "engineer", human, named[target].Location + new CVec(1, 0));
			if (o.Kind == "disperse")
			{
				var destination = named["WestEntry"].Location;
				foreach (var a in world.Actors.Where(a => a.Owner == human && a.TraitOrDefault<IMove>() != null && a.TraitOrDefault<Building>() == null).ToArray())
				{
					a.CancelActivity();
					a.QueueActivity(a.Trait<IMove>().MoveTo(destination, 4, evaluateNearestMovableCell: true));
				}
			}
		}
		for (var i = 0; i < 25000 && human.WinState == WinState.Undefined; i++)
		{
			SimHost.Tick();
			// Stop the scheduled waves in a route regression, after verifying they can create/tick real actors.
			if (i % 25 == 0)
				foreach (var a in world.Actors.Where(a => a.Owner.InternalName == def.Enemy && a.TraitOrDefault<Mobile>() != null).ToArray()) a.Kill(a);
			if (i % 100 == 0) Snapshot.Build();
		}
		if (human.WinState != WinState.Won)
		{
			Console.WriteLine(Missions.StateJson());
			foreach (var a in world.Actors.Where(a => a.Info.Name is "sapc" or "lcrf" or "r2zbd")) Console.WriteLine($"{a.Info.Name} {a.Location} idle={a.IsIdle}");
			throw new Exception(id + ": objectives/route did not produce victory (" + human.WinState + ")");
		}
		Console.WriteLine(JsonSerializer.Serialize(new { mission = id, mode = "success", tick = world.WorldTick, events = Missions.FiredEvents, passed = true }));
		return 0;
	}

	static Actor Spawn(World world, string type, Player owner, CPos cell, bool deployed = false)
	{
		var init = new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName) };
		if (deployed) init.Add(new DeployStateInit(DeployState.Deployed));
		return world.CreateActor(true, type, init);
	}
}
