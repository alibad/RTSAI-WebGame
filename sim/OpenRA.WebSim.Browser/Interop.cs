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
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;

[assembly: SupportedOSPlatform("browser")]

namespace OpenRA.WebSim.Browser
{
	public static class Program
	{
		public static void Main()
		{
			Console.WriteLine($"OpenRA.WebSim ready ({System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription})");
		}
	}

	/// <summary>The worker-facing API. All calls run on the worker's single .NET thread, between ticks.</summary>
	public static partial class Interop
	{
		const string Root = "/vfs";
		static byte[] terrain = [];

		[JSImport("publish", "websim")]
		static partial void Publish([JSMarshalAs<JSType.MemoryView>] Span<byte> snapshot);

		[JSImport("progress", "websim")]
		static partial void Progress(string step);

		[JSExport]
		public static int Mount(byte[] pack)
		{
			SimHost.OnProgress = Progress;
			return Pack.Unpack(pack, Root);
		}

		[JSExport]
		public static string Boot()
		{
			SimHost.Boot(Root);
			return Timings();
		}

		[JSExport]
		public static string Start(string scenarioJson)
		{
			Snapshot.Reset();
			SimHost.Start(ScenarioSpec.Parse(scenarioJson));
			return Snapshot.StartInfoJson(out terrain);
		}

		[JSExport]
		public static byte[] Terrain() => terrain;

		/// <summary>One simulation tick, then the snapshot is handed to JS (copied into the shared ring there).</summary>
		[JSExport]
		public static double Tick()
		{
			var start = Stopwatch.GetTimestamp();
			SimHost.Tick();
			var ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
			Snapshot.LastTickMs = ms;
			Snapshot.Build();
			Publish(Snapshot.Segment.AsSpan());
			return ms;
		}

		/// <summary>Runs ticks without building snapshots (benchmarks). Returns total sim milliseconds.</summary>
		[JSExport]
		public static double TickMany(int count)
		{
			var start = Stopwatch.GetTimestamp();
			for (var i = 0; i < count; i++)
				SimHost.Tick();

			return Stopwatch.GetElapsedTime(start).TotalMilliseconds;
		}

		[JSExport]
		public static byte[] Texture(int id)
		{
			var t = WebTexture.All[id];
			return t.Data ?? [];
		}

		[JSExport]
		public static void View(int x0, int y0, int x1, int y1) => Snapshot.SetView(x0, y0, x1, y1);

		/// <summary>idsJson: a JSON array of actor ids (from the page's box/click selection).</summary>
		[JSExport]
		public static void Select(string idsJson, bool additive)
		{
			var ids = System.Text.Json.JsonDocument.Parse(idsJson).RootElement.EnumerateArray().Select(e => e.GetUInt32()).ToList();
			SimHost.Select(ids, additive);
		}

		[JSExport]
		public static int Click(int x, int y, int button, int modifiers) =>
			SimHost.Click(new int2(x, y), (MouseButton)button, (Modifiers)modifiers);

		[JSExport]
		public static string Cursor(int x, int y, int modifiers) => SimHost.Cursor(new int2(x, y), (Modifiers)modifiers);

		[JSExport]
		public static int Stop() => SimHost.Stop();

		[JSExport]
		public static void Resync() => Snapshot.Resync();

		[JSExport]
		public static int SyncHash() => SimHost.SyncHash;

		[JSExport]
		public static string SessionLog() => OpenRA.WebSim.SessionLog.Write(SimHost.Scenario, SimHost.Connection);

		[JSExport]
		public static string Stats()
		{
			var world = SimHost.World;
			var units = world == null ? 0 : world.Actors.Count(a => a.IsInWorld && a.Owner.Playable && a.Info.HasTraitInfo<MobileInfo>());
			return "{" +
				$"\"managedMB\":{GC.GetTotalMemory(false) / 1048576.0:F1}," +
				$"\"tick\":{world?.WorldTick ?? 0}," +
				$"\"units\":{units}," +
				$"\"textures\":{WebTexture.All.Count}," +
				$"\"framework\":\"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\"" +
				"}";
		}

		static string Timings() => "{" + string.Join(",", SimHost.Timings.Select(kv => $"\"{kv.Key}\":{kv.Value:F1}")) + "}";
	}
}
