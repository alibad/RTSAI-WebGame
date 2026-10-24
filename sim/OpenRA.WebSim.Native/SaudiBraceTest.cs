using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.RTSAI.Traits;
using OpenRA.WebSim;

static class SaudiBraceTest
{
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var cases = new List<object>();
		ScenarioSpec Scene(string bot) => new()
		{
			Map = "web-arena", Bare = true, Seed = 4242,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = "saudi", Bot = bot }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Spawns = [new SpawnSpec { Type = "r2sang", Player = 0, X = 40, Y = 50, Order = "engage" },
				new SpawnSpec { Type = "nacnst", Player = 1, X = 45, Y = 50 }],
			Options = new() { ["shortgame"] = "False", ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
		};
		foreach (var profile in new[] { "normal", "medium", "rush", "turtle", "naval" })
		{
			SimHost.Start(Scene(profile));
			var world = SimHost.World;
			var player = world.Players.First(p => p.InternalName == "Multi0");
			var guard = world.Actors.First(a => a.Info.Name == "r2sang");
			var deploy = guard.Trait<GrantConditionOnDeploy>();
			var module = player.PlayerActor.Trait<SaudiBraceBotModule>();
			for (var i = 0; i < 500 && deploy.DeployState != DeployState.Deployed; i++) SimHost.Tick();
			if (module.OrdersIssued == 0 || deploy.DeployState != DeployState.Deployed)
				throw new Exception(profile + ": stationary firing Guard did not brace.");
			var from = guard.Location;
			world.IssueOrder(new Order("Move", guard, Target.FromCell(world, from + new CVec(-6, 0)), false));
			for (var i = 0; i < 35; i++) SimHost.Tick();
			if (deploy.DeployState != DeployState.Undeployed || guard.Location == from)
				throw new Exception(profile + ": Guard could not leave brace and move.");
			cases.Add(new { profile, deployOrders = module.OrdersIssued, braced = true, moved = true });
		}
		SimHost.Start(Scene(null));
		var humanGuard = SimHost.World.Actors.First(a => a.Info.Name == "r2sang");
		for (var i = 0; i < 120; i++) SimHost.Tick();
		if (humanGuard.Trait<GrantConditionOnDeploy>().DeployState != DeployState.Undeployed)
			throw new Exception("A human Guard was automatically braced.");
		Console.WriteLine(JsonSerializer.Serialize(new { passed = true, cases, humanControlPreserved = true }));
		return 0;
	}
}
