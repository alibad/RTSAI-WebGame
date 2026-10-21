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
using System.Linq;
using System.Text;
using System.Text.Json;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Orders;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.RTSAI.Traits;
using CompanionBridge = OpenRA.Mods.RTSAI.Traits.CompanionBridge;
using OpenRA.Mods.Common.Traits.Radar;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Orders;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The game-UI side of the host: what the page's sidebar, radar and selection panel show (read from the same
	/// traits the desktop widgets read) and the commands they issue (the same orders and order generators the
	/// desktop widgets create). Nothing here touches synced state except through world.IssueOrder.
	/// </summary>
	public static class Ui
	{
		static string J(string s) => Snapshot.Json(s);

		static Player Local => SimHost.World?.LocalPlayer;

		static IEnumerable<ProductionQueue> Queues(Player p) =>
			p == null ? [] : p.PlayerActor.TraitsImplementing<ProductionQueue>().OrderBy(q => q.Info.DisplayOrder);

		static ProductionQueue Queue(string type) => Queues(Local).FirstOrDefault(q => (q.Info.Group ?? q.Info.Type) == type);

		// ---------------------------------------------------------------- per-tick state

		static string lastCatalog;
		static OpenRA.GameRules.MusicInfo measuredMusic;

		/// <summary>
		/// Per-tick UI state as JSON. "catalog" (the buildable items per queue) is included only when it changed since
		/// the last call, so the page merges it; everything else is small and sent every tick.
		/// </summary>
		public static string State()
		{
			var world = SimHost.World;
			var p = Local;
			if (world == null)
				return "{}";

			// One builder for every tick: the returned string is the only per-tick copy.
			var sb = StateBuilder.Clear();
			if (p == null)
			{
				// Spectating (Battle simulator, replays): no player panels, but the soundtrack panel still needs its
				// track and duration, or it cannot show the track or seek.
				sb.Append('{');
				WriteMusic(sb, world);
				return sb.Append('}').ToString();
			}

			sb.Append("{\"tick\":").Append(world.WorldTick);
			sb.Append(",\"coach\":");
			AiLab.WriteCoachJson(sb, world, p);

			var res = p.PlayerActor.TraitOrDefault<PlayerResources>();
			if (res != null)
				sb.Append(",\"cash\":").Append(res.GetCashAndResources()).Append(",\"storage\":").Append(res.ResourceCapacity);

			var pm = p.PlayerActor.TraitOrDefault<PowerManager>();
			if (pm != null)
				sb.Append(",\"power\":{\"provided\":").Append(pm.PowerProvided).Append(",\"drained\":").Append(pm.PowerDrained)
					.Append(",\"state\":").Append(J(pm.PowerState.ToString())).Append('}');

			var radar = world.ActorsHavingTrait<ProvidesRadar>(r => !r.IsTraitDisabled).Any(a => a.Owner == p);
			sb.Append(",\"radar\":").Append(radar ? "true" : "false");
			sb.Append(",\"win\":").Append(J(p.WinState.ToString()));
			sb.Append(",\"mission\":").Append(Missions.StateJson()).Append(',');
			WriteMusic(sb, world);
			sb.Append(",\"mode\":").Append(J(ModeName(world.OrderGenerator)));

			var selected = OwnSelection(world);
			// The five command flags, in this order.
			sb.Append(",\"commands\":{\"attackmove\":").Append(selected.Any(a => a.Info.HasTraitInfo<AttackMoveInfo>() && a.Info.HasTraitInfo<AutoTargetInfo>()) ? "true" : "false")
				.Append(",\"guard\":").Append(selected.Any(a => a.Info.HasTraitInfo<GuardInfo>() && a.Info.HasTraitInfo<AutoTargetInfo>()) ? "true" : "false")
				.Append(",\"scatter\":").Append(selected.Any(a => a.Info.HasTraitInfo<IMoveInfo>()) ? "true" : "false")
				.Append(",\"deploy\":").Append(selected.Any(a => a.TraitsImplementing<IIssueDeployOrder>().Any(d => d.CanIssueDeployOrder(a, false))) ? "true" : "false")
				.Append(",\"stop\":").Append(selected.Any(a => a.Info.TraitInfoOrDefault<CommandBarBlacklistInfo>()?.DisableStop != true) ? "true" : "false")
				.Append('}');
			sb.Append(",\"stances\":[").Append(string.Join(",", selected.SelectMany(a => a.TraitsImplementing<AutoTarget>())
				.Select(t => t.PredictedStance.ToString().ToLowerInvariant()).Distinct().Select(J))).Append(']');
			sb.Append(",\"supportPowers\":[");
			var powers = p.PlayerActor.TraitOrDefault<SupportPowerManager>()?.Powers.Values
				.Where(power => !power.Disabled && power.Info != null).OrderBy(power => power.Key);
			if (powers != null)
				sb.Append(string.Join(",", powers.Select(power => "{\"key\":" + J(power.Key) + ",\"name\":" + J(PowerLabel(power))
					+ ",\"description\":" + J(power.Description) + ",\"ready\":" + (power.Ready ? "true" : "false")
					+ ",\"active\":" + (power.Active ? "true" : "false") + ",\"remaining\":" + power.RemainingTicks
					+ ",\"total\":" + power.TotalTicks + "}")));
			sb.Append(']');

			// The AI co-commander's HUD line and threat meter (what the desktop's AI strip shows).
			if (CompanionRpc.Enabled && CompanionBridge.TryGetStatus(out var cState, out var cMessage, out var cEnabled, out var cMuted))
			{
				CompanionBridge.TryGetThreat(out var tScore, out var tLevel, out var tReason);
				sb.Append(",\"companion\":{\"state\":").Append(J(cState)).Append(",\"message\":").Append(J(cMessage))
					.Append(",\"enabled\":").Append(cEnabled ? "true" : "false").Append(",\"muted\":").Append(cMuted ? "true" : "false")
					.Append(",\"threat\":{\"score\":").Append(tScore).Append(",\"level\":").Append(J(tLevel)).Append(",\"reason\":").Append(J(tReason)).Append("}}");
			}

			// Queues: state of every queued item (progress, hold, ready).
			sb.Append(",\"queues\":[");
			var first = true;
			foreach (var q in Queues(p))
			{
				if (!first)
					sb.Append(',');
				first = false;
				sb.Append("{\"type\":").Append(J(q.Info.Group ?? q.Info.Type)).Append(",\"enabled\":").Append(q.Enabled ? "true" : "false");
				sb.Append(",\"items\":[");
				var firstItem = true;
				foreach (var item in q.AllQueued())
				{
					if (!firstItem)
						sb.Append(',');
					firstItem = false;
					var progress = item.Started && item.TotalTime > 0 ? (item.TotalTime - item.RemainingTime) / (float)item.TotalTime : 0f;
					sb.Append("{\"name\":").Append(J(item.Item))
						.Append(",\"progress\":").Append(Math.Clamp(progress, 0, 1).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture))
						.Append(",\"paused\":").Append(item.Paused ? "true" : "false")
						.Append(",\"done\":").Append(item.Done ? "true" : "false")
						.Append(",\"infinite\":").Append(item.Infinite ? "true" : "false")
						.Append(",\"remaining\":").Append(item.Started ? q.RemainingTimeActual(item) : 0)
						.Append('}');
				}

				sb.Append("]}");
			}

			sb.Append(']');

			// Selection details: type, health and veterancy of every selected actor the player may see.
			sb.Append(",\"selection\":[");
			first = true;
			foreach (var a in world.Selection.Actors)
			{
				if (!a.IsInWorld || a.IsDead || !a.CanBeViewedByPlayer(p))
					continue;
				if (!first)
					sb.Append(',');
				first = false;
				var health = a.TraitOrDefault<IHealth>();
				var xp = a.TraitOrDefault<GainsExperience>();
				sb.Append("{\"id\":").Append(a.ActorID).Append(",\"type\":").Append(J(a.Info.Name))
					.Append(",\"own\":").Append(a.Owner == p ? "true" : "false")
					.Append(",\"hp\":").Append(health?.HP ?? 0).Append(",\"maxHp\":").Append(health?.MaxHP ?? 0)
					.Append(",\"rank\":").Append(xp?.Level ?? 0).Append(",\"maxRank\":").Append(xp?.MaxLevel ?? 0)
					.Append(",\"primary\":").Append(a.TraitOrDefault<PrimaryBuilding>()?.IsPrimary == true ? "true" : "false")
					.Append(",\"canPrimary\":").Append(a.TraitOrDefault<PrimaryBuilding>() is { IsTraitDisabled: false } ? "true" : "false")
					.Append(",\"rally\":").Append(a.TraitOrDefault<RallyPoint>() != null ? "true" : "false")
					.Append(",\"produces\":[").Append(string.Join(",", a.TraitsImplementing<Production>()
						.Where(t => !t.IsTraitDisabled).SelectMany(t => t.Info.Produces).Distinct().Select(J))).Append(']')
					.Append('}');
			}

			sb.Append(']');

			// Control groups: member count of groups 1..9, 0 (the engine's order).
			if (world.ControlGroups is ControlGroups groups)
			{
				sb.Append(",\"groups\":[");
				for (var i = 0; i < groups.Groups.Length; i++)
				{
					if (i > 0)
						sb.Append(',');
					sb.Append(groups.GetActorsInControlGroup(i).Count());
				}

				sb.Append(']');
			}

			if (Sandbox.Active)
				sb.Append(",\"sandbox\":").Append(Sandbox.Json());

			// The catalog is written into a reused builder and compared in place; a string is made only when it changed.
			// Its per-item text (names, Fluent descriptions, prerequisites) is cached per actor type.
			var catalogSb = CatalogBuilder.Clear();
			WriteCatalog(catalogSb, p);

			if (lastCatalog == null || !catalogSb.Equals(lastCatalog.AsSpan()))
			{
				lastCatalog = catalogSb.ToString();
				sb.Append(",\"catalog\":").Append(lastCatalog);
			}

			sb.Append('}');
			return sb.ToString();
		}

		/// <summary>"music": the current track, measured once while it plays (its duration enables seeking).</summary>
		static void WriteMusic(StringBuilder sb, World world)
		{
			var music = Game.Sound.CurrentMusic;
			// Only inspect the current, already fetched track. Preparing the whole playlist would download it all.
			if (music != null && Game.Sound.MusicPlaying && music != measuredMusic)
			{
				measuredMusic = music;
				try { music.Load(world.Map); }
				catch { /* Playback can continue without a duration label. */ }
			}
			sb.Append("\"music\":");
			if (music == null)
				sb.Append("null");
			else
				sb.Append("{\"id\":").Append(J(music.Filename)).Append(",\"title\":").Append(J(music.Title))
					.Append(",\"duration\":").Append(music.Length).Append('}');
		}

		/// <summary>The page lost its state (a new game, a reload): send the catalog again with the next State().</summary>
		public static void Resync()
		{
			lastCatalog = null;
			ItemText.Clear();
		}

		static readonly StringBuilder StateBuilder = new(4096);
		static readonly StringBuilder CatalogBuilder = new(8192);
		static readonly HashSet<string> Buildable = [];

		// Per actor type, the catalog text that never changes during a game: name, label, the desktop production tooltip's
		// description, and the prerequisites it lists while the item cannot be built.
		sealed class ItemCache
		{
			public string Head;     // {"name":..,"label":..
			public string Desc;     // ,"desc":.. or ""
			public string Requires; // ,"requires":[..] or ""
			public bool Building;
			public int Power;
		}

		static readonly Dictionary<ActorInfo, ItemCache> ItemText = [];
		static readonly List<(int Order, int Index, ActorInfo Actor)> SortedItems = [];
		static readonly Comparison<(int Order, int Index, ActorInfo Actor)> ByPaletteOrder =
			(x, y) => x.Order != y.Order ? x.Order.CompareTo(y.Order) : x.Index.CompareTo(y.Index);

		static ItemCache Item(Player p, ActorInfo a)
		{
			if (ItemText.TryGetValue(a, out var c))
				return c;
			var bi = a.TraitInfo<BuildableInfo>();
			var rules = p.World.Map.Rules;
			var requires = bi.Prerequisites
				.Where(r => !r.StartsWith('~') && !r.StartsWith('!') && rules.Actors.ContainsKey(r))
				.Select(r => ActorLabel(rules.Actors[r])).Distinct().ToList();
			c = new ItemCache
			{
				Head = "{\"name\":" + J(a.Name) + ",\"label\":" + J(ActorLabel(a)),
				Desc = bi.Description != null && FluentProvider.TryGetMessage(bi.Description, out var desc) ? ",\"desc\":" + J(desc) : "",
				Requires = requires.Count > 0 ? ",\"requires\":[" + string.Join(",", requires.Select(J)) + "]" : "",
				Building = a.HasTraitInfo<BuildingInfo>(),
				Power = a.TraitInfos<PowerInfo>().Where(i => i.EnabledByDefault).Sum(i => i.Amount),
			};
			ItemText[a] = c;
			return c;
		}

		/// <summary>Items per queue, in palette order, with cost, build time and whether they can be built now.</summary>
		static void WriteCatalog(StringBuilder sb, Player p)
		{
			sb.Append('[');
			var first = true;
			foreach (var q in Queues(p))
			{
				if (!first)
					sb.Append(',');
				first = false;
				Buildable.Clear();
				foreach (var b in q.BuildableItems())
					Buildable.Add(b.Name);
				sb.Append("{\"type\":").Append(J(q.Info.Group ?? q.Info.Type)).Append(",\"items\":[");
				// AllItems changes with the tech tree: sort it each tick into a reused list (stable, like OrderBy).
				SortedItems.Clear();
				foreach (var a in q.AllItems())
					SortedItems.Add((a.TraitInfo<BuildableInfo>().BuildPaletteOrder, SortedItems.Count, a));
				SortedItems.Sort(ByPaletteOrder);
				var firstItem = true;
				foreach (var (_, _, a) in SortedItems)
				{
					if (!firstItem)
						sb.Append(',');
					firstItem = false;
					var c = Item(p, a);
					var canBuild = Buildable.Contains(a.Name);
					sb.Append(c.Head)
						.Append(",\"cost\":").Append(q.GetProductionCost(a))
						.Append(",\"time\":").Append(q.GetBuildTime(a, a.TraitInfo<BuildableInfo>()))
						.Append(",\"power\":").Append(c.Power)
						.Append(",\"buildable\":").Append(canBuild ? "true" : "false")
						.Append(",\"building\":").Append(c.Building ? "true" : "false")
						.Append(c.Desc);
					if (!canBuild)
						sb.Append(c.Requires);
					sb.Append('}');
				}

				sb.Append("]}");
			}

			sb.Append(']');
		}

		static string ActorLabel(ActorInfo a)
		{
			var labels = Local?.PlayerActor.Info.TraitInfoOrDefault<OriginalCountryLabelsInfo>();
			if (labels != null && !labels.Factions.Contains(Local.Faction.InternalName) && labels.ModernActors.TryGetValue(a.Name, out var name))
				return name;
			var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			return tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name;
		}

		static string PowerLabel(SupportPowerInstance power)
		{
			var labels = Local?.PlayerActor.Info.TraitInfoOrDefault<OriginalCountryLabelsInfo>();
			return labels != null && !labels.Factions.Contains(Local.Faction.InternalName) && labels.ModernPowers.TryGetValue(power.Info.Icon, out var name)
				? name : power.Name;
		}

		static string ModeName(IOrderGenerator og) => og switch
		{
			PlaceBuildingOrderGenerator => "place",
			SellOrderGenerator => "sell",
			RepairOrderGenerator => "repair",
			AttackMoveOrderGenerator => "attackmove",
			GuardOrderGenerator => "guard",
			BeaconOrderGenerator => "beacon",
			UnitOrderGenerator => "",
			null => "",
			_ => og.GetType().Name,
		};

		// ---------------------------------------------------------------- commands

		static List<Actor> OwnSelection(World world) =>
			world.Selection.Actors.Where(a => a.Owner == world.LocalPlayer && a.IsInWorld && !a.IsDead).ToList();

		/// <summary>
		/// Runs a page command (JSON {"cmd": ...}). Returns a JSON reply (e.g. the new selection) or "{}".
		/// Production commands follow ProductionPaletteWidget's click rules exactly.
		/// </summary>
		public static string Command(string json)
		{
			// No local player is fine: the sandbox editor runs as a spectator (it sees both sides).
			var world = SimHost.World;
			if (world == null)
				return "{}";

			// UI actions run outside synced code, like the desktop widgets (orders still go through IssueOrder).
			return Sync.RunUnsynced(world, () => RunCommand(world, json));
		}

		static string RunCommand(World world, string json)
		{
			using var doc = JsonDocument.Parse(json);
			var r = doc.RootElement;
			var cmd = r.GetProperty("cmd").GetString();
			string Str(string n) => r.TryGetProperty(n, out var v) ? v.GetString() : null;
			int Int(string n, int def = 0) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;
			bool Bool(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;

			switch (cmd)
			{
				case "music-list":
				{
					var playlist = world.WorldActor.TraitOrDefault<MusicPlaylist>();
					return "{\"tracks\":[" + string.Join(",", (playlist?.AvailablePlaylist() ?? [])
						.Select(song => "{\"id\":" + J(song.Filename) + ",\"title\":" + J(song.Title) + "}")) + "]}";
				}

				case "music-play":
				case "music-next":
				case "music-previous":
				{
					var playlist = world.WorldActor.TraitOrDefault<MusicPlaylist>();
					if (playlist == null)
						break;
					var song = cmd == "music-next" ? playlist.GetNextSong()
						: cmd == "music-previous" ? playlist.GetPrevSong()
						: Str("id") is string id ? playlist.AvailablePlaylist().FirstOrDefault(m => m.Filename == id)
						: playlist.CurrentSong() ?? playlist.GetNextSong();
					if (song != null)
						playlist.Play(song);
					break;
				}

				case "music-pause":
					Game.Sound.PauseMusic();
					break;

				case "music-seek":
				{
					var song = Game.Sound.CurrentMusic;
					var playlist = world.WorldActor.TraitOrDefault<MusicPlaylist>();
					if (song == null || playlist == null || song.Length <= 0)
						return "{\"error\":\"Wait for the track to load before seeking.\"}";
					var seconds = r.TryGetProperty("seconds", out var value) && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : 0;
					var playing = Game.Sound.MusicPlaying;
					WebSoundEngine.SeekMusic(Math.Clamp(seconds, 0, Math.Max(0, song.Length - 0.25)), () =>
					{
						Game.Sound.StopMusic();
						playlist.Play(song);
						if (!playing) Game.Sound.PauseMusic();
					});
					break;
				}

				case "produce":
				{
					// Left click on a cameo: place a finished building, resume a held item, or queue more.
					var q = Queue(Str("queue"));
					var name = Str("item");
					if (q == null || name == null)
						break;

					var item = q.AllQueued().FirstOrDefault(i => i.Item == name);
					var actor = world.Map.Rules.Actors[name];
					if (item != null && item.Done && actor.HasTraitInfo<BuildingInfo>())
					{
						world.OrderGenerator = new PlaceBuildingOrderGenerator(q, name, SimHost.WorldRenderer);
						break;
					}

					if (item != null && item.Paused)
					{
						world.IssueOrder(Order.PauseProduction(q.Actor, name, false));
						break;
					}

					if (q.BuildableItems().Any(a => a.Name == name) && q.CanQueue(actor, out _, out _))
						world.IssueOrder(Order.StartProduction(q.Actor, name, Math.Max(1, Int("count", 1)), !Bool("front")));
					break;
				}

				case "hold":
				{
					// Right click: hold, or cancel when already held / not started / finished.
					var q = Queue(Str("queue"));
					var name = Str("item");
					var item = q?.AllQueued().FirstOrDefault(i => i.Item == name);
					if (item == null)
						break;

					if (Bool("all"))
						world.IssueOrder(Order.CancelProduction(q.Actor, name, q.AllQueued().Count(i => i.Item == name)));
					else if (q.Info.DisallowPaused || item.Paused || item.Done || item.TotalCost == item.RemainingCost || !item.Started)
						world.IssueOrder(Order.CancelProduction(q.Actor, name, Math.Max(1, Int("count", 1))));
					else
						world.IssueOrder(Order.PauseProduction(q.Actor, name, true));
					break;
				}

				case "mode":
				{
					var selected = OwnSelection(world);
					world.OrderGenerator = Str("mode") switch
					{
						"sell" => new SellOrderGenerator(world),
						"repair" => new RepairOrderGenerator(world),
						"attackmove" when selected.Count > 0 => new AttackMoveOrderGenerator(world, selected),
						"guard" when selected.Count > 0 => new GuardOrderGenerator(world, selected, "Guard", "guard"),
						"beacon" => new BeaconOrderGenerator(world),
						_ => new UnitOrderGenerator(world),
					};
					break;
				}

				case "stop":
					Issue(world, OwnSelection(world).Select(a => new Order("Stop", a, false)));
					break;

				case "scatter":
					Issue(world, OwnSelection(world).Select(a => new Order("Scatter", a, Bool("queued"))));
					break;

				case "deploy":
				{
					// CommandBarLogic.PerformDeployOrderOnSelection.
					var queued = Bool("queued");
					Issue(world, OwnSelection(world)
						.SelectMany(a => a.TraitsImplementing<IIssueDeployOrder>().Where(d => d.CanIssueDeployOrder(a, queued)).Select(d => d.IssueDeployOrder(a, queued)))
						.Where(o => o != null));
					break;
				}

				case "primary":
					Issue(world, OwnSelection(world).Where(a => a.TraitOrDefault<PrimaryBuilding>() is { IsTraitDisabled: false })
						.Select(a => new Order("PrimaryProducer", a, false)));
					break;

				case "supportpower":
					var manager = Local.PlayerActor.TraitOrDefault<SupportPowerManager>();
					if (manager != null && manager.Powers.TryGetValue(Str("key") ?? "", out var power) && power.Ready && !power.Disabled)
						power.Target();
					break;

				case "stats":
					return GameStats(world);
				case "ai-lab":
					return AiLab.StateJson();
				case "validate-practice":
					return AiLab.Validate(world);

				// ---- battle sandbox (an editing world that does not tick; runs are rebuilt from the placements)
				case "units":
					return UnitCatalog(world.Map.Rules);

				case "spawn":
				{
					var type = Str("type");
					var players = SimHost.PlayablePlayers();
					var side = Math.Clamp(Int("player"), 0, players.Count - 1);
					if (type == null || !world.Map.Rules.Actors.ContainsKey(type))
						return "{\"error\":\"unknown actor\"}";

					var center = r.TryGetProperty("u", out _) ? new MPos(Int("u"), Int("v")).ToCPos(world.Map) : SimHost.CellAtWorldPx(new int2(Int("x"), Int("y")));
					var buildingInfo = world.Map.Rules.Actors[type].TraitInfoOrDefault<BuildingInfo>();
					if (buildingInfo != null)
						center -= new CVec(buildingInfo.Dimensions.X / 2, buildingInfo.Dimensions.Y / 2);
					var count = buildingInfo != null ? 1 : Math.Clamp(Int("count", 1), 1, 50);
					var columns = Math.Max(1, (int)Math.Ceiling(Math.Sqrt(count)));
					var created = 0;
					for (var i = 0; i < count; i++)
					{
						var cell = center + new CVec(i % columns - columns / 2, i / columns - columns / 2);
						if (!world.Map.Contains(cell))
							continue;
						var init = new TypeDictionary
						{
							new OwnerInit(players[side]),
							new LocationInit(cell),
							new FacingInit(new WAngle(side == 0 ? 768 : 256)),
							new FactionInit(players[side].Faction.InternalName),
							// These are completed placements in a paused world, not newly produced buildings.
							new SkipMakeAnimsInit(),
						};
						var health = Int("health", 100);
						if (health > 0 && health < 100)
							init.Add(new HealthInit(health));
						var actor = world.CreateActor(type, init);
						if (Int("level") > 0)
							actor.TraitOrDefault<GainsExperience>()?.GiveLevels(Int("level"), true);
						created++;
					}

					return $"{{\"created\":{created}}}";
				}

				case "remove":
				{
					// The editing world does not tick, so frame-end tasks never run: take the actor out of the world now.
					var a = world.GetActorById((uint)Int("id"));
					if (a != null && a.Owner.Playable && !a.Disposed)
					{
						if (a.IsInWorld)
							world.Remove(a);
						a.Dispose();
					}

					return "{}";
				}

				case "placements":
					return Placements(world);

				case "rosters":
					return Rosters(world.Map.Rules);

				case "unitinfo":
					return UnitInfo(world, Str("type"));

				case "unitrules":
				{
					// Studio acceptance reads the rules mounted by this actual simulation, including map overrides.
					var type = Str("type")?.ToLowerInvariant();
					var mod = Game.ModData;
					var actor = MiniYaml.Load(world.Map, mod.Rules, world.Map.RuleDefinitions)
						.FirstOrDefault(n => n.Key.Equals(type, StringComparison.OrdinalIgnoreCase));
					if (actor == null) return "{\"error\":\"unknown actor\"}";
					var weapons = MiniYaml.Load(world.Map, mod.Weapons, world.Map.WeaponDefinitions);
					var names = world.Map.Rules.Actors[type].TraitInfos<ArmamentInfo>().Select(a => a.Weapon).ToHashSet(StringComparer.OrdinalIgnoreCase);
					return "{\"actor\":" + J(actor.Value.Nodes.WriteToString()) + ",\"weapons\":{" +
						string.Join(",", weapons.Where(w => names.Contains(w.Key)).Select(w => J(w.Key.ToLowerInvariant()) + ":" + J(w.Value.Nodes.WriteToString()))) + "}}";
				}

				case "icon":
					return Icon(Str("type"), Str("faction"));

				case "spawnpoints":
				{
					// The map's start positions (MPos and world px), for laying out forces on any map.
					var wr = SimHost.WorldRenderer;
					var points = world.Actors.Where(a => a.Info.Name == "mpspawn" && a.IsInWorld).OrderBy(a => a.ActorID).Select(a =>
					{
						var uv = a.Location.ToMPos(world.Map);
						var px = wr.ScreenPxPosition(a.CenterPosition);
						return $"{{\"u\":{uv.U},\"v\":{uv.V},\"x\":{px.X},\"y\":{px.Y}}}";
					});
					return "{\"points\":[" + string.Join(",", points) + "]}";
				}

				case "cellat":
				{
					// The map cell (MPos) under a world pixel, accounting for terrain height.
					var uv = SimHost.CellAtWorldPx(new int2(Int("x"), Int("y"))).ToMPos(world.Map);
					return $"{{\"u\":{uv.U},\"v\":{uv.V}}}";
				}

				// ---- the desktop game's hotkey logics (mods/common/hotkeys, the mod's ingame chrome), same calls
				case "selectall":
				case "selecttype":
				{
					// SelectAllUnitsHotkeyLogic / SelectUnitsByTypeHotkeyLogic: the units on screen (the page's view),
					// or across the map when the screen adds nothing new.
					var eligible = SelectionUtils.GetPlayersToIncludeInSelection(world);
					var mods = (Modifiers)Int("mods");
					HashSet<string> classes = null;
					if (cmd == "selecttype")
					{
						var owned = world.Selection.Actors.Where(x => !x.IsDead && eligible.Contains(x.Owner)).ToList();
						if (owned.Count == 0)
							return "{\"feedback\":\"nothing\"}";

						classes = owned.Select(a => a.Trait<ISelectable>().Class).ToHashSet();
					}

					var onScreen = world.ScreenMap.ActorsInMouseBox(new int2(Int("x0"), Int("y0")), new int2(Int("x1"), Int("y1"))).Select(a => a.Actor);
					var pick = SelectionUtils.SelectActorsByOwnerAndSelectionClass(onScreen, eligible, classes);
					if (classes == null)
						pick = pick.SubsetWithHighestSelectionPriority(mods);

					var list = pick.ToList();
					var scope = "screen";
					if (list.Count <= world.Selection.Actors.Count)
					{
						var all = SelectionUtils.SelectActorsInWorld(world, classes, eligible);
						if (classes == null)
							all = all.SubsetWithHighestSelectionPriority(mods);

						list = all.ToList();
						scope = "map";
					}

					world.Selection.Combine(world, list, classes != null, false);
					return SelectionReply(world, extra: $",\"feedback\":\"{scope}\",\"count\":{list.Count}");
				}

				case "cyclebase":
				{
					// CycleBasesHotkeyLogic.
					var player = world.RenderPlayer ?? world.LocalPlayer;
					var bases = world.ActorsHavingTrait<BaseBuilding>().Where(a => a.Owner == player)
						.OrderByDescending(a => a.TraitOrDefault<PrimaryBuilding>() is { IsPrimary: true }).ThenBy(a => a.ActorID).ToList();
					if (bases.Count == 0)
					{
						var building = world.ActorsHavingTrait<Building>().FirstOrDefault(a => a.Owner == player && a.Info.HasTraitInfo<SelectableInfo>());
						if (building == null)
							return "{}";

						world.Selection.Combine(world, [building], false, true);
						return SelectionReply(world, center: world.Selection.Actors);
					}

					var next = bases.SkipWhile(b => !world.Selection.Contains(b)).Skip(1).FirstOrDefault() ?? bases[0];
					world.Selection.Combine(world, [next], false, true);
					return SelectionReply(world, center: world.Selection.Actors);
				}

				case "cycleharvester":
				{
					// CycleHarvestersHotkeyLogic.
					var player = world.RenderPlayer ?? world.LocalPlayer;
					var harvesters = world.ActorsHavingTrait<Harvester>().Where(a => a.IsInWorld && a.Owner == player).ToList();
					if (harvesters.Count == 0)
						return "{}";

					var next = harvesters.SkipWhile(b => !world.Selection.Contains(b)).Skip(1).FirstOrDefault() ?? harvesters[0];
					world.Selection.Combine(world, [next], false, true);
					return SelectionReply(world, center: world.Selection.Actors);
				}

				case "cycleproduction":
				{
					// CycleProductionActorsHotkeyLogic.
					var player = world.RenderPlayer ?? world.LocalPlayer;
					var facilities = world.ActorsHavingTrait<Production>()
						.Where(a => a.Owner == player && a.OccupiesSpace != null && !a.Info.HasTraitInfo<BaseBuildingInfo>()
							&& a.TraitsImplementing<Production>().Any(t => !t.IsTraitDisabled))
						.OrderBy(f => f.TraitsImplementing<Production>().First(t => !t.IsTraitDisabled).Info.Produces[0])
						.ToList();
					if (facilities.Count == 0)
						return "{}";

					var next = facilities.SkipWhile(b => !world.Selection.Contains(b)).Skip(1).FirstOrDefault() ?? facilities[0];
					world.Selection.Combine(world, [next], false, true);
					return SelectionReply(world, center: world.Selection.Actors);
				}

				case "toselection":
					// JumpToSelectedActorsHotkeyLogic.
					return SelectionReply(world, center: world.Selection.Actors);

				case "lastevent":
				{
					// JumpToLastEventHotkeyLogic: the last radar ping.
					var pings = world.WorldActor.TraitOrDefault<RadarPings>();
					if (pings?.LastPingPosition == null)
						return "{}";

					var px = SimHost.WorldRenderer.ScreenPxPosition(pings.LastPingPosition.Value);
					return $"{{\"center\":[{px.X},{px.Y}]}}";
				}

				case "stance":
				{
					// StanceSelectorLogic.SetSelectionStance (the command bar's stance buttons and their hotkeys).
					var stance = Str("stance") switch
					{
						"attackanything" => UnitStance.AttackAnything,
						"defend" => UnitStance.Defend,
						"returnfire" => UnitStance.ReturnFire,
						_ => UnitStance.HoldFire,
					};
					var actorStances = world.Selection.Actors.Where(a => a.Owner == world.LocalPlayer && a.IsInWorld)
						.SelectMany(a => a.TraitsImplementing<AutoTarget>().Where(at => at.Info.EnableStances).Select(at => new TraitPair<AutoTarget>(a, at)))
						.ToArray();
					foreach (var at in actorStances)
					{
						if (!at.Trait.IsTraitDisabled)
							at.Trait.PredictedStance = stance;

						world.IssueOrder(new Order("SetUnitStance", at.Actor, false) { ExtraData = (uint)stance });
					}

					return $"{{\"count\":{actorStances.Length}}}";
				}

				case "group":
				{
					var i = Int("index");
					var groups = world.ControlGroups;
					switch (Str("action"))
					{
						case "create": groups.CreateControlGroup(i); break;
						case "add": groups.AddSelectionToControlGroup(i); break;
						case "combine": groups.CombineSelectionWithControlGroup(i); break;
						case "jump": return SelectionReply(world, center: groups.GetActorsInControlGroup(i));
						default: groups.SelectControlGroup(i); break;
					}

					return SelectionReply(world, i);
				}
			}

			return "{}";
		}

		/// <summary>
		/// The end-of-game summary (the desktop's observer statistics): per playing side, what it destroyed and lost,
		/// earned, and its army value sampled every 30 s of game time. Read-only.
		/// </summary>
		static string GameStats(World world)
		{
			var sb = new StringBuilder(1024);
			sb.Append("{\"tick\":").Append(world.WorldTick).Append(",\"timestep\":").Append(world.Timestep).Append(",\"players\":[");
			var first = true;
			foreach (var p in world.Players.Where(p => p.Playable && !p.NonCombatant))
			{
				var st = p.PlayerActor.TraitOrDefault<PlayerStatistics>();
				var res = p.PlayerActor.TraitOrDefault<PlayerResources>();
				if (st == null)
					continue;

				if (!first)
					sb.Append(',');
				first = false;
				sb.Append("{\"name\":").Append(J(p.ResolvedPlayerName))
					.Append(",\"faction\":").Append(J(p.Faction.InternalName))
					.Append(",\"color\":").Append(J($"{p.Color.R:X2}{p.Color.G:X2}{p.Color.B:X2}"))
					.Append(",\"local\":").Append(p == world.LocalPlayer ? "true" : "false")
					.Append(",\"bot\":").Append(p.IsBot ? "true" : "false")
					.Append(",\"win\":").Append(J(p.WinState.ToString()))
					.Append(",\"unitsKilled\":").Append(st.UnitsKilled)
					.Append(",\"unitsDead\":").Append(st.UnitsDead)
					.Append(",\"buildingsKilled\":").Append(st.BuildingsKilled)
					.Append(",\"buildingsDead\":").Append(st.BuildingsDead)
					.Append(",\"killsCost\":").Append(st.KillsCost)
					.Append(",\"deathsCost\":").Append(st.DeathsCost)
					.Append(",\"earned\":").Append(res?.Earned ?? 0)
					.Append(",\"army\":[").Append(string.Join(",", st.ArmySamples.Append(st.ArmyValue))).Append("]}");
			}

			return sb.Append("]}").ToString();
		}

		/// <summary>
		/// Everything a player can build (infantry, vehicles, aircraft, ships, buildings and defences) for the simulator's
		/// drawer: name, label, queue, kind, cost and the building footprint.
		/// </summary>
		public static string UnitCatalog(Ruleset rules)
		{
			var queues = new HashSet<string> { "Infantry", "Vehicle", "Aircraft", "Ship", "Building", "Support" };
			var armors = rules.Actors.Values.SelectMany(a => a.TraitInfos<ArmorInfo>()).Select(a => a.Type).Where(t => t != null).Distinct().Order().ToArray();
			var sb = new StringBuilder("{\"units\":[");
			var first = true;
			foreach (var a in rules.Actors.Values.OrderBy(a => a.Name))
			{
				if (a.Name.StartsWith('^'))
					continue;
				var bi = a.TraitInfoOrDefault<BuildableInfo>();
				var queue = bi?.Queue.FirstOrDefault(queues.Contains);
				if (queue == null || !a.HasTraitInfo<RenderSpritesInfo>())
					continue;

				var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
				var building = a.TraitInfoOrDefault<BuildingInfo>();
				var cost = a.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0;
				if (!first)
					sb.Append(',');
				first = false;
				sb.Append("{\"name\":").Append(J(a.Name))
					.Append(",\"label\":").Append(J(tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name))
					.Append(",\"queue\":").Append(J(queue))
					.Append(",\"kind\":").Append(J(PlacementKind(a, queue)))
					.Append(",\"cost\":").Append(cost)
					.Append(",\"modern\":").Append(a.Name.StartsWith("r2", StringComparison.Ordinal) ? "true" : "false")
					.Append(",\"combat\":").Append(a.HasTraitInfo<AttackBaseInfo>() && a.HasTraitInfo<ArmamentInfo>() ? "true" : "false");
				if (building != null)
					sb.Append(",\"footprint\":[").Append(building.Dimensions.X).Append(',').Append(building.Dimensions.Y).Append(']');
				AppendCombat(sb, a, rules, armors);
				sb.Append('}');
			}

			return sb.Append("]}").ToString();
		}

		/// <summary>Production queues identify factories, not movement: helicopters may use the vehicle factory.</summary>
		static string PlacementKind(ActorInfo actor, string queue)
		{
			if (actor.HasTraitInfo<BuildingInfo>())
				return queue == "Support" ? "defense" : "building";
			if (actor.HasTraitInfo<AircraftInfo>())
				return "aircraft";
			if (actor.HasTraitInfo<WithInfantryBodyInfo>())
				return "infantry";
			if (actor.HasTraitInfo<MobileInfo>())
				return queue == "Ship" ? "ship" : "vehicle";
			return queue.ToLowerInvariant();
		}

		/// <summary>
		/// What a unit brings to a fight, from its rules: "hp", "armor", the target types it can be hit as ("targets";
		/// an aircraft as flying) and each weapon's damage per second against every armor type, with the target types it
		/// can and can't hit (DamageWarhead Versus, Burst, ReloadDelay at 25 ticks a second). The battle simulator's
		/// missions balance their armies with it (web/src/strength.ts).
		/// </summary>
		static void AppendCombat(StringBuilder sb, ActorInfo a, Ruleset rules, string[] armors)
		{
			var health = a.TraitInfoOrDefault<HealthInfo>();
			if (health == null)
				return;

			// The unit as it usually fights: no conditions granted (not paradropped, not elite), an aircraft airborne.
			// Traits enabled in that state count; when none would be, all of them do.
			var state = new Dictionary<string, int>();
			if (a.HasTraitInfo<AircraftInfo>())
				state["airborne"] = 1;
			List<T> Usual<T>(IEnumerable<T> traits) where T : ConditionalTraitInfo
			{
				var all = traits.ToList();
				var on = all.Where(t => t.RequiresCondition == null || t.RequiresCondition.Evaluate(state)).ToList();
				return on.Count > 0 ? on : all;
			}

			var targetables = Usual(a.TraitInfos<TargetableInfo>());
			var targets = targetables.SelectMany(t => t.TargetTypes.Select(x => x.ToString())).Distinct();
			sb.Append(",\"hp\":").Append(health.HP)
				.Append(",\"armor\":").Append(J(a.TraitInfos<ArmorInfo>().FirstOrDefault()?.Type ?? ""))
				.Append(",\"targets\":[").Append(string.Join(",", targets.Select(t => J(t)))).Append("],\"weapons\":[");
			var firstWeapon = true;
			foreach (var arm in Usual(a.TraitInfos<ArmamentInfo>()))
			{
				if (!rules.Weapons.TryGetValue(arm.Weapon.ToLowerInvariant(), out var w) || w.ReloadDelay <= 0)
					continue;
				var warheads = w.Warheads.OfType<OpenRA.Mods.Common.Warheads.DamageWarhead>().ToList();
				if (warheads.Count == 0)
					continue;
				if (!firstWeapon)
					sb.Append(',');
				firstWeapon = false;
				var perSecond = 25.0 * w.Burst / w.ReloadDelay;
				sb.Append("{\"dps\":{");
				var firstArmor = true;
				foreach (var armor in armors.Prepend(""))
				{
					var damage = warheads.Sum(d => d.Damage * (d.Versus.TryGetValue(armor, out var pct) ? pct : 100) / 100.0) * perSecond;
					if (!firstArmor)
						sb.Append(',');
					firstArmor = false;
					sb.Append(J(armor)).Append(':').Append(Math.Round(damage, 1).ToString(System.Globalization.CultureInfo.InvariantCulture));
				}

				sb.Append("},\"valid\":[").Append(string.Join(",", w.ValidTargets.Select(t => J(t.ToString()))))
					.Append("],\"invalid\":[").Append(string.Join(",", w.InvalidTargets.Select(t => J(t.ToString())))).Append("]}");
			}

			sb.Append(']');
		}

		/// <summary>
		/// What each selectable faction can field, from the rules alone: an actor belongs to a faction's roster when every
		/// prerequisite it names is provided for that faction (ProvidesPrerequisite and its Factions list, e.g. the mod's
		/// "~faction.saudi") and none it negates is. The simulator's drawer and the Earth missions use it.
		/// </summary>
		public static string Rosters(Ruleset rules)
		{
			// Resolve the current rules, including saved Studio overlays. A baseline registry alone
			// would go stale after an owner edits a prerequisite. Native live-world audits check
			// this rule graph against the same Studio roster for every supported faction.
			var world = rules.Actors[SystemActors.World];
			var factions = world.TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0).ToArray();
			var countries = world.TraitInfos<FactionInfo>().Select(f => f.InternalName).ToHashSet();
			var buildables = rules.Actors.Values.Where(a => !a.Name.StartsWith('^') && a.HasTraitInfo<BuildableInfo>()).ToArray();
			var queues = new HashSet<string> { "Infantry", "Vehicle", "Aircraft", "Ship", "Building", "Defense", "Support" };
			var rows = new List<string>();
			foreach (var faction in factions)
			{
				var owned = new HashSet<string>();
				var bases = new HashSet<string>();
				var available = new HashSet<string>();
				var always = new HashSet<string>();
				bool Has(string prerequisite)
				{
					var p = prerequisite.Replace("~", "");
					return p.StartsWith('!') ? !available.Contains(p[1..]) : available.Contains(p);
				}
				IEnumerable<string> Provided(ActorInfo actor)
				{
					foreach (var p in actor.TraitInfos<ProvidesPrerequisiteInfo>())
						if ((p.Factions.Count == 0 || p.Factions.Contains(faction.InternalName)) && p.RequiresPrerequisites.All(Has)) yield return p.Prerequisite ?? actor.Name;
					foreach (var p in actor.TraitInfos<ProvidesTechPrerequisiteInfo>())
						foreach (var prerequisite in p.Prerequisites) yield return prerequisite;
				}
				foreach (var system in new[] { SystemActors.World, SystemActors.Player })
					foreach (var p in Provided(rules.Actors[system])) { available.Add(p); always.Add(p); }
				var starts = world.TraitInfos<StartingUnitsInfo>().Where(s => s.Factions.Count == 0 || s.Factions.Contains(faction.InternalName)).ToArray();
				var baseSeeds = starts.Where(s => s.BaseActor != null).Select(s => s.BaseActor.ToLowerInvariant()).ToHashSet();
				foreach (var start in starts)
					foreach (var name in start.SupportActors.Append(start.BaseActor).Where(n => n != null)) owned.Add(name.ToLowerInvariant());
				bool Blocked(string p) => always.Contains(p) || available.Contains(p) && countries.Contains(p.Split('.').Last());
				bool Excluded(ActorInfo a) => a.TraitInfo<BuildableInfo>().Prerequisites.Any(p => p.Replace("~", "").StartsWith('!') && Blocked(p.Replace("~", "")[1..]));
				for (var changed = true; changed;)
				{
					changed = false;
					foreach (var name in owned.ToArray())
						if (rules.Actors.TryGetValue(name, out var actor))
						{
							foreach (var p in Provided(actor)) changed |= available.Add(p);
							foreach (var transform in actor.TraitInfos<TransformsInfo>())
							{
								var into = transform.IntoActor.ToLowerInvariant();
								changed |= owned.Add(into);
								if (baseSeeds.Contains(name) && rules.Actors.TryGetValue(into, out var deployed) && deployed.HasTraitInfo<BuildingInfo>()) bases.Add(into);
							}
						}
					foreach (var actor in buildables)
						if (!owned.Contains(actor.Name) && !Excluded(actor) && actor.TraitInfo<BuildableInfo>().Prerequisites.All(p => p.Contains('!') || Has(p))) changed |= owned.Add(actor.Name);
				}
				var roster = buildables.Where(a => owned.Contains(a.Name) && !Excluded(a) && a.HasTraitInfo<RenderSpritesInfo>() && a.TraitInfo<BuildableInfo>().Queue.Any(queues.Contains)
					&& (!a.TraitInfo<BuildableInfo>().Prerequisites.Any(p => p.Replace("~", "") == "disabled") || bases.Contains(a.Name)));
				rows.Add(J(faction.InternalName) + ":[" + string.Join(",", roster.OrderBy(a => a.TraitInfo<BuildableInfo>().BuildPaletteOrder).ThenBy(a => a.Name).Select(a => J(a.Name))) + "]");
			}
			return "{\"rosters\":{" + string.Join(",", rows) + "}}";
		}

		/// <summary>
		/// One actor's numbers from the rules this game runs (the simulator's unit card): cost, health, armour, speed,
		/// sight and each weapon's range, reload, burst, damage and targets. Text descriptions are the mod's own.
		/// </summary>
		static string UnitInfo(World world, string type)
		{
			if (type == null || !world.Map.Rules.Actors.TryGetValue(type, out var a))
				return "{\"error\":\"unknown actor\"}";

			var rules = world.Map.Rules;
			var description = a.TraitInfoOrDefault<TooltipDescriptionInfo>()?.Description ?? a.TraitInfoOrDefault<BuildableInfo>()?.Description;
			var speed = a.TraitInfoOrDefault<MobileInfo>()?.Speed ?? a.TraitInfoOrDefault<AircraftInfo>()?.Speed ?? 0;
			var sight = a.TraitInfos<RevealsShroudInfo>().Select(r => r.Range.Length).DefaultIfEmpty(0).Max();
			var sb = new StringBuilder("{");
			sb.Append("\"name\":").Append(J(type))
				.Append(",\"contentRevision\":").Append(J(SharedContent.Revision()))
				.Append(",\"label\":").Append(J(ActorLabel(a)))
				.Append(",\"description\":").Append(J(description != null ? FluentProvider.GetMessage(description) : ""))
				.Append(",\"cost\":").Append(a.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0)
				.Append(",\"hp\":").Append(a.TraitInfoOrDefault<HealthInfo>()?.HP ?? 0)
				.Append(",\"armor\":").Append(J(a.TraitInfos<ArmorInfo>().FirstOrDefault()?.Type ?? ""))
				.Append(",\"speed\":").Append(speed)
				.Append(",\"sight\":").Append((sight / 1024.0).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture))
				.Append(",\"weapons\":[");
			var firstWeapon = true;
			foreach (var arm in a.TraitInfos<ArmamentInfo>())
			{
				if (!rules.Weapons.TryGetValue(arm.Weapon.ToLowerInvariant(), out var w))
					continue;
				var damage = w.Warheads.OfType<OpenRA.Mods.Common.Warheads.DamageWarhead>().Sum(d => d.Damage);
				if (!firstWeapon)
					sb.Append(',');
				firstWeapon = false;
				sb.Append("{\"name\":").Append(J(arm.Weapon))
					.Append(",\"range\":").Append((w.Range.Length / 1024.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture))
					.Append(",\"reload\":").Append(w.ReloadDelay)
					.Append(",\"burst\":").Append(w.Burst)
					.Append(",\"damage\":").Append(damage)
					.Append(",\"targets\":[").Append(string.Join(",", w.ValidTargets.Select(t => J(t.ToString())))).Append("]}");
			}

			return sb.Append("]}").ToString();
		}

		/// <summary>The playable players' units in the editing world as scenario spawns (type, player, MPos, facing).</summary>
		static string Placements(World world)
		{
			var players = SimHost.PlayablePlayers();
			var sb = new StringBuilder("{\"spawns\":[");
			var first = true;
			foreach (var a in world.Actors.Where(a => a.IsInWorld && !a.IsDead && a.OccupiesSpace != null && players.Contains(a.Owner) && !IsSpawnedPart(a)).OrderBy(a => a.ActorID))
			{
				var uv = a.Location.ToMPos(world.Map);
				var facing = a.TraitOrDefault<IFacing>()?.Facing.Angle ?? 512;
				if (!first)
					sb.Append(',');
				first = false;
				var level = a.TraitOrDefault<GainsExperience>()?.Level ?? 0;
				var hp = a.TraitOrDefault<IHealth>();
				var pct = hp != null && hp.MaxHP > 0 ? (int)(100L * hp.HP / hp.MaxHP) : 100;
				sb.Append($"{{\"id\":{a.ActorID},\"type\":{J(a.Info.Name)},\"player\":{players.IndexOf(a.Owner)},\"x\":{uv.U},\"y\":{uv.V},\"facing\":{facing},\"level\":{level},\"health\":{pct}}}");
			}

			return sb.Append("]}").ToString();
		}

		/// <summary>
		/// Actors a placed actor brings along by itself (a building's free harvester, a wall's segments) are not placements
		/// of their own: re-spawning them would double them. Building placements are recorded at their top-left cell.
		/// </summary>
		static bool IsSpawnedPart(Actor a) => a.Info.HasTraitInfo<LineBuildInfo>();

		/// <summary>Issues orders and plays the acknowledgement voice, like CommandBarLogic.</summary>
		static void Issue(World world, IEnumerable<Order> orders)
		{
			var list = orders.ToArray();
			foreach (var o in list)
				world.IssueOrder(o);
			list.PlayVoiceForOrders();
		}

		/// <summary>The selection after a control-group command, plus where the group is (for a double-tap camera jump).</summary>
		static string SelectionReply(World world, int group = -1, IEnumerable<Actor> center = null, string extra = "")
		{
			var ids = world.Selection.Actors.Where(a => a.IsInWorld).Select(a => a.ActorID).ToList();
			var sb = new StringBuilder("{\"selection\":[").Append(string.Join(",", ids)).Append(']').Append(extra);
			// Viewport.Center(actors): the mean of their centre positions.
			var at = center?.Where(a => a.IsInWorld).ToList();
			if (at != null && at.Count > 0)
			{
				var px = SimHost.WorldRenderer.ScreenPxPosition(at.Select(a => a.CenterPosition).Average());
				sb.Append(",\"center\":[").Append(px.X).Append(',').Append(px.Y).Append(']');
			}

			if (group >= 0)
			{
				var members = world.ControlGroups.GetActorsInControlGroup(group).ToList();
				if (members.Count > 0)
				{
					var c = new WPos((int)members.Average(a => (long)a.CenterPosition.X), (int)members.Average(a => (long)a.CenterPosition.Y), 0);
					var px = SimHost.WorldRenderer.ScreenPxPosition(c);
					sb.Append(",\"center\":[").Append(px.X).Append(',').Append(px.Y).Append(']');
				}
			}

			return sb.Append('}').ToString();
		}

		// ---------------------------------------------------------------- cursors

		/// <summary>
		/// The mod's cursor set exactly as CursorManager loads it (Cursors in mod.yaml, their palettes, the hotspot
		/// relative to the frame centre): u32 header length, the JSON header
		/// [{"name","frames":[[x,y,w,h,offset]...]}] (x, y: the frame's top-left relative to the hotspot; offset into
		/// the RGBA payload), then the RGBA pixels.
		/// </summary>
		public static byte[] CursorSet()
		{
			var modData = Game.ModData;
			var pals = new Dictionary<string, IProvidesCursorPaletteInfo>();
			foreach (var p in modData.DefaultRules.Actors[SystemActors.World].TraitInfos<IProvidesCursorPaletteInfo>())
				if (p.Palette != null)
					pals[p.Palette] = p;

			var paletteCache = new Cache<string, ImmutablePalette>(p => pals[p].ReadPalette(modData.DefaultFileSystem));
			var frameCache = new FrameCache(modData.DefaultFileSystem, modData.SpriteLoaders);
			var header = new StringBuilder("[");
			var payload = new System.IO.MemoryStream();
			var first = true;
			foreach (var kv in modData.Cursors)
			{
				ISpriteFrame[] all;
				try { all = frameCache[kv.Value.Src]; }
				catch { continue; }

				var length = kv.Value.Length ?? all.Length - kv.Value.Start;
				var frames = all.Skip(kv.Value.Start).Take(length).ToArray();
				var palette = !string.IsNullOrEmpty(kv.Value.Palette) ? paletteCache[kv.Value.Palette] : null;
				header.Append(first ? "" : ",").Append("{\"name\":").Append(J(kv.Key)).Append(",\"frames\":[");
				first = false;
				for (var i = 0; i < frames.Length; i++)
				{
					var f = frames[i];
					var hotspot = int2.FromVector(f.Offset) - kv.Value.Hotspot - new int2(f.Size) / 2;
					var data = f.Type == SpriteFrameType.Indexed8 ? CursorManager.ConvertIndexedToBgra(kv.Key, f, palette) : f.Data;
					// BGRA (indexed frames resolve to BGRA) to RGBA.
					var rgba = new byte[f.Size.Width * f.Size.Height * 4];
					var swap = f.Type != SpriteFrameType.Rgba32;
					for (var k = 0; k + 3 < rgba.Length && k + 3 < data.Length; k += 4)
					{
						rgba[k] = swap ? data[k + 2] : data[k];
						rgba[k + 1] = data[k + 1];
						rgba[k + 2] = swap ? data[k] : data[k + 2];
						rgba[k + 3] = data[k + 3];
					}

					header.Append(i == 0 ? "" : ",").Append('[').Append(hotspot.X).Append(',').Append(hotspot.Y).Append(',')
						.Append(f.Size.Width).Append(',').Append(f.Size.Height).Append(',').Append(payload.Length).Append(']');
					payload.Write(rgba);
				}

				header.Append("]}");
			}

			var json = Encoding.UTF8.GetBytes(header.Append(']').ToString());
			var result = new byte[4 + json.Length + payload.Length];
			BitConverter.TryWriteBytes(result.AsSpan(0, 4), json.Length);
			json.CopyTo(result, 4);
			payload.ToArray().CopyTo(result, 4 + json.Length);
			return result;
		}

		// ---------------------------------------------------------------- cameos

		/// <summary>
		/// The build-palette cameo of an actor (its Buildable icon sequence in the producing faction's art and icon
		/// palette, exactly what ProductionPaletteWidget draws), as the sprite the page renders on the GPU:
		/// {"tex","channel","uv":[l,t,r,b],"w","h","pal"} or "" when the actor has no icon.
		/// </summary>
		public static string Icon(string actorName, string factionOverride = null)
		{
			var world = SimHost.World;
			if (world != null && actorName.StartsWith("$power:", StringComparison.Ordinal))
			{
				var manager = Local?.PlayerActor.TraitOrDefault<SupportPowerManager>();
				if (manager == null || !manager.Powers.TryGetValue(actorName[7..], out var power) || power.Info == null)
					return "";
				var icons = Local.PlayerActor.Info.TraitInfoOrDefault<FactionSupportPowerIconsInfo>();
				var original = icons != null && icons.Factions.Contains(factionOverride ?? Local.Faction.InternalName)
					&& power.Info.IconImage == icons.SourceImage
					&& world.Map.Sequences.HasSequence(icons.Image, power.Info.Icon);
				return SpriteIcon(original ? icons.Image : power.Info.IconImage, power.Info.Icon,
					original ? icons.Palette : power.Info.IconPalette);
			}
			if (world == null || !world.Map.Rules.Actors.TryGetValue(actorName, out var info))
				return "";

			var bi = info.TraitInfoOrDefault<BuildableInfo>();
			var rsi = info.TraitInfoOrDefault<RenderSpritesInfo>();
			if (rsi == null)
				return "";

			var faction = factionOverride ?? Queues(Local).Select(q => q.Faction).FirstOrDefault() ?? Local?.Faction.InternalName;
			var image = rsi.GetImage(info, faction);
			var sequence = bi?.Icon ?? "icon";
			if (!world.Map.Sequences.HasSequence(image, sequence))
				return "";

			var paletteName = bi == null ? "chrome" : bi.IconPaletteIsPlayerPalette ? bi.IconPalette + Local.InternalName : bi.IconPalette;
			return SpriteIcon(image, sequence, paletteName);
		}

		static string SpriteIcon(string image, string sequence, string paletteName)
		{
			var world = SimHost.World;
			if (!world.Map.Sequences.HasSequence(image, sequence))
				return "";
			var sprite = world.Map.Sequences.GetSequence(image, sequence).GetSprite(0);
			var palette = SimHost.WorldRenderer.Palette(paletteName);
			var tex = Snapshot.TextureId(sprite.Sheet);
			Snapshot.MarkTexture(tex);
			var inv = System.Globalization.CultureInfo.InvariantCulture;
			return $"{{\"tex\":{tex},\"channel\":{(int)sprite.Channel},\"uv\":[{sprite.Left.ToString(inv)},{sprite.Top.ToString(inv)},{sprite.Right.ToString(inv)},{sprite.Bottom.ToString(inv)}]," +
				$"\"w\":{sprite.Bounds.Width},\"h\":{sprite.Bounds.Height},\"pal\":{palette.TextureIndex},\"image\":{J(image)}}}";
		}
		/// <summary>CPU copy of a sprite's pixels (palette-resolved for indexed sheets) as [w][h][rgba...].</summary>
		public static byte[] Rasterise(Sprite sprite, IPalette palette)
		{
			var texture = (WebTexture)sprite.Sheet.GetTexture();
			var data = texture.Data;
			if (data == null)
				return [];

			var b = sprite.Bounds;
			var stride = texture.Size.Width * 4;
			var outBytes = new byte[8 + b.Width * b.Height * 4];
			BitConverter.TryWriteBytes(outBytes.AsSpan(0, 4), b.Width);
			BitConverter.TryWriteBytes(outBytes.AsSpan(4, 4), b.Height);
			var channel = (int)sprite.Channel;
			var channelByte = channel switch { 0 => 2, 1 => 1, 2 => 0, _ => 3 }; // Red, Green, Blue, Alpha in BGRA
			var o = 8;
			for (var y = 0; y < b.Height; y++)
			{
				var row = (b.Top + y) * stride;
				for (var x = 0; x < b.Width; x++, o += 4)
				{
					var i = row + (b.Left + x) * 4;
					if (sprite.Channel == TextureChannel.RGBA)
					{
						outBytes[o] = data[i + 2];
						outBytes[o + 1] = data[i + 1];
						outBytes[o + 2] = data[i];
						outBytes[o + 3] = data[i + 3];
					}
					else
					{
						var index = data[i + channelByte];
						if (index == 0)
							continue;

						var c = palette[index];
						outBytes[o] = (byte)(c >> 16);
						outBytes[o + 1] = (byte)(c >> 8);
						outBytes[o + 2] = (byte)c;
						outBytes[o + 3] = (byte)(c >> 24);
					}
				}
			}

			return outBytes;
		}

		// ---------------------------------------------------------------- shroud and radar

		static byte[] shroudCells;
		static int shroudHash = int.MinValue;

		/// <summary>
		/// Render player's shroud per projected cell (u, v) in MapSize order: 0 unexplored, 1 fogged, 2 visible.
		/// Returns null when unchanged since the last call (Shroud.Hash).
		/// </summary>
		public static byte[] Shroud(bool force = false)
		{
			var world = SimHost.World;
			var player = world?.RenderPlayer;
			if (world == null)
				return null;

			var map = world.Map;
			var w = map.MapSize.Width;
			var h = map.MapSize.Height;
			var shroud = player?.Shroud;
			var hash = shroud == null ? 0 : shroud.Hash;
			if (!force && shroudCells != null && hash == shroudHash && shroudCells.Length == w * h)
				return null;

			shroudHash = hash;
			shroudCells ??= new byte[w * h];
			if (shroudCells.Length != w * h)
				shroudCells = new byte[w * h];

			for (var v = 0; v < h; v++)
			{
				for (var u = 0; u < w; u++)
				{
					var pp = new PPos(u, v);
					byte s;
					if (shroud == null || shroud.Disabled)
						s = 2;
					else if (!map.Contains(pp))
						s = 0;
					else if (shroud.IsVisible(pp))
						s = 2;
					else if (shroud.IsExplored(pp))
						s = 1;
					else
						s = 0;
					shroudCells[v * w + u] = s;
				}
			}

			return shroudCells;
		}

		/// <summary>Radar terrain: RGBA, (2W+1) x H; cell (u, v) covers pixels (2u + (v &amp; 1)) and the one to its right.</summary>
		public static byte[] RadarTerrain()
		{
			var map = SimHost.World.Map;
			var w = map.MapSize.Width;
			var h = map.MapSize.Height;
			var iso = map.Grid.Type == MapGridType.RectangularIsometric;
			var iw = iso ? 2 * w + 1 : w;
			var px = new byte[iw * h * 4];
			for (var v = 0; v < h; v++)
			{
				for (var u = 0; u < w; u++)
				{
					var uv = new MPos(u, v);
					if (!map.Contains(uv))
						continue;

					var (left, right) = map.GetTerrainColorPair(uv);
					var x = iso ? 2 * u + (v & 1) : u;
					Put(px, (v * iw + x) * 4, left);
					if (iso) Put(px, (v * iw + x + 1) * 4, right);
				}
			}

			return px;
		}

		static void Put(byte[] px, int o, Color c)
		{
			px[o] = c.R;
			px[o + 1] = c.G;
			px[o + 2] = c.B;
			px[o + 3] = 255;
		}

		static readonly List<(CPos Cell, Color Color)> SignatureCells = [];

		/// <summary>Radar blips (RadarWidget.Tick): int32 triples (u, v, argb) for actors the render player can see.</summary>
		public static int[] RadarBlips()
		{
			var world = SimHost.World;
			var outList = new List<int>(1024);
			foreach (var t in world.ActorsWithTrait<IRadarSignature>())
			{
				if (!t.Actor.IsInWorld || world.FogObscures(t.Actor))
					continue;

				SignatureCells.Clear();
				t.Trait.PopulateRadarSignatureCells(t.Actor, SignatureCells);
				foreach (var (cell, color) in SignatureCells)
				{
					var uv = cell.ToMPos(world.Map);
					outList.Add(uv.U);
					outList.Add(uv.V);
					outList.Add((int)color.ToArgb());
				}
			}

			return outList.ToArray();
		}
	}
}
