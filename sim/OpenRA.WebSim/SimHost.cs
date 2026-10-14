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
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.RTSAI.Traits;
using OpenRA.Network;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Boots the real OpenRA engine + mod without the desktop game loop, window or audio, builds a World from a
	/// scenario and ticks it on demand. Used unchanged by the browser worker and by the native runner.
	/// </summary>
	public static class SimHost
	{
		public static string ModId { get; private set; } = "rtsai";

		public static string Root { get; private set; }
		public static ModData ModData => Game.ModData;
		public static World World { get; private set; }
		public static WorldRenderer WorldRenderer { get; private set; }
		public static OrderManager OrderManager { get; private set; }
		public static WebConnection Connection { get; private set; }
		public static ScenarioSpec Scenario { get; private set; }
		public static readonly Dictionary<string, double> Timings = [];

		static readonly List<Order> ScriptedOrders = [];

		public static string SetVoiceLanguage(string value)
		{
			Game.Settings.GetOrCreate<RTSAISettings>(null).VoiceLanguage = RTSAISettings.Normalize(value);
			return VoiceSettings();
		}

		public static string VoiceSettings() => "{\"language\":"
			+ Snapshot.Json(RTSAISettings.Normalize(Game.Settings.GetOrCreate<RTSAISettings>(null).VoiceLanguage))
			+ ",\"syncHash\":" + (World == null ? "null" : World.SyncHash().ToString())
			+ ",\"tick\":" + (World?.WorldTick ?? 0) + "}";

		public static string PreviewVoice()
		{
			var actor = World?.Selection.Actors.FirstOrDefault(a => a.IsInWorld && !a.IsDead && a.Owner == World.LocalPlayer
				&& a.TraitsImplementing<IVoiced>().Any(v => v.HasVoice(a, "Select")));
			if (actor == null) return "{\"error\":\"Select a local unit with a voice first.\"}";
			var voiced = actor.TraitsImplementing<IVoiced>().First(v => v.HasVoice(actor, "Select"));
			var family = voiced.VoiceSet;
			var rules = World.Map.Rules.Voices[family];
			var suffix = rules.Variants.TryGetValue(actor.Owner.Faction.InternalName, out var variants) && !rules.DisableVariants.Contains("Select")
				? variants[(int)(actor.ActorID % variants.Length)] : rules.DefaultVariant;
			var prefix = rules.Prefixes.TryGetValue(actor.Owner.Faction.InternalName, out var prefixes) && !rules.DisablePrefixes.Contains("Select")
				? prefixes[(int)(actor.ActorID % prefixes.Length)] : rules.DefaultPrefix;
			var files = string.Join(",", rules.Voices["Select"].Select(clip => Snapshot.Json(prefix + clip + suffix)));
			var played = voiced.PlayVoice(actor, "Select", actor.Owner.Faction.InternalName);
			return VoiceSettings().TrimEnd('}') + ",\"actor\":" + actor.ActorID + ",\"family\":" + Snapshot.Json(family)
				+ ",\"files\":[" + files + "],\"played\":" + (played ? "true" : "false") + "}";
		}

		/// <summary>Called before each load step (the browser forwards it to the page's loading screen).</summary>
		public static Action<string> OnProgress = _ => { };

		/// <summary>The WebAssembly memory size in MB (set by the browser host; 0 natively).</summary>
		public static Func<double> MemoryMB = () => 0;

		static void Time(string name, Action a)
		{
			OnProgress(name);
			var start = Stopwatch.GetTimestamp();
			var allocated = GC.GetTotalAllocatedBytes();
			a();
			Timings[name] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
			Timings["mem." + name] = MemoryMB();
			Timings["alloc." + name] = (GC.GetTotalAllocatedBytes() - allocated) / 1048576.0;
			Timings["live." + name] = GC.GetTotalMemory(false) / 1048576.0;
		}

		/// <summary>
		/// root/ora = engine dir (mods/common), root/mods = mod search dir (rtsai), root/support = support dir (Content/ra2).
		/// </summary>
		public static void Boot(string root, string supportDir = null, bool logFiles = true)
		{
			Root = root;
			var marker = Path.Combine(root, "ora", "MOD_ID");
			ModId = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "rtsai";
			if (ModId is not ("rtsai" or "rtsai-topdown")) throw new InvalidDataException("Unsupported standalone mode: " + ModId);
			AppContext.SetSwitch("OpenRA.EmbeddedModAssemblies", true);

			var engineDir = Path.Combine(root, "ora");
			supportDir ??= Path.Combine(root, "support");
			Directory.CreateDirectory(supportDir);
			Platform.OverrideEngineDir(engineDir);
			Platform.OverrideSupportDir(supportDir);

			// Settings are read from (never written to) the support dir.
			Game.InitializeSettings(new Arguments("Game.Platform=Null", "Game.FetchNews=false", "Debug.SendSystemInformation=false"));
			foreach (var channel in new[] { "perf", "debug", "server", "sound", "graphics", "geoip", "nat", "client", "lua", "exception" })
				Log.AddChannel(channel, logFiles ? channel + ".log" : null);

			InstalledMods mods = null;
			Time("boot.mods", () => mods = new InstalledMods([Path.Combine(engineDir, "mods"), Path.Combine(root, "mods")], []));
			if (!mods.TryGetValue(ModId, out var manifest))
				throw new InvalidOperationException($"Mod '{ModId}' not found under {root}/mods.");

			var platform = new WebPlatform();
			Game.Renderer = new Renderer(platform, Game.Settings.Graphics, manifest.RendererConstants.VertexBatchSize);

			// The UI sprite renderer draws in viewport px; captured draws from it are mapped back to world px.
			var shaderField = typeof(SpriteRenderer).GetField("shader", BindingFlags.NonPublic | BindingFlags.Instance);
			if (shaderField?.GetValue(Game.Renderer.SpriteRenderer) is WebShader ui)
				ui.UiSpace = true;
			Game.Sound = new Sound(platform, Game.Settings.Sound);

			Time("boot.moddata", () => Game.ModData = new ModData(manifest, mods, true));
			Time("boot.loaders", () =>
			{
				Game.ModData.InitializeLoaders(Game.ModData.DefaultFileSystem);
				Game.Renderer.InitializeFonts(Game.ModData);
			});

			// Registers the bundled maps (World looks its map up in the MapCache).
			Time("boot.maps", () => Game.ModData.MapCache.LoadMaps(Game.ModData));
		}

		/// <summary>A map's package path by its folder name, in any of the mod's MapFolders (e.g. ra2|standalone/maps).</summary>
		public static string MapPath(string mapName)
		{
			var generated = Path.Combine(Root, "mods", "rtsai", "web", "content", "maps", mapName);
			if (File.Exists(Path.Combine(generated, "map.yaml"))) return generated;
			return ModData.MapCache.FirstOrDefault(p => Path.GetFileName(p.Path) == mapName)?.Path
				?? Path.Combine(Root, "mods", ModId, "maps", mapName);
		}

		/// <summary>
		/// The VFS path of a game file that sits loose in a folder package (e.g. an audio file mounted lazily), or null
		/// when it is inside an archive or missing.
		/// </summary>
		public static string LoosePath(string filename)
		{
			if (ModData.DefaultFileSystem is OpenRA.FileSystem.FileSystem fs
				&& fs.TryGetPackageContaining(filename, out var package, out var name) && package is OpenRA.FileSystem.Folder folder)
				return Path.Combine(folder.Name, name).Replace(Path.DirectorySeparatorChar, '/');

			return null;
		}

		public static Map LoadMap(string path)
		{
			var package = ModData.ModFiles.OpenPackage(path) ?? throw new FileNotFoundException($"Map not found: {path}");
			var map = new Map(ModData, package);
			if (map.InvalidCustomRules)
				throw new InvalidDataException($"Map rules failed to load: {map.InvalidCustomRulesException}");

			return map;
		}

		public static Session BuildSession(ScenarioSpec s, Map map)
		{
			var session = new Session();
			session.GlobalSettings.Map = map.Uid;
			session.GlobalSettings.RandomSeed = s.Seed;
			session.GlobalSettings.NetFrameInterval = 1;
			session.GlobalSettings.GameTimestep = 40;
			session.GlobalSettings.EnableSingleplayer = !s.Multiplayer;
			session.GlobalSettings.GameUid = "web-" + s.Seed;

			foreach (var kv in s.Options)
				session.GlobalSettings.LobbyOptions[kv.Key] = new Session.LobbyOptionState { Value = kv.Value, PreferredValue = kv.Value, IsLocked = true };

			foreach (var pr in new MapPlayers(map.PlayerDefinitions).Players.Values.Where(p => p.Playable))
			{
				session.Slots[pr.Name] = new Session.Slot
				{
					PlayerReference = pr.Name,
					AllowBots = pr.AllowBots,
					LockFaction = pr.LockFaction,
					LockColor = pr.LockColor,
					LockTeam = pr.LockTeam,
					LockSpawn = pr.LockSpawn,
					Required = pr.Required,
				};
			}

			// Human IDs are 1 locally or 1 and 2 in multiplayer; client 1 controls all bots.
			var nextBot = s.Multiplayer ? Math.Max(2, s.Players.Where(p => p.Bot == null).Select(p => p.Client).DefaultIfEmpty(1).Max()) + 1 : WebConnection.ClientId + 1;
			foreach (var p in s.Players)
			{
				if (!session.Slots.ContainsKey(p.Slot))
					throw new InvalidDataException($"Map has no playable slot '{p.Slot}'.");

				var color = Color.TryParse(p.Color, out var c) ? c : Color.Red;
				var index = p.Bot == null ? (s.Multiplayer ? p.Client : WebConnection.ClientId) : nextBot++;
				session.Clients.Add(new Session.Client
				{
					Index = index,
					Name = p.Bot == null ? "Commander" : "AI " + p.Bot,
					Bot = p.Bot,
					BotControllerClientIndex = p.Bot == null ? 0 : WebConnection.ClientId,
					Slot = p.Slot,
					Faction = p.Faction,
					Color = color,
					PreferredColor = color,
					Team = p.Team,
					SpawnPoint = p.SpawnPoint,
					Handicap = p.Handicap,
					State = Session.ClientState.Ready,
					IsAdmin = p.Bot == null,
				});
			}

			if (!session.Clients.Any(c => c.Index == WebConnection.ClientId))
			{
				// Spectate when every seat is a bot.
				session.Clients.Add(new Session.Client
				{
					Index = WebConnection.ClientId,
					Name = "Spectator",
					Faction = "Random",
					Color = Color.White,
					State = Session.ClientState.Ready,
					IsAdmin = true,
				});
			}

			return session;
		}

		static Map preparedMap;
		static string preparedMapName;

		/// <summary>
		/// Loads a map with its rules, sequences and sprites ahead of Start (ModData.PrepareMap, split so each step is
		/// timed). The page calls it while the player is on the setup screen, so starting only builds the world.
		/// Render-side work only: the simulation's state is created by Start, so this cannot affect determinism.
		/// </summary>
		public static void Prepare(string mapName)
		{
			if (preparedMap != null && preparedMapName == mapName)
				return;

			// Another map was prepared and not started: free it before this one loads.
			DisposeMap(preparedMap);
			preparedMap = null;

			// Loading starts from a collected heap, so its allocations reuse freed memory instead of growing it (WebAssembly
			// memory never shrinks).
			Time("prepare.collect", () => GC.Collect());
			Map map = null;
			Time("prepare.map", () => map = LoadMap(MapPath(mapName)));

			// Sheets a sprite builder may still append to keep their CPU copy; the rest go to the page and are dropped.
			reopenCache = map.Sequences.SpriteCache;
			WebTexture.MayReopen = MayReopen;
			// With a sprite store (the browser, the baker), each faction's sprites get sheets of their own (PackGroups).
			if (SpriteCache.Store != null)
				Time("prepare.groups", () => SpriteCache.PackGroup = PackGroups.For(map));

			Time("prepare.loaders", () => ModData.InitializeLoaders(map));
			Time("prepare.sprites", () => map.Sequences.LoadSprites());
			Time("prepare.music", () =>
			{
				// ModData.PrepareMap parses every track (MusicInfo.Load) to learn its length, which only the desktop's
				// music player shows; in the browser that would download every track. The playlist only needs to know
				// that a track exists, which the file system answers without reading it.
				var exists = typeof(OpenRA.GameRules.MusicInfo).GetProperty(nameof(OpenRA.GameRules.MusicInfo.Exists));
				foreach (var entry in map.Rules.Music)
					exists.SetValue(entry.Value, map.Exists(entry.Value.Filename));
			});
			preparedMap = map;
			preparedMapName = mapName;
		}

		/// <summary>The prepared (or playing) map's sprite cache, for MayReopen; cleared with its map.</summary>
		static SpriteCache reopenCache;

		static bool MayReopen(WebTexture t)
		{
			if (reopenCache == null)
				return false;

			foreach (var sb in reopenCache.SheetBuilders.Values)
				if (sb.Current != null && SheetTexture(sb.Current) == t)
					return true;
			return false;
		}

		/// <summary>Map.Dispose frees its sheet builders' sheets; its restored prebaked sheets are freed here.</summary>
		static void DisposeMap(Map map)
		{
			if (map == null)
				return;

			ReleaseSprites(map.Sequences?.SpriteCache);
			map.Dispose();
		}

		/// <summary>Frees a disposed map's restored sheets and lets go of its sprite cache (MayReopen kept it reachable).</summary>
		static void ReleaseSprites(SpriteCache spriteCache)
		{
			SpriteStore.Release(spriteCache);
			if (reopenCache == spriteCache)
				reopenCache = null;
		}

		/// <summary>Managed memory still reachable after the last EndGame (its full collection), in MB.</summary>
		public static double RetainedAfterEndMB { get; private set; }

		static readonly FieldInfo SheetTextureField = typeof(Sheet).GetField("texture", BindingFlags.NonPublic | BindingFlags.Instance);

		/// <summary>A sheet's texture without committing it (GetTexture would upload pending data).</summary>
		static ITexture SheetTexture(Sheet s) => (ITexture)SheetTextureField.GetValue(s);

		/// <summary>Disposes the current game (world, renderer, order manager) so another can start.</summary>
		public static void EndGame()
		{
			Missions.Reset();
			if (World == null)
				return;

			Game.Sound.StopAudio();
			Game.Sound.StopMusic();
			WorldRenderer?.Dispose();
			var spriteCache = World.Map.Sequences?.SpriteCache;
			World.Dispose(); // disposes World.Map
			ReleaseSprites(spriteCache);
			OrderManager?.Dispose();
			World = null;
			WorldRenderer = null;
			OrderManager = null;
			Game.OrderManager = null;
			ScriptedOrders.Clear();

			// Nothing static may keep the ended world reachable, or it stays alive while the next map loads and the next
			// world is built (WebAssembly memory never shrinks, so such overlaps raise the tab's memory for good).
			Spawned.Clear();
			Snapshot.Reset();
			Sandbox.Forget();
			AiLab.Forget();
			EditorHost.Forget();
			Ui.Resync(); // its catalog text is cached per ActorInfo of the ended world's rules
			RetainedAfterEndMB = GC.GetTotalMemory(true) / 1048576.0;
		}

		/// <summary>Creates the world for a scenario. replayPackets (frame -> OrderPacket bytes) switches the connection to replay.</summary>
		public static void Start(ScenarioSpec s, Dictionary<int, byte[]> replayPackets = null)
		{
			EndGame();
			Scenario = s;
			Prepare(s.Map);
			var map = preparedMap;
			preparedMap = null;
			preparedMapName = null;

			Connection = new WebConnection { ReplayPackets = replayPackets, Multiplayer = s.Multiplayer, NetworkClientId = s.LocalClient };
			OrderManager = new OrderManager(Connection);
			Connection.Attach(OrderManager);
			Game.OrderManager = OrderManager;
			OrderManager.LobbyInfo = BuildSession(s, map);

			if (map.Grid.EnableDepthBuffer)
				Game.Renderer.SetDepthMargin(map.Rules.TerrainInfo.TileSize.Height * map.Grid.MaximumTerrainHeight);

			Time("start.world", () => World = OrderManager.World = new World(map, ModData, OrderManager, WorldType.Regular));
			Time("start.worldrenderer", () => WorldRenderer = new WorldRenderer(ModData, World));
			var wr = WorldRenderer;
			WebSoundEngine.ToScreen = p =>
			{
				var px = wr.ScreenPxPosition(p);
				return (px.X, px.Y);
			};

			Capture.ViewToWorld = (x, y) =>
			{
				var vp = WorldRenderer.Viewport;
				return (vp.TopLeft.X + x / vp.Zoom, vp.TopLeft.Y + y / vp.Zoom);
			};
			Time("start.loadcomplete", () => World.LoadComplete(WorldRenderer));

			if (s.Bare)
				RemoveStartingUnits();

			SpawnActors(s);
			GiveCash(s);

			OrderManager.StartGame();
			WorldRenderer.RefreshPalette();
			World.PostLoadComplete(WorldRenderer);

			if (s.Script == "battle")
				ScriptBattle();
			else
				ScriptOpening();

			Sandbox.Start(s.Sandbox ? PlayablePlayers() : null);
			if (s.Operation != null)
				Missions.StartOperation(s.Operation, Spawned.Where(x => !string.IsNullOrEmpty(x.Spec.Name) && !x.Actor.Disposed)
					.GroupBy(x => x.Spec.Name).ToDictionary(g => g.Key, g => g.First().Actor));
			else
				Missions.Start(s.Mission);
			AiLab.Start();

			// The load's garbage goes before play starts, so play allocates into a collected heap.
			Time("start.settle", () => GC.Collect());
		}

		/// <summary>
		/// Opens a map in the engine's editor world (WorldType.Editor, the desktop map editor's world: EditorActorLayer,
		/// EditorResourceLayer, EditorActionManager, the cursor layer) with a spectator session, like Game.LoadEditor.
		/// Nothing ticks; the browser's map editor drives it through EditorHost.
		/// </summary>
		public static void StartEditor(string mapName)
		{
			EndGame();
			Scenario = new ScenarioSpec { Map = mapName };
			Prepare(mapName);
			var map = preparedMap;
			preparedMap = null;
			preparedMapName = null;

			Connection = new WebConnection();
			OrderManager = new OrderManager(Connection);
			Connection.Attach(OrderManager);
			Game.OrderManager = OrderManager;
			var session = new Session();
			session.GlobalSettings.Map = map.Uid;
			session.GlobalSettings.RandomSeed = 1;
			session.GlobalSettings.EnableSingleplayer = true;
			session.Clients.Add(new Session.Client { Index = WebConnection.ClientId, Name = "Editor", Faction = "Random", Color = Color.White, State = Session.ClientState.Ready, IsAdmin = true });
			OrderManager.LobbyInfo = session;

			if (map.Grid.EnableDepthBuffer)
				Game.Renderer.SetDepthMargin(map.Rules.TerrainInfo.TileSize.Height * map.Grid.MaximumTerrainHeight);

			QuietEditorWidgets(map);
			Time("start.world", () => World = OrderManager.World = new World(map, ModData, OrderManager, WorldType.Editor));
			Time("start.worldrenderer", () => WorldRenderer = new WorldRenderer(ModData, World));
			Capture.ViewToWorld = (x, y) =>
			{
				var vp = WorldRenderer.Viewport;
				return (vp.TopLeft.X + x / vp.Zoom, vp.TopLeft.Y + y / vp.Zoom);
			};
			Time("start.loadcomplete", () => World.LoadComplete(WorldRenderer));
			OrderManager.StartGame();
			WorldRenderer.RefreshPalette();
			GC.Collect();
		}

		/// <summary>
		/// Data packed before the web rules overlay dropped LoadWidgetAtGameStart from the editor world (Bundle.cs) would
		/// build the desktop editor's widget tree on load, which needs the desktop chrome: its root becomes an empty container.
		/// </summary>
		static void QuietEditorWidgets(Map map)
		{
			var info = map.Rules.Actors[SystemActors.EditorWorld].TraitInfoOrDefault<LoadWidgetAtGameStartInfo>();
			if (info == null)
				return;
			var field = typeof(WidgetLoader).GetField("widgets", BindingFlags.NonPublic | BindingFlags.Instance);
			if (field?.GetValue(ModData.WidgetLoader) is Dictionary<string, MiniYamlNode> widgets)
				widgets[info.EditorRoot] = new MiniYamlNode("Container@" + info.EditorRoot, "");
		}

		static readonly List<(Actor Actor, SpawnSpec Spec)> Spawned = [];

		static void SpawnActors(ScenarioSpec s)
		{
			Spawned.Clear();
			var players = PlayablePlayers();
			foreach (var a in s.Spawns)
			{
				if (a.Player < 0 || a.Player >= players.Count)
					throw new InvalidDataException($"Spawn {a.Type}: no player {a.Player}.");

				var owner = players[a.Player];
				var init = new TypeDictionary
				{
					new OwnerInit(owner),
					new LocationInit(new MPos(a.X, a.Y).ToCPos(World.Map)),
					new FacingInit(new WAngle(a.Facing)),
					new FactionInit(owner.Faction.InternalName),
				};
				if (a.Health > 0 && a.Health < 100)
					init.Add(new HealthInit(a.Health));

				var actor = World.CreateActor(a.Type.ToLowerInvariant(), init);
				if (a.Level > 0)
					actor.TraitOrDefault<GainsExperience>()?.GiveLevels(a.Level, true);

				Spawned.Add((actor, a));
			}
		}

		/// <summary>
		/// A bare scenario keeps only its own spawns: the units SpawnStartingUnits gave each player at the map's start
		/// positions are taken out before the game starts (the same in the browser and the native runner).
		/// </summary>
		static void RemoveStartingUnits()
		{
			var players = PlayablePlayers();
			foreach (var a in World.Actors.Where(a => players.Contains(a.Owner) && a != a.Owner.PlayerActor && !a.Disposed).ToList())
			{
				if (a.IsInWorld)
					World.Remove(a);
				a.Dispose();
			}
		}

		/// <summary>Credits a scenario gives a player on top of the starting cash.</summary>
		static void GiveCash(ScenarioSpec s)
		{
			var players = PlayablePlayers();
			for (var i = 0; i < s.Players.Count && i < players.Count; i++)
				if (s.Players[i].Cash > 0)
					players[i].PlayerActor.TraitOrDefault<PlayerResources>()?.GiveCash(s.Players[i].Cash);
		}

		/// <summary>Playable players in scenario order (the order of ScenarioSpec.Players).</summary>
		public static List<Player> PlayablePlayers()
		{
			var result = new List<Player>();
			foreach (var p in Scenario.Players)
				result.Add(World.Players.First(pl => pl.PlayerReference.Playable && pl.InternalName == p.Slot));

			return result;
		}

		/// <summary>Scripted opening for the benchmark/fidelity battle: every unit attack-moves to the enemy group's centre.</summary>
		static void ScriptBattle()
		{
			var players = PlayablePlayers();
			var groups = players.Select(p => World.Actors.Where(a => a.Owner == p && a.IsInWorld && a.Info.HasTraitInfo<AttackMoveInfo>()).ToList()).ToList();
			for (var i = 0; i < groups.Count; i++)
			{
				var enemies = groups.Where((g, j) => j != i).SelectMany(g => g).ToList();
				if (enemies.Count == 0)
					continue;

				var target = new WPos((int)enemies.Average(a => (long)a.CenterPosition.X), (int)enemies.Average(a => (long)a.CenterPosition.Y), 0);
				var cell = World.Map.CellContaining(target);
				foreach (var a in groups[i])
					ScriptedOrders.Add(new Order("AttackMove", a, Target.FromCell(World, cell), false));
			}
		}

		/// <summary>
		/// Per-placement opening orders (the sandbox and Studio placements): "engage" attack-moves to the enemy group's
		/// centre, "hold" sets the Defend stance, "move" moves to the destination, "deploy" deploys. Issued on tick 1.
		/// </summary>
		static void ScriptOpening()
		{
			var players = PlayablePlayers();
			foreach (var (actor, spec) in Spawned)
			{
				if (actor.Disposed || !actor.IsInWorld)
					continue;

				switch (spec.Order)
				{
					case "engage":
					{
						var enemies = Spawned.Where(o => o.Spec.Player != spec.Player && !o.Actor.Disposed).Select(o => o.Actor).ToList();
						if (enemies.Count == 0 || !actor.Info.HasTraitInfo<AttackMoveInfo>())
							break;
						var target = new WPos((int)enemies.Average(a => (long)a.CenterPosition.X), (int)enemies.Average(a => (long)a.CenterPosition.Y), 0);
						ScriptedOrders.Add(new Order("AttackMove", actor, Target.FromCell(World, World.Map.CellContaining(target)), false));
						break;
					}

					case "hold":
						if (actor.Info.HasTraitInfo<AutoTargetInfo>())
							ScriptedOrders.Add(new Order("SetUnitStance", actor, false) { ExtraData = (uint)UnitStance.Defend });
						break;

					case "move":
						if (spec.DestX >= 0 && spec.DestY >= 0)
							ScriptedOrders.Add(new Order("Move", actor, Target.FromCell(World, new MPos(spec.DestX, spec.DestY).ToCPos(World.Map)), false));
						break;
				}

				if (spec.Deploy)
					foreach (var d in actor.TraitsImplementing<IIssueDeployOrder>())
						if (d.CanIssueDeployOrder(actor, false))
						{
							var o = d.IssueDeployOrder(actor, false);
							if (o != null)
								ScriptedOrders.Add(o);
						}
			}
		}

		/// <summary>One world tick at the engine's net-frame cadence (NetFrameInterval 1). Returns false if the world did not advance.</summary>
		public static bool Tick()
		{
			var world = World;
			if (ScriptedOrders.Count > 0)
			{
				foreach (var o in ScriptedOrders)
					world.IssueOrder(o);

				ScriptedOrders.Clear();
			}

			Sync.RunUnsynced(world, OrderManager.TickImmediate);
			var ticked = OrderManager.TryTick();
			if (ticked)
			{
				Sync.RunUnsynced(world, () => world.OrderGenerator.Tick(world));
				world.Tick();
				Missions.Tick(world);
				Sandbox.Tick(world);
				AiLab.Tick(world);
			}

			// TickRender updates the screen map (mouse/selection lookups) and render-only state.
			if (OrderManager.LocalFrameNumber > 0)
				Sync.RunUnsynced(world, () => world.TickRender(WorldRenderer));

			// Sound: music playlist and notification bookkeeping (Game.LogicTick does this on the desktop), music streams.
			Sync.RunUnsynced(world, () => Game.Sound.Tick());
			WebSoundEngine.Pump();

			return ticked;
		}

		// ---------------------------------------------------------------- input

		public static void Select(IEnumerable<uint> actorIds, bool additive)
		{
			var actors = actorIds.Select(id => World.GetActorById(id)).Where(a => a != null && a.IsInWorld && !a.IsDead).ToList();
			Sync.RunUnsynced(World, () => World.Selection.Combine(World, actors, additive, false));
		}

		/// <summary>The cell under a world-pixel position, accounting for terrain height (Viewport.ViewToWorld's algorithm).</summary>
		public static CPos CellAtWorldPx(int2 world)
		{
			var wr = WorldRenderer;
			var map = World.Map;
			var tileSize = map.Rules.TerrainInfo.TileSize;
			var tileScale = map.Grid.TileScale / 2;
			var minPos = wr.ProjectedPosition(world);

			MPos a, b;
			if (map.Grid.Type == MapGridType.RectangularIsometric)
			{
				a = map.CellContaining(minPos - new WVec(tileScale, 0, 0)).ToMPos(map.Grid.Type);
				b = map.CellContaining(minPos + new WVec(tileScale, tileScale * map.Grid.MaximumTerrainHeight, 0)).ToMPos(map.Grid.Type);
			}
			else
			{
				a = map.CellContaining(minPos).ToMPos(map.Grid.Type);
				b = map.CellContaining(minPos + new WVec(0, tileScale * map.Grid.MaximumTerrainHeight, 0)).ToMPos(map.Grid.Type);
			}

			var candidates = new List<MPos>();
			for (var v = b.V; v >= a.V; v--)
				for (var u = b.U; u >= a.U; u--)
					candidates.Add(new MPos(u, v));

			foreach (var uv in candidates)
			{
				var p = map.CenterOfCell(uv.ToCPos(map.Grid.Type));
				var s = wr.ScreenPxPosition(p);
				if (Math.Abs(s.X - world.X) <= tileSize.Width && Math.Abs(s.Y - world.Y) <= tileSize.Height)
				{
					var ramp = map.Grid.Ramps[map.Ramp.Contains(uv) ? map.Ramp[uv] : 0];
					var pos = map.CenterOfCell(uv.ToCPos(map)) - new WVec(0, 0, ramp.CenterHeightOffset);
					var screen = ramp.Corners.Select(c => wr.ScreenPxPosition(pos + c)).ToImmutableArray();
					if (screen.PolygonContains(world))
						return uv.ToCPos(map);
				}
			}

			if (candidates.Count > 0)
			{
				return candidates.MinBy(uv =>
				{
					var s = wr.ScreenPxPosition(map.CenterOfCell(uv.ToCPos(map.Grid.Type)));
					var dx = Math.Abs(s.X - world.X);
					var dy = Math.Abs(s.Y - world.Y);
					return dx * dx + dy * dy;
				}).ToCPos(map);
			}

			return map.CellContaining(wr.ProjectedPosition(world));
		}

		static MouseInput Mouse(int2 worldPx, MouseButton button, Modifiers mods)
		{
			// Order generators that draw at the cursor (building placement) read the mouse from the viewport.
			Viewport.LastMousePos = WorldRenderer.Viewport.WorldToViewPx(worldPx);
			return new MouseInput(MouseInputEvent.Down, button, Viewport.LastMousePos, int2.Zero, mods, 1);
		}

		/// <summary>Moves the engine's idea of the mouse (for previews drawn at the cursor) without an order.</summary>
		public static void MouseMove(int2 worldPx) => Viewport.LastMousePos = WorldRenderer.Viewport.WorldToViewPx(worldPx);

		/// <summary>The cursor the game would show for the current selection at this world pixel.</summary>
		public static string Cursor(int2 worldPx, Modifiers mods, bool minimap = false)
		{
			var world = World;
			return Sync.RunUnsynced(world, () =>
			{
				var cell = CellAtWorldPx(worldPx);
				var mi = Mouse(worldPx, world.OrderGenerator.ActionButton, mods);
				var cursor = world.OrderGenerator.GetCursor(world, cell, worldPx, mi);
				if (cursor == null)
					return "default";

				// RadarWidget.GetCursor: the minimap variant where the mod has one.
				return minimap && Game.ModData.Cursors.ContainsKey(cursor + "-minimap") ? cursor + "-minimap" : cursor;
			});
		}

		/// <summary>Resolves a click exactly like WorldInteractionControllerWidget.ApplyOrders and queues the orders.</summary>
		public static int Click(int2 worldPx, MouseButton button, Modifiers mods)
		{
			var world = World;
			return Sync.RunUnsynced(world, () =>
			{
				var cell = CellAtWorldPx(worldPx);
				var orders = world.OrderGenerator.Order(world, cell, worldPx, Mouse(worldPx, button, mods)).Where(o => o != null).ToArray();
				var flashed = false;
				foreach (var o in orders)
				{
					if (!flashed && !o.SuppressVisualFeedback)
					{
						var visualTarget = o.VisualFeedbackTarget.Type != TargetType.Invalid ? o.VisualFeedbackTarget : o.Target;
						foreach (var notify in world.WorldActor.TraitsImplementing<INotifyOrderIssued>())
							flashed = notify.OrderIssued(world, o.OrderString, visualTarget);
					}

					world.IssueOrder(o);
				}

				// WorldInteractionControllerWidget.ApplyOrders: acknowledge with the first voiced subject.
				orders.PlayVoiceForOrders();
				return orders.Length;
			});
		}

		public static int Stop()
		{
			var selected = World.Selection.Actors.Where(a => a.IsInWorld && !a.IsDead && a.Owner == World.LocalPlayer).ToList();
			foreach (var a in selected)
				World.IssueOrder(new Order("Stop", a, false));

			return selected.Count;
		}

		/// <summary>Issues an order on behalf of a scripted player (bot-controlled slots accept orders from client 1).</summary>
		public static void IssueScripted(Order o) => ScriptedOrders.Add(o);

		// ---------------------------------------------------------------- introspection for the renderer

		static FieldInfo hardwarePaletteField;

		public static HardwarePalette Palette
		{
			get
			{
				hardwarePaletteField ??= typeof(WorldRenderer).GetField("palette", BindingFlags.NonPublic | BindingFlags.Instance);
				return (HardwarePalette)hardwarePaletteField.GetValue(WorldRenderer);
			}
		}

		public static int SyncHash => World.SyncHash();
	}
}
