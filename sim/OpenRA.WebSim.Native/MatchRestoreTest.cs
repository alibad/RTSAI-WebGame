using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenRA.WebSim;

static class MatchRestoreTest
{
	public static int Run(Dictionary<string, string> options)
	{
		var original = File.ReadAllText(options["scenario"]);
		SimHost.Boot(options["root"]);
		SimHost.Start(ScenarioSpec.Parse(original));
		void Ticks(int count) { for (var i = 0; i < count; i++) SimHost.Tick(); }
		Ticks(5);
		var tank = SimHost.World.Actors.First(a => a.Owner == SimHost.World.LocalPlayer && a.Info.Name == "r2m1a2s");
		SimHost.Select([tank.ActorID], false);
		Ui.Command("{\"cmd\":\"stance\",\"stance\":\"holdfire\"}");
		Ticks(200);
		var target = SimHost.World.WorldTick;
		var log = SessionLog.Write(SimHost.Scenario, SimHost.Connection);
		if (SessionLog.ReadPackets(log).Count == 0) throw new Exception("Test did not record a real order.");
		string RestoreScenario(string record, int tick, bool readOnly = false)
		{
			var scenario = JsonNode.Parse(original);
			scenario["webReplay"] = new JsonObject { ["log"] = JsonNode.Parse(record), ["tick"] = tick, ["readonly"] = readOnly, ["end"] = target };
			return scenario.ToJsonString();
		}
		MatchRestore.Start(RestoreScenario(log, target));
		if (SimHost.World.WorldTick != target || SimHost.Connection.ReplayPackets != null) throw new Exception("Resume did not restore the exact writable position.");
		if (!SimHost.Connection.SyncHashes.SequenceEqual(SessionLog.ReadHashes(log))) throw new Exception("Restored hashes differ.");
		SimHost.Select([tank.ActorID], false);
		Ui.Command("{\"cmd\":\"stance\",\"stance\":\"defend\"}");
		Ticks(100);
		var extended = SessionLog.Write(SimHost.Scenario, SimHost.Connection);
		MatchRestore.Start(RestoreScenario(extended, SimHost.World.WorldTick));
		if (!SimHost.Connection.SyncHashes.SequenceEqual(SessionLog.ReadHashes(extended))) throw new Exception("Resumed recording lost its original orders.");
		MatchRestore.Start(RestoreScenario(log, 0, true));
		if (SimHost.Connection.ReplayPackets == null) throw new Exception("Replay packets missing.");
		Ticks(target);
		if (!SimHost.Connection.SyncHashes.SequenceEqual(SessionLog.ReadHashes(log))) throw new Exception("Read-only replay differs.");
		var corrupt = JsonNode.Parse(log); corrupt["hashes"][0] = corrupt["hashes"][0].GetValue<int>() ^ 1;
		try { MatchRestore.Start(RestoreScenario(corrupt.ToJsonString(), target)); }
		catch (InvalidOperationException) { Console.WriteLine("Match restore tests passed: exact hashes, resumed orders, read-only replay, divergence rejection."); return 0; }
		throw new Exception("Corrupt sync hash was accepted.");
	}
}
