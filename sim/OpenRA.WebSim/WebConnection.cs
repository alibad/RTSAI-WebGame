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

using System.Collections.Generic;
using System.IO;
using OpenRA.Network;

namespace OpenRA.WebSim
{
	/// <summary>
	/// A local, in-process connection (like EchoConnection) that delivers a frame's orders to the same frame,
	/// so an order issued between two ticks is executed on the very next tick. Orders still go through
	/// OrderPacket serialization exactly as on the network. Every frame's packet and the engine's per-frame
	/// SyncHash are recorded: the packets replay the session natively, the hashes prove the two runs match.
	/// </summary>
	public sealed class WebConnection : IConnection
	{
		public const int ClientId = 1;

		readonly Queue<OrderPacket> immediateOrders = [];
		OrderManager orderManager;
		bool disposed;

		/// <summary>Frame number -> serialized OrderPacket (only frames that carried orders).</summary>
		public readonly Dictionary<int, byte[]> RecordedPackets = [];

		/// <summary>Index i holds the SyncHash the engine computed for net frame i + 1.</summary>
		public readonly List<int> SyncHashes = [];

		/// <summary>When set, orders for these frames are injected instead of the locally issued ones (native replay).</summary>
		public Dictionary<int, byte[]> ReplayPackets;

		public int LocalClientId => ClientId;

		public void Attach(OrderManager orderManager)
		{
			this.orderManager = orderManager;
		}

		public void StartGame() { }

		public void Send(int frame, IEnumerable<Order> orders)
		{
			OrderPacket packet;
			if (ReplayPackets != null)
				packet = ReplayPackets.TryGetValue(frame, out var data) ? new OrderPacket(new MemoryStream(data)) : new OrderPacket([]);
			else
			{
				// Same bytes as OrderPacket(IEnumerable<Order>): each order serialized back to back.
				var ms = new MemoryStream();
				foreach (var o in orders)
					ms.Write(o.Serialize());

				var data = ms.ToArray();
				if (data.Length > 0)
					RecordedPackets[frame] = data;

				packet = new OrderPacket(new MemoryStream(data));
			}

			orderManager.ReceiveOrders(ClientId, (frame, packet));
		}

		public void SendImmediate(IEnumerable<Order> orders)
		{
			immediateOrders.Enqueue(new OrderPacket(orders));
		}

		public void SendSync(int frame, int syncHash, ulong defeatState)
		{
			while (SyncHashes.Count < frame - 1)
				SyncHashes.Add(0);

			if (SyncHashes.Count == frame - 1)
				SyncHashes.Add(syncHash);
		}

		public void Receive(OrderManager orderManager)
		{
			while (immediateOrders.TryDequeue(out var i))
			{
				orderManager.ReceiveImmediateOrders(ClientId, i);
				if (disposed)
					break;
			}
		}

		public void Dispose()
		{
			disposed = true;
		}
	}
}
