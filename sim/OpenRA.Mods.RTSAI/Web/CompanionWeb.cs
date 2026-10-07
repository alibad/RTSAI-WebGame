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

// Web build stand-ins for the desktop-only parts of the AI co-commander. The mod's CompanionBridge,
// ObservationSerializer and ActionHandler compile unchanged; what they call on the desktop's Kestrel gRPC host,
// the sidecar process manager and the in-game widget logic is replaced here. In the browser the page's host
// (OpenRA.WebSim.CompanionRpc) answers the companion's RPCs, relayed from the local companion over a WebSocket.

using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("OpenRA.WebSim")]

namespace OpenRA.Mods.RTSAI.Companion
{
	public enum CompanionHostState
	{
		NotStarted,
		External,
		Off,
		Missing,
		Starting,
		Running,
		Restarting,
		Failed
	}

	/// <summary>No sidecar process in the browser: the page starts the companion (OPENRA_AI_COMPANION=1).</summary>
	public static class CompanionHost
	{
		public static CompanionHostState State => CompanionHostState.External;
		public static bool Managed => false;
		public static int VoicePackProgress => -1;

		public static bool TryGetHudOverride(bool acknowledged, out string state, out string message)
		{
			state = null;
			message = null;
			return false;
		}
	}
}

namespace OpenRA.Mods.RTSAI.Traits
{
	/// <summary>The browser host relays the companion's RPCs itself; there is no in-process gRPC server.</summary>
	public static class CompanionGrpcHost
	{
		public static bool Available { get; private set; }

		public static void Start(int port)
		{
			Available = true;
		}
	}

	public static class CompanionLog
	{
		public const string Channel = "companion";

		public static void Ensure()
		{
			Log.AddChannel(Channel, "companion.log");
		}
	}
}

namespace OpenRA.Mods.RTSAI.Widgets.Logic
{
	/// <summary>The one helper of the desktop AI strip that CompanionBridge uses (same rule as the mod's).</summary>
	public static class AIControlDisplay
	{
		public static bool IsExplicitManualModeState(string state)
		{
			if (string.IsNullOrWhiteSpace(state))
				return false;

			var separator = state.IndexOf(':');
			var lifecycle = separator < 0 ? state : state[..separator];
			return lifecycle == "disabled" || (lifecycle == "ready" && separator >= 0);
		}
	}
}
