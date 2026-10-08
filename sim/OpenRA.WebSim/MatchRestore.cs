using System;
using System.Text.Json;

namespace OpenRA.WebSim
{
	/// <summary>Reconstruct local matches from native order packets and verify every recorded net frame.</summary>
	public static class MatchRestore
	{
		public static void Start(string scenarioJson)
		{
			using var document = JsonDocument.Parse(scenarioJson);
			var scenario = ScenarioSpec.Parse(scenarioJson);
			if (!document.RootElement.TryGetProperty("webReplay", out var replay))
			{
				SimHost.Start(scenario);
				return;
			}

			if (scenario.Multiplayer)
				throw new InvalidOperationException("Only local matches can be restored.");
			var log = replay.GetProperty("log").GetRawText();
			var packets = SessionLog.ReadPackets(log);
			var hashes = SessionLog.ReadHashes(log);
			var target = replay.GetProperty("tick").GetInt32();
			if (target < 0 || target > 2000000)
				throw new InvalidOperationException("Invalid restore position.");
			SimHost.Start(scenario, packets);
			while (SimHost.World.WorldTick < target)
				SimHost.Tick();
			for (var i = 0; i < Math.Min(hashes.Count, SimHost.Connection.SyncHashes.Count); i++)
				if (hashes[i] != SimHost.Connection.SyncHashes[i])
					throw new InvalidOperationException($"Replay diverged at net frame {i + 1}. The game content may have changed.");
			foreach (var packet in packets)
				SimHost.Connection.RecordedPackets[packet.Key] = packet.Value;
			if (!replay.TryGetProperty("readonly", out var readOnly) || !readOnly.GetBoolean())
				SimHost.Connection.ReplayPackets = null;
		}
	}
}
