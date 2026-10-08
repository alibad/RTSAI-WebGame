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
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using OpenRA.Network;

namespace OpenRA.WebSim
{
	/// <summary>
	/// In local mode, an in-process connection (like EchoConnection) delivers orders to the same frame,
	/// so an order issued between two ticks is executed on the very next tick. Orders still go through
	/// OrderPacket serialization exactly as on the network. Every frame's packet and the engine's per-frame
	/// SyncHash are recorded for native replay. In multiplayer, Poll and Inject exchange the same order bytes
	/// through a room relay, which compares hashes and gates each frame on both human packets.
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

		public int LocalClientId => NetworkClientId;
		public int NetworkClientId = ClientId;
		public bool Multiplayer;
		readonly Queue<string> outgoing = new();
		static readonly MethodInfo SendOrdersMethod = typeof(OrderManager).GetMethod("SendOrders", BindingFlags.Instance | BindingFlags.NonPublic);
		public string Poll()
		{
			// TryTick normally sends only once remote queues are non-empty. The HTTP frame barrier
			// needs every peer to submit first, so call its guarded send path before waiting.
			// Keep the engine untouched; this method is rooted with OrderManager in browser AOT.
			if (SendOrdersMethod == null) throw new InvalidOperationException("Incompatible OpenRA OrderManager: SendOrders is missing.");
			SendOrdersMethod.Invoke(orderManager, null);
			var result = "[" + string.Join(",", outgoing) + "]";
			outgoing.Clear();
			return result;
		}
		public void Inject(int client, int frame, string bytes) => orderManager.ReceiveOrders(client, (frame, new OrderPacket(new MemoryStream(Convert.FromBase64String(bytes)))));

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

			if (Multiplayer)
				outgoing.Enqueue($"{{\"kind\":\"orders\",\"frame\":{frame},\"data\":\"{Convert.ToBase64String(packet.Serialize(frame).AsSpan(4).ToArray())}\"}}");
			else
				orderManager.ReceiveOrders(ClientId, (frame, packet));
		}

		public void SendImmediate(IEnumerable<Order> orders)
		{
			if (!Multiplayer) immediateOrders.Enqueue(new OrderPacket(orders));
		}

		public void SendSync(int frame, int syncHash, ulong defeatState)
		{
			if (Multiplayer) outgoing.Enqueue($"{{\"kind\":\"hash\",\"frame\":{frame},\"hash\":{syncHash},\"defeat\":\"{defeatState}\"}}");
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
