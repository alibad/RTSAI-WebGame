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
using Linguini.Bundle;
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
			Ui.Resync();
			SimHost.Start(ScenarioSpec.Parse(scenarioJson));
			return Snapshot.StartInfoJson(out terrain);
		}

		/// <summary>Factions, maps and bot types for the setup screen.</summary>
		[JSExport]
		public static string Setup() => SetupInfo.Json();

		[JSExport]
		public static byte[] MapPreview(string mapId) => SetupInfo.Preview(mapId);

		/// <summary>Loads a map's rules, sequences and sprites ahead of Start (called from the setup screen).</summary>
		[JSExport]
		public static string Prepare(string mapId)
		{
			SimHost.Prepare(mapId);
			return Timings();
		}

		[JSExport]
		public static void EndGame()
		{
			SimHost.EndGame();
			Snapshot.Reset();
		}

		/// <summary>Per-tick UI state (credits, power, radar, queues, selection, control groups, catalog when changed).</summary>
		[JSExport]
		public static string UiState() => Ui.State();

		[JSExport]
		public static void UiResync() => Ui.Resync();

		[JSExport]
		public static string Command(string json) => Ui.Command(json);

		/// <summary>A cameo as [w][h][rgba...] (empty when the actor has no icon).</summary>
		[JSExport]
		public static byte[] Icon(string actor) => Ui.Icon(actor);

		/// <summary>Shroud cells (0/1/2) when changed since the last call, else empty.</summary>
		[JSExport]
		public static byte[] Shroud(bool force) => Ui.Shroud(force) ?? [];

		[JSExport]
		public static byte[] RadarTerrain() => Ui.RadarTerrain();

		/// <summary>Radar blips as little-endian int32 triples (u, v, argb).</summary>
		[JSExport]
		public static byte[] RadarBlips() => System.Runtime.InteropServices.MemoryMarshal.AsBytes(Ui.RadarBlips().AsSpan()).ToArray();

		[JSExport]
		public static void MouseMove(int x, int y) => SimHost.MouseMove(new int2(x, y));

		/// <summary>Ids of model vertex buffers changed since they were last fetched, comma separated.</summary>
		[JSExport]
		public static string ChangedModelBuffers() => string.Join(",", Snapshot.ChangedModelBuffers());

		[JSExport]
		public static byte[] ModelBuffer(int id) => Snapshot.ModelBuffer(id);

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

		/// <summary>idsJson: a JSON array of actor ids (from the page's box/click selection). Returns the engine's selection.</summary>
		[JSExport]
		public static string Select(string idsJson, bool additive)
		{
			var ids = System.Text.Json.JsonDocument.Parse(idsJson).RootElement.EnumerateArray().Select(e => e.GetUInt32()).ToList();
			SimHost.Select(ids, additive);
			return "{\"selection\":[" + string.Join(",", SimHost.World.Selection.Actors.Where(a => a.IsInWorld).Select(a => a.ActorID)) + "]}";
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
		public static int WorldTick() => SimHost.World?.WorldTick ?? 0;

		/// <summary>Debugging: formats a Fluent message with a plural selector the way Player.ResolvePlayerName does.</summary>
		[JSExport]
		public static string DebugFluent()
		{
			try
			{
				var b = Linguini.Bundle.Builder.LinguiniBuilder.Builder()
					.CultureInfo(new System.Globalization.CultureInfo("en"))
					.SkipResources().SetUseIsolating(false).UseConcurrent().UncheckedBuild();
				b.AddResourceOverriding(new Linguini.Syntax.Parser.LinguiniParser("t = { $name } { $number ->\n   *[zero] {\"\"}\n    [other] { $number }\n}\n").Parse());
				var args = new System.Collections.Generic.Dictionary<string, Linguini.Shared.Types.Bundle.IFluentType>
				{
					["name"] = "X".ToFluentType(),
					["number"] = 1.ToFluentType(),
				};
				var ok = b.TryGetAttrMessage("t", args, out var errors, out var value);
				return $"ok={ok} value='{value}' errors={string.Join(";", errors)}";
			}
			catch (Exception e)
			{
				return e.ToString();
			}
		}

		/// <summary>Debugging: a text file from the in-memory filesystem (e.g. support/Logs/debug.log), or "".</summary>
		[JSExport]
		public static string ReadText(string path)
		{
			var full = path.StartsWith('/') ? path : System.IO.Path.Combine(Root, path);
			return System.IO.File.Exists(full) ? System.IO.File.ReadAllText(full) : "";
		}

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
