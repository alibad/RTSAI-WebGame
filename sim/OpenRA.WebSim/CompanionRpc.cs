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
using System.Threading.Tasks;
using Google.Protobuf;
using OpenRA.Mods.RTSAI.Traits;
using RL = OpenRA.Mods.RTSAI.RL;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The AI co-commander's engine RPCs (rl_bridge.proto, the subset the companion uses during a match), answered by
	/// the mod's own CompanionBridge inside the browser. The local companion talks gRPC to the page's server, which
	/// relays each call over a WebSocket to the worker; requests and replies are the protobuf messages themselves.
	/// Confirmed actions become ordinary local-player orders (OrderManager), so they are recorded and replayed like
	/// any other input and SyncHash parity holds.
	/// </summary>
	public static class CompanionRpc
	{
		/// <summary>A gRPC status (https://grpc.github.io/grpc/core/md_doc_statuscodes.html) for the relay.</summary>
		public sealed class RpcException : Exception
		{
			public readonly int Code;

			public RpcException(int code, string message)
				: base(message)
			{
				Code = code;
			}
		}

		const int FailedPrecondition = 9;
		const int Unimplemented = 12;
		const int Unavailable = 14;

		/// <summary>The page turned the co-commander on: the next world's CompanionBridge publishes observations.</summary>
		public static void Enable(bool on)
		{
			Environment.SetEnvironmentVariable("OPENRA_AI_COMPANION", on ? "1" : null);
		}

		public static bool Enabled => Environment.GetEnvironmentVariable("OPENRA_AI_COMPANION") == "1";

		/// <summary>Companion status and threat updates, for the page's co-commander panel (state, message).</summary>
		public static Action<string, string> StatusChanged;
		public static Action<int, string, string> ThreatChanged;

		/// <summary>A confirmed action set reached the engine: request id, accepted, detail.</summary>
		public static Action<string, bool, string> ActionsExecuted;

		/// <summary>The latest observation, serialized (empty when there is none): pushed to the relay as it changes.</summary>
		public static byte[] Observation()
		{
			return CompanionBridge.TryGetObservation(out var observation) ? observation.ToByteArray() : [];
		}

		public static async Task<byte[]> Call(string method, byte[] request)
		{
			switch (method)
			{
				case "Observe":
				{
					if (CompanionBridge.TryGetObservation(out var observation))
						return observation.ToByteArray();
					if (CompanionBridge.IsDisabledForMatch)
						throw new RpcException(FailedPrecondition, CompanionBridge.DisabledForMatchMessage + ".");
					throw new RpcException(Unavailable, "No co-commander observation yet: start a match with the co-commander on.");
				}

				case "GetState":
					return (CompanionBridge.TryGetState(out var state) ? state : new RL.GameState { Phase = "no_match" }).ToByteArray();

				case "UpdateCompanionStatus":
				{
					var status = RL.CompanionStatus.Parser.ParseFrom(request);

					// AUTO hands the local player to the native bot by granting a condition outside the order stream;
					// the browser build keeps every change to the match an order (replayable, parity-checked), so AUTO
					// stays off here until it is an order of its own.
					if (status.State.StartsWith("auto-active", StringComparison.Ordinal))
						status.State = "ready" + status.State["auto-active".Length..];

					var accepted = CompanionBridge.UpdateStatus(status);
					if (accepted)
						StatusChanged?.Invoke(status.State, status.Message);
					return new RL.CompanionStatusAck { Accepted = accepted }.ToByteArray();
				}

				case "UpdateCompanionThreat":
				{
					var threat = RL.CompanionThreat.Parser.ParseFrom(request);
					var accepted = CompanionBridge.UpdateThreat(threat);
					if (accepted)
						ThreatChanged?.Invoke(Math.Clamp(threat.Score, 0, 100), threat.Level, threat.Reason);
					return new RL.CompanionStatusAck { Accepted = accepted }.ToByteArray();
				}

				case "CaptureCompanionFrame":
					throw new RpcException(FailedPrecondition, "The browser build draws on the page; use the tactical overview.");

				case "ExecuteCompanionActions":
				{
					var actions = RL.CompanionActionRequest.Parser.ParseFrom(request);
					var receipt = await CompanionBridge.ExecuteActions(actions);
					ActionsExecuted?.Invoke(receipt.RequestId, receipt.Accepted, receipt.Detail);
					return receipt.ToByteArray();
				}

				default:
					throw new RpcException(Unimplemented, $"{method} is not available in the browser build.");
			}
		}
	}
}
