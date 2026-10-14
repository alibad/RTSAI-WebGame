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
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Orders;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.RTSAI.Traits;
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

		/// <summary>
		/// Per-tick UI state as JSON. "catalog" (the buildable items per queue) is included only when it changed since
		/// the last call, so the page merges it; everything else is small and sent every tick.
		/// </summary>
		public static string State()
		{
			var world = SimHost.World;
			var p = Local;
			if (world == null || p == null)
				return "{}";

			var sb = new StringBuilder(1024);
			sb.Append("{\"tick\":").Append(world.WorldTick);
			sb.Append(",\"coach\":").Append(AiLab.CoachJson(world, p));

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
			sb.Append(",\"mission\":").Append(Missions.StateJson());
			sb.Append(",\"mode\":").Append(J(ModeName(world.OrderGenerator)));

			var selected = OwnSelection(world);
			var capabilities = new Dictionary<string, bool>
			{
				["attackmove"] = selected.Any(a => a.Info.HasTraitInfo<AttackMoveInfo>() && a.Info.HasTraitInfo<AutoTargetInfo>()),
				["guard"] = selected.Any(a => a.Info.HasTraitInfo<GuardInfo>() && a.Info.HasTraitInfo<AutoTargetInfo>()),
				["scatter"] = selected.Any(a => a.Info.HasTraitInfo<IMoveInfo>()),
				["deploy"] = selected.Any(a => a.TraitsImplementing<IIssueDeployOrder>().Any(d => d.CanIssueDeployOrder(a, false))),
				["stop"] = selected.Any(a => a.Info.TraitInfoOrDefault<CommandBarBlacklistInfo>()?.DisableStop != true),
			};
			sb.Append(",\"commands\":{").Append(string.Join(",", capabilities.Select(k => J(k.Key) + ":" + (k.Value ? "true" : "false")))).Append('}');
			sb.Append(",\"stances\":[").Append(string.Join(",", selected.SelectMany(a => a.TraitsImplementing<AutoTarget>())
				.Select(t => t.PredictedStance.ToString().ToLowerInvariant()).Distinct().Select(J))).Append(']');
			sb.Append(",\"supportPowers\":[");
			var powers = p.PlayerActor.TraitOrDefault<SupportPowerManager>()?.Powers.Values
				.Where(power => !power.Disabled && power.Info != null).OrderBy(power => power.Key);
			if (powers != null)
				sb.Append(string.Join(",", powers.Select(power => "{\"key\":" + J(power.Key) + ",\"name\":" + J(power.Name)
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

			var catalog = Catalog(p);
			if (catalog != lastCatalog)
			{
				lastCatalog = catalog;
				sb.Append(",\"catalog\":").Append(catalog);
			}

			sb.Append('}');
			return sb.ToString();
		}

		/// <summary>The page lost its state (a new game, a reload): send the catalog again with the next State().</summary>
		public static void Resync() => lastCatalog = null;

		/// <summary>Items per queue, in palette order, with cost, build time and whether they can be built now.</summary>
		static string Catalog(Player p)
		{
			var sb = new StringBuilder(2048);
			sb.Append('[');
			var first = true;
			foreach (var q in Queues(p))
			{
				if (!first)
					sb.Append(',');
				first = false;
				var buildable = q.BuildableItems().Select(a => a.Name).ToHashSet();
				sb.Append("{\"type\":").Append(J(q.Info.Group ?? q.Info.Type)).Append(",\"items\":[");
				var firstItem = true;
				foreach (var a in q.AllItems().OrderBy(a => a.TraitInfo<BuildableInfo>().BuildPaletteOrder))
				{
					if (!firstItem)
						sb.Append(',');
					firstItem = false;
					var bi = a.TraitInfo<BuildableInfo>();
					var power = a.TraitInfos<PowerInfo>().Where(i => i.EnabledByDefault).Sum(i => i.Amount);
					var canBuild = buildable.Contains(a.Name);
					sb.Append("{\"name\":").Append(J(a.Name))
						.Append(",\"label\":").Append(J(ActorLabel(a)))
						.Append(",\"cost\":").Append(q.GetProductionCost(a))
						.Append(",\"time\":").Append(q.GetBuildTime(a, bi))
						.Append(",\"power\":").Append(power)
						.Append(",\"buildable\":").Append(canBuild ? "true" : "false")
						.Append(",\"building\":").Append(a.HasTraitInfo<BuildingInfo>() ? "true" : "false");

					// The desktop production tooltip: description, and what is still missing to build it.
					if (bi.Description != null && FluentProvider.TryGetMessage(bi.Description, out var desc))
						sb.Append(",\"desc\":").Append(J(desc));
					if (!canBuild)
					{
						var rules = p.World.Map.Rules;
						var requires = bi.Prerequisites
							.Where(r => !r.StartsWith('~') && !r.StartsWith('!') && rules.Actors.ContainsKey(r))
							.Select(r => ActorLabel(rules.Actors[r])).Distinct().ToList();
						if (requires.Count > 0)
							sb.Append(",\"requires\":[").Append(string.Join(",", requires.Select(J))).Append(']');
					}

					sb.Append('}');
				}

				sb.Append("]}");
			}

			sb.Append(']');
			return sb.ToString();
		}

		static string ActorLabel(ActorInfo a)
		{
			var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			return tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name;
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
					.Append(",\"kind\":").Append(J(building != null ? (queue == "Support" ? "defense" : "building") : queue.ToLowerInvariant()))
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
			var worldInfo = rules.Actors[SystemActors.World];
			var queues = new HashSet<string> { "Infantry", "Vehicle", "Aircraft", "Ship", "Building", "Support" };
			bool InQueue(ActorInfo a) => a.TraitInfoOrDefault<BuildableInfo>()?.Queue.Any(queues.Contains) == true;

			// Who provides each prerequisite: actors nobody builds from a queue (the player, construction yards) always
			// count; a buildable provider counts once that faction can build it.
			var providers = new Dictionary<string, List<(ActorInfo Actor, FrozenSet<string> Factions)>>();
			foreach (var a in rules.Actors.Values)
				foreach (var p in a.TraitInfos<ProvidesPrerequisiteInfo>())
				{
					var name = p.Prerequisite ?? a.Name;
					if (!providers.TryGetValue(name, out var list))
						providers[name] = list = [];
					list.Add((a, p.Factions));
				}

			// A queue actor gated by a prerequisite nobody provides ("~disabled": the construction yards) is never built
			// from a palette; a faction gets it from its starting units (its MCV deploys into it).
			bool Unbuildable(ActorInfo a) => a.TraitInfo<BuildableInfo>().Prerequisites.Any(r => !r.Contains('!') && !providers.ContainsKey(r.Replace("~", "")));
			var buildable = rules.Actors.Values.Where(a => !a.Name.StartsWith('^') && a.HasTraitInfo<RenderSpritesInfo>() && InQueue(a) && !Unbuildable(a)).ToList();
			var startingUnits = worldInfo.TraitInfos<StartingUnitsInfo>().ToList();
			HashSet<ActorInfo> BaseOf(string faction)
			{
				var result = new HashSet<ActorInfo>();
				foreach (var su in startingUnits.Where(su => su.Factions.Count == 0 || su.Factions.Contains(faction)))
					foreach (var name in su.SupportActors.Append(su.BaseActor).Where(n => n != null))
						if (rules.Actors.TryGetValue(name.ToLowerInvariant(), out var actor))
						{
							result.Add(actor);
							var into = actor.TraitInfoOrDefault<TransformsInfo>()?.IntoActor;
							if (into != null && rules.Actors.TryGetValue(into, out var deployed))
								result.Add(deployed);
						}
				return result;
			}

			var sb = new StringBuilder("{\"rosters\":{");
			var first = true;
			foreach (var faction in worldInfo.TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0))
			{
				var f = faction.InternalName;
				var available = new HashSet<ActorInfo>();
				var baseActors = BaseOf(f);
				bool Base(ActorInfo a) => baseActors.Contains(a) || !a.HasTraitInfo<BuildableInfo>();
				bool Provided(string name) => providers.TryGetValue(name, out var list)
					&& list.Any(x => (x.Factions.Count == 0 || x.Factions.Contains(f)) && (Base(x.Actor) || available.Contains(x.Actor)));

				// Fixed point: a building unlocks what needs it, which may unlock more.
				for (var changed = true; changed;)
				{
					changed = false;
					foreach (var a in buildable)
					{
						if (available.Contains(a))
							continue;
						var ok = a.TraitInfo<BuildableInfo>().Prerequisites.All(req =>
						{
							var name = req.Replace("~", "").Replace("!", "");
							return Provided(name) != req.Contains('!');
						});
						if (ok)
						{
							available.Add(a);
							changed = true;
						}
					}
				}

				if (!first)
					sb.Append(',');
				first = false;
				// The faction's construction yard joins its roster: the simulator can drop a base without an MCV.
				var roster = buildable.Where(available.Contains)
					.Concat(baseActors.Where(b => !available.Contains(b) && b.HasTraitInfo<BuildableInfo>() && b.HasTraitInfo<RenderSpritesInfo>()));
				sb.Append(J(f)).Append(":[").Append(string.Join(",", roster.Select(a => J(a.Name)))).Append(']');
			}

			return sb.Append("}}").ToString();
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
			var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			var description = a.TraitInfoOrDefault<TooltipDescriptionInfo>()?.Description ?? a.TraitInfoOrDefault<BuildableInfo>()?.Description;
			var speed = a.TraitInfoOrDefault<MobileInfo>()?.Speed ?? a.TraitInfoOrDefault<AircraftInfo>()?.Speed ?? 0;
			var sight = a.TraitInfos<RevealsShroudInfo>().Select(r => r.Range.Length).DefaultIfEmpty(0).Max();
			var sb = new StringBuilder("{");
			sb.Append("\"name\":").Append(J(type))
				.Append(",\"label\":").Append(J(tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : type))
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
		public static string Icon(string actorName)
		{
			var world = SimHost.World;
			if (world != null && actorName.StartsWith("$power:", StringComparison.Ordinal))
			{
				var manager = Local?.PlayerActor.TraitOrDefault<SupportPowerManager>();
				if (manager == null || !manager.Powers.TryGetValue(actorName[7..], out var power) || power.Info == null)
					return "";
				return SpriteIcon(power.Info.IconImage, power.Info.Icon, power.Info.IconPalette);
			}
			if (world == null || !world.Map.Rules.Actors.TryGetValue(actorName, out var info))
				return "";

			var bi = info.TraitInfoOrDefault<BuildableInfo>();
			var rsi = info.TraitInfoOrDefault<RenderSpritesInfo>();
			if (rsi == null)
				return "";

			var faction = Queues(Local).Select(q => q.Faction).FirstOrDefault() ?? Local?.Faction.InternalName;
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
				$"\"w\":{sprite.Bounds.Width},\"h\":{sprite.Bounds.Height},\"pal\":{palette.TextureIndex}}}";
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
