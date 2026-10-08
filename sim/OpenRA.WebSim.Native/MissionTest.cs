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
static class MissionTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var id = opts["mission"];
		var def = Missions.Catalog.Single(m => m.Id == id);
		SimHost.Start(new ScenarioSpec
		{
			Map = id, Mission = id, Seed = 2026, Players = [new PlayerSpec { Slot = def.Slot, Faction = def.Faction }],
			Options = new() { ["difficulty"] = "normal", ["startingcash"] = "10000", ["fog"] = "False" }
		});
		var world = SimHost.World; var human = world.LocalPlayer;
		var named = world.WorldActor.Trait<SpawnMapActors>().Actors;
		for (var i = 0; i < 10; i++) SimHost.Tick();
		if (human.WinState != WinState.Undefined) throw new Exception(id + ": mission ended before any objectives");
		if (opts.GetValueOrDefault("mode") == "failure")
		{
			named[def.Protect.First()].Kill(named[def.Protect.First()]);
			for (var i = 0; i < 10; i++) SimHost.Tick();
			if (human.WinState != WinState.Lost) throw new Exception(id + ": critical loss did not end mission");
			Console.WriteLine(JsonSerializer.Serialize(new { mission = id, mode = "failure", passed = true })); return 0;
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
			if (i % 200 == 0)
				foreach (var a in world.Actors.Where(a => a.Owner.InternalName == def.Enemy && a.TraitOrDefault<Mobile>() != null).ToArray()) a.Kill(a);
			if (i % 100 == 0) Snapshot.Build();
		}
		if (human.WinState != WinState.Won)
		{
			Console.WriteLine(Missions.StateJson());
			foreach (var a in world.Actors.Where(a => a.Info.Name is "sapc" or "lcrf" or "r2zbd")) Console.WriteLine($"{a.Info.Name} {a.Location} idle={a.IsIdle}");
			throw new Exception(id + ": objectives/route did not produce victory (" + human.WinState + ")");
		}
		Console.WriteLine(JsonSerializer.Serialize(new { mission = id, mode = "success", tick = world.WorldTick, passed = true }));
		return 0;
	}

	static Actor Spawn(World world, string type, Player owner, CPos cell, bool deployed = false)
	{
		var init = new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName) };
		if (deployed) init.Add(new DeployStateInit(DeployState.Deployed));
		return world.CreateActor(true, type, init);
	}
}
