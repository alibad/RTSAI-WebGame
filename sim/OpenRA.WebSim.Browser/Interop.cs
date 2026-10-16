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
using System.Runtime.InteropServices;
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

		[JSImport("soundSource", "websim")]
		static partial void SoundSource(int id, int channels, int bits, int rate, [JSMarshalAs<JSType.MemoryView>] Span<byte> pcm);

		[JSImport("soundPlay", "websim")]
		static partial void SoundPlay(int sound, int source, bool loop, bool relative, double x, double y, double volume, bool attenuate);

		[JSImport("soundStream", "websim")]
		static partial void SoundStream(int sound, int channels, int bits, int rate, [JSMarshalAs<JSType.MemoryView>] Span<byte> pcm, bool end, double volume);

		[JSImport("soundStop", "websim")]
		static partial void SoundStop(int sound);

		[JSImport("soundVolume", "websim")]
		static partial void SoundVolume(int sound, double volume);

		[JSImport("soundPause", "websim")]
		static partial void SoundPause(int sound, bool paused);

		sealed class AudioSink : WebSoundEngine.IAudioSink
		{
			public void Source(int id, int channels, int bits, int rate, ReadOnlySpan<byte> pcm) => SoundSource(id, channels, bits, rate, MemoryMarshal.CreateSpan(ref MemoryMarshal.GetReference(pcm), pcm.Length));
			public void Play(int sound, int source, bool loop, bool relative, float x, float y, float volume, bool attenuate) => SoundPlay(sound, source, loop, relative, x, y, volume, attenuate);
			public void Stream(int sound, int channels, int bits, int rate, ReadOnlySpan<byte> pcm, bool end, float volume) => SoundStream(sound, channels, bits, rate, MemoryMarshal.CreateSpan(ref MemoryMarshal.GetReference(pcm), pcm.Length), end, volume);
			public void Stop(int sound) => SoundStop(sound);
			public void Volume(int sound, float volume) => SoundVolume(sound, volume);
			public void Pause(int sound, bool paused) => SoundPause(sound, paused);
		}

		[JSImport("spriteLoad", "websim")]
		internal static partial byte[] SpriteLoad(string key);

		[JSImport("spriteSaved", "websim")]
		static partial void SpriteSaved(string key, byte[] table, [JSMarshalAs<JSType.Array<JSType.Number>>] int[] textureIds);

		[JSImport("spriteRestored", "websim")]
		static partial void SpriteRestored(string key, [JSMarshalAs<JSType.Array<JSType.Number>>] int[] textureIds);

		[JSImport("audioReady", "websim")]
		internal static partial bool AudioReady(string path);

		[JSImport("textureFree", "websim")]
		static partial void TextureFree(int id);

		[JSImport("memoryBytes", "websim")]
		internal static partial double MemoryBytes();

		[JSImport("companionReply", "websim")]
		static partial void CompanionReply(int call, int code, string message, [JSMarshalAs<JSType.MemoryView>] Span<byte> payload);

		[JSImport("companionEvent", "websim")]
		static partial void CompanionEvent(string json);

		[JSImport("texture", "websim")]
		static partial void StreamTexture(int id, int version, int width, int height, [JSMarshalAs<JSType.MemoryView>] Span<byte> data);

		/// <summary>The co-commander for the next match (its CompanionBridge publishes observations and takes actions).</summary>
		[JSExport]
		public static void CompanionEnable(bool on) => CompanionRpc.Enable(on);

		/// <summary>The co-commander's latest observation (rl_bridge GameObservation), or empty.</summary>
		[JSExport]
		public static byte[] CompanionObservation() => CompanionRpc.Observation();

		/// <summary>One relayed companion RPC (protobuf in, protobuf out); answered through companionReply.</summary>
		[JSExport]
		public static void CompanionCall(int call, string method, byte[] request) => _ = CompanionCallAsync(call, method, request);

		static async System.Threading.Tasks.Task CompanionCallAsync(int call, string method, byte[] request)
		{
			byte[] reply = [];
			var code = 0;
			var message = "";
			try
			{
				reply = await CompanionRpc.Call(method, request);
			}
			catch (CompanionRpc.RpcException e)
			{
				code = e.Code;
				message = e.Message;
			}
			catch (Exception e)
			{
				code = 13;
				message = e.Message;
			}

			CompanionReply(call, code, message, reply);
		}

		/// <summary>Routes load-step progress to the page (Mount does this too; the worker mounts files itself).</summary>
		[JSExport]
		public static void SetProgress()
		{
			SimHost.OnProgress = Progress;
			WebSoundEngine.Sink = new AudioSink();

			// Prebaked sprite sheets, kept by the page between sessions.
			OpenRA.Graphics.SpriteCache.Store = new SpriteStore();
			SpriteStore.Load = SpriteLoad;
			SpriteStore.Saved = SpriteSaved;
			SpriteStore.Restored = SpriteRestored;

			// The AI co-commander's status, threat and executed actions, for the page's panel.
			CompanionRpc.StatusChanged = (state, message) =>
				CompanionEvent($"{{\"kind\":\"status\",\"state\":{Snapshot.Json(state)},\"message\":{Snapshot.Json(message)}}}");
			CompanionRpc.ThreatChanged = (score, level, reason) =>
				CompanionEvent($"{{\"kind\":\"threat\",\"score\":{score},\"level\":{Snapshot.Json(level)},\"reason\":{Snapshot.Json(reason)}}}");
			CompanionRpc.ActionsExecuted = (id, accepted, detail) =>
				CompanionEvent($"{{\"kind\":\"executed\",\"id\":{Snapshot.Json(id)},\"accepted\":{(accepted ? "true" : "false")},\"detail\":{Snapshot.Json(detail)}}}");

			// Audio files come over the network: a sound that is not fetched yet is skipped and music waits for its file,
			// both fetched in the background, so the game never stalls on audio (Sound.AudioReady). A sound the game files
			// do not have at all is skipped for good, and logged once (SimHost.GateAudio): loading it would throw.
			SimHost.GateAudio(AudioReady);

			// Textures the engine disposes (a finished game's sheets) are deleted on the page's GPU too.
			WebTexture.Freed = TextureFree;
			// Pages older than this import report 0 instead of failing every timed load step.
			SimHost.MemoryMB = () =>
			{
				try { return MemoryBytes() / 1048576.0; }
				catch (Exception) { return 0; }
			};

			// Sheets go to the page as soon as the engine commits them (during map preparation, on the setup
			// screen), so the WebAssembly heap keeps no copy of them.
			WebTexture.Stream = (t, data) =>
			{
				// Sprite and terrain sheets only (the palette changes every frame and is sent when it really changes).
				if (t.Size.Width < 512 || t.Size.Height < 512)
					return false;

				StreamTexture(t.Id, t.Version, t.Size.Width, t.Size.Height, data.AsSpan(0, Math.Min(data.Length, 4 * t.Size.Width * t.Size.Height)));
				Snapshot.TextureStreamed(t);
				return true;
			};
		}

		[JSExport]
		public static int Mount(byte[] pack)
		{
			SimHost.OnProgress = Progress;
			return Pack.Unpack(pack, Root);
		}

		[JSExport]
		public static string SetVoiceLanguage(string value) => SimHost.SetVoiceLanguage(value);

		[JSExport]
		public static string VoiceSettings() => SimHost.VoiceSettings();

		[JSExport]
		public static string PreviewVoice() => SimHost.PreviewVoice();

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
			MatchRestore.Start(scenarioJson);
			return Snapshot.StartInfoJson(out terrain);
		}

		/// <summary>Opens the map editor on a map (or a new blank one): {"id", "info"} like Start's start info.</summary>
		[JSExport]
		public static string EditorOpen(string json)
		{
			Snapshot.Reset();
			Ui.Resync();
			var id = EditorHost.Open(json);
			var info = Snapshot.StartInfoJson(out terrain);
			return $"{{\"id\":{Snapshot.Json(id)},\"info\":{info}}}";
		}

		/// <summary>One map editor request (EditorHost.Call): brush, pointer, undo, redo, delete, save, catalog.</summary>
		[JSExport]
		public static string EditorCall(string json) => EditorHost.Call(json);

		/// <summary>Terrain vertex rows the editor changed since the last call: [first row][vertices], or empty.</summary>
		[JSExport]
		public static byte[] EditorTerrain() => EditorHost.TerrainChanges();

		/// <summary>
		/// Everything a player can build and each faction's roster, from the mod's rules (no world needed): the battle
		/// simulator's drawer and the Earth missions read it once.
		/// </summary>
		[JSExport]
		public static string Catalog()
		{
			var units = Ui.UnitCatalog(SimHost.ModData.DefaultRules);
			var rosters = Ui.Rosters(SimHost.ModData.DefaultRules);
			return "{" + units[1..^1] + "," + rosters[1..^1] + "}";
		}

		/// <summary>Factions, maps and bot types for the setup screen.</summary>
		[JSExport]
		public static string Setup() => SetupInfo.Json();

		[JSExport]
		public static byte[] MapPreview(string mapId) => SetupInfo.Preview(mapId);

		/// <summary>A random map from the engine's map generator: its id and files, for the page to mount (MapGen).</summary>
		[JSExport]
		public static string GenerateMap(string json) => MapGen.Generate(json);

		/// <summary>A real place's hills and valleys on a map from the Earth compiler: its new files (Relief).</summary>
		[JSExport]
		public static string ReliefMap(string json) => Relief.Apply(json);

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

		[JSExport]
		public static void PauseAudio(bool paused) => WebSoundEngine.PauseAll(paused);

		/// <summary>A cameo sprite (sheet, channel, uv, size, palette row) as JSON, or "" when the actor has none.</summary>
		[JSExport]
		public static string Icon(string actor) => Ui.Icon(actor);

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

		/// <summary>Debugging: every texture as id:widthxheight:MB(:rt).</summary>
		[JSExport]
		public static string TextureInfo() => string.Join(" ", WebTexture.All.Select(t => $"{t.Id}:{t.Size.Width}x{t.Size.Height}:{(t.Data?.Length ?? 0) / 1048576.0:F0}{(t.IsRenderTarget ? ":rt" : "")}"));

		/// <summary>Ids of model vertex buffers changed since they were last fetched, comma separated.</summary>
		[JSExport]
		public static string ChangedModelBuffers() => string.Join(",", Snapshot.ChangedModelBuffers());

		[JSExport]
		public static byte[] ModelBuffer(int id) => Snapshot.ModelBuffer(id);

		[JSExport]
		public static byte[] Terrain() => terrain;

		/// <summary>Serialize local orders and drain synchronization reports for the room relay.</summary>
		[JSExport]
		public static string NetworkPoll() => SimHost.Connection.Poll();

		[JSExport]
		public static void NetworkInject(int client, int frame, string bytes) => SimHost.Connection.Inject(client, frame, bytes);

		/// <summary>One simulation tick, then publish the snapshot into the shared ring.</summary>
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

		/// <summary>A snapshot of the current world without advancing it (paused game, sandbox editing, camera moves).</summary>
		[JSExport]
		public static void Refresh()
		{
			var world = SimHost.World;
			if (world == null)
				return;
			Sync.RunUnsynced(world, () => world.TickRender(SimHost.WorldRenderer));
			Snapshot.Build();
			Publish(Snapshot.Segment.AsSpan());
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
			var data = t.Data ?? [];
			Snapshot.TextureSent(id);
			return data;
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
		public static string Cursor(int x, int y, int modifiers) => SimHost.Cursor(new int2(x, y), (Modifiers)(modifiers & 0xFFFF), (modifiers & 0x10000) != 0);

		[JSExport]
		public static byte[] CursorSet() => Ui.CursorSet();

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
				$"\"textures\":{WebTexture.All.Count},\"textureMB\":{WebTexture.All.Sum(t => (long)(t.Data?.Length ?? 0)) / 1048576.0:F1}," +
				$"\"droppedReads\":{WebTexture.DroppedReads},\"heapSizeMB\":{GC.GetGCMemoryInfo().HeapSizeBytes / 1048576.0:F1},\"fragmentedMB\":{GC.GetGCMemoryInfo().FragmentedBytes / 1048576.0:F1}," +
				$"\"totalAllocatedMB\":{GC.GetTotalAllocatedBytes() / 1048576.0:F0}," +
				$"\"retainedAfterEndMB\":{SimHost.RetainedAfterEndMB:F1}," +
				$"\"framework\":\"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\"" +
				"}";
		}

		static string Timings() => "{" + string.Join(",", SimHost.Timings.Select(kv => $"\"{kv.Key}\":{kv.Value:F1}")) + "}";
	}
}
