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
		public const string ModId = "rtsai";

		public static string Root { get; private set; }
		public static ModData ModData => Game.ModData;
		public static World World { get; private set; }
		public static WorldRenderer WorldRenderer { get; private set; }
		public static OrderManager OrderManager { get; private set; }
		public static WebConnection Connection { get; private set; }
		public static ScenarioSpec Scenario { get; private set; }
		public static readonly Dictionary<string, double> Timings = [];

		static readonly List<Order> ScriptedOrders = [];

		/// <summary>Called before each load step (the browser forwards it to the page's loading screen).</summary>
		public static Action<string> OnProgress = _ => { };

		static void Time(string name, Action a)
		{
			OnProgress(name);
			var start = Stopwatch.GetTimestamp();
			a();
			Timings[name] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
		}

		/// <summary>
		/// root/ora = engine dir (mods/common), root/mods = mod search dir (rtsai), root/support = support dir (Content/ra2).
		/// </summary>
		public static void Boot(string root, string supportDir = null, bool logFiles = true)
		{
			Root = root;
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
			session.GlobalSettings.EnableSingleplayer = true;
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

			// Client 1 is the local human (the connection's LocalClientId); bots get 2, 3, ... and are driven by client 1.
			var nextBot = WebConnection.ClientId + 1;
			foreach (var p in s.Players)
			{
				if (!session.Slots.ContainsKey(p.Slot))
					throw new InvalidDataException($"Map has no playable slot '{p.Slot}'.");

				var color = Color.TryParse(p.Color, out var c) ? c : Color.Red;
				var index = p.Bot == null ? WebConnection.ClientId : nextBot++;
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

		/// <summary>Creates the world for a scenario. replayPackets (frame -> OrderPacket bytes) switches the connection to replay.</summary>
		public static void Start(ScenarioSpec s, Dictionary<int, byte[]> replayPackets = null)
		{
			Scenario = s;
			Map map = null;
			Time("start.map", () => map = LoadMap(Path.Combine(Root, "mods", ModId, "maps", s.Map)));

			Connection = new WebConnection { ReplayPackets = replayPackets };
			OrderManager = new OrderManager(Connection);
			Connection.Attach(OrderManager);
			Game.OrderManager = OrderManager;
			OrderManager.LobbyInfo = BuildSession(s, map);

			// ModData.PrepareMap, split so each step is timed separately.
			Time("start.loaders", () => ModData.InitializeLoaders(map));
			Time("start.sprites", () => map.Sequences.LoadSprites());
			Time("start.music", () =>
			{
				foreach (var entry in map.Rules.Music)
					entry.Value.Load(map);
			});
			if (map.Grid.EnableDepthBuffer)
				Game.Renderer.SetDepthMargin(map.Rules.TerrainInfo.TileSize.Height * map.Grid.MaximumTerrainHeight);

			Time("start.world", () => World = OrderManager.World = new World(map, ModData, OrderManager, WorldType.Regular));
			Time("start.worldrenderer", () => WorldRenderer = new WorldRenderer(ModData, World));
			Time("start.loadcomplete", () => World.LoadComplete(WorldRenderer));

			SpawnActors(s);

			OrderManager.StartGame();
			WorldRenderer.RefreshPalette();
			World.PostLoadComplete(WorldRenderer);

			if (s.Script == "battle")
				ScriptBattle();

			GC.Collect();
		}

		static void SpawnActors(ScenarioSpec s)
		{
			var players = PlayablePlayers();
			foreach (var a in s.Spawns)
			{
				if (a.Player < 0 || a.Player >= players.Count)
					throw new InvalidDataException($"Spawn {a.Type}: no player {a.Player}.");

				var owner = players[a.Player];
				World.CreateActor(a.Type.ToLowerInvariant(), new TypeDictionary
				{
					new OwnerInit(owner),
					new LocationInit(new MPos(a.X, a.Y).ToCPos(World.Map)),
					new FacingInit(new WAngle(a.Facing)),
					new FactionInit(owner.Faction.InternalName),
				});
			}
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
			}

			// TickRender updates the screen map (mouse/selection lookups) and render-only state.
			if (OrderManager.LocalFrameNumber > 0)
				Sync.RunUnsynced(world, () => world.TickRender(WorldRenderer));

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
			return new MouseInput(MouseInputEvent.Down, button, worldPx, int2.Zero, mods, 1);
		}

		/// <summary>The cursor the game would show for the current selection at this world pixel.</summary>
		public static string Cursor(int2 worldPx, Modifiers mods)
		{
			var world = World;
			return Sync.RunUnsynced(world, () =>
			{
				var cell = CellAtWorldPx(worldPx);
				var mi = Mouse(worldPx, world.OrderGenerator.ActionButton, mods);
				return world.OrderGenerator.GetCursor(world, cell, worldPx, mi) ?? "default";
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
