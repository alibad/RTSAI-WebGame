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
using OpenRA.Mods.Common.Traits.Radar;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Mods.Common;
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
			sb.Append(",\"mode\":").Append(J(ModeName(world.OrderGenerator)));

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
					var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
					sb.Append("{\"name\":").Append(J(a.Name))
						.Append(",\"label\":").Append(J(tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name))
						.Append(",\"cost\":").Append(q.GetProductionCost(a))
						.Append(",\"time\":").Append(q.GetBuildTime(a, bi))
						.Append(",\"buildable\":").Append(buildable.Contains(a.Name) ? "true" : "false")
						.Append(",\"building\":").Append(a.HasTraitInfo<BuildingInfo>() ? "true" : "false")
						.Append('}');
				}

				sb.Append("]}");
			}

			sb.Append(']');
			return sb.ToString();
		}

		static string ModeName(IOrderGenerator og) => og switch
		{
			PlaceBuildingOrderGenerator => "place",
			SellOrderGenerator => "sell",
			RepairOrderGenerator => "repair",
			AttackMoveOrderGenerator => "attackmove",
			GuardOrderGenerator => "guard",
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

				// ---- battle sandbox (an editing world that does not tick; runs are rebuilt from the placements)
				case "units":
					return UnitCatalog(world);

				case "spawn":
				{
					var type = Str("type");
					var players = SimHost.PlayablePlayers();
					var side = Math.Clamp(Int("player"), 0, players.Count - 1);
					if (type == null || !world.Map.Rules.Actors.ContainsKey(type))
						return "{\"error\":\"unknown actor\"}";

					var center = SimHost.CellAtWorldPx(new int2(Int("x"), Int("y")));
					var count = Math.Clamp(Int("count", 1), 1, 50);
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

				case "group":
				{
					var i = Int("index");
					var groups = world.ControlGroups;
					switch (Str("action"))
					{
						case "create": groups.CreateControlGroup(i); break;
						case "add": groups.AddSelectionToControlGroup(i); break;
						case "combine": groups.CombineSelectionWithControlGroup(i); break;
						default: groups.SelectControlGroup(i); break;
					}

					return SelectionReply(world, i);
				}
			}

			return "{}";
		}

		/// <summary>Every buildable unit (infantry, vehicles, aircraft, ships) for the sandbox picker.</summary>
		static string UnitCatalog(World world)
		{
			var queues = new HashSet<string> { "Infantry", "Vehicle", "Aircraft", "Ship" };
			var sb = new StringBuilder("{\"units\":[");
			var first = true;
			foreach (var a in world.Map.Rules.Actors.Values.OrderBy(a => a.Name))
			{
				if (a.Name.StartsWith('^'))
					continue;
				var bi = a.TraitInfoOrDefault<BuildableInfo>();
				var queue = bi?.Queue.FirstOrDefault(queues.Contains);
				if (queue == null || !a.HasTraitInfo<RenderSpritesInfo>())
					continue;

				var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
				if (!first)
					sb.Append(',');
				first = false;
				sb.Append("{\"name\":").Append(J(a.Name))
					.Append(",\"label\":").Append(J(tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name))
					.Append(",\"queue\":").Append(J(queue))
					.Append(",\"modern\":").Append(a.Name.StartsWith("r2", StringComparison.Ordinal) ? "true" : "false")
					.Append('}');
			}

			return sb.Append("]}").ToString();
		}

		/// <summary>The playable players' units in the editing world as scenario spawns (type, player, MPos, facing).</summary>
		static string Placements(World world)
		{
			var players = SimHost.PlayablePlayers();
			var sb = new StringBuilder("{\"spawns\":[");
			var first = true;
			foreach (var a in world.Actors.Where(a => a.IsInWorld && !a.IsDead && a.OccupiesSpace != null && players.Contains(a.Owner) && !a.Info.HasTraitInfo<BuildingInfo>()).OrderBy(a => a.ActorID))
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

		/// <summary>Issues orders and plays the acknowledgement voice, like CommandBarLogic.</summary>
		static void Issue(World world, IEnumerable<Order> orders)
		{
			var list = orders.ToArray();
			foreach (var o in list)
				world.IssueOrder(o);
			list.PlayVoiceForOrders();
		}

		/// <summary>The selection after a control-group command, plus where the group is (for a double-tap camera jump).</summary>
		static string SelectionReply(World world, int group = -1)
		{
			var ids = world.Selection.Actors.Where(a => a.IsInWorld).Select(a => a.ActorID).ToList();
			var sb = new StringBuilder("{\"selection\":[").Append(string.Join(",", ids)).Append(']');
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

		// ---------------------------------------------------------------- cameos

		/// <summary>
		/// The build-palette cameo of an actor (its Buildable icon sequence in the producing faction's art and icon
		/// palette, exactly what ProductionPaletteWidget draws), as the sprite the page renders on the GPU:
		/// {"tex","channel","uv":[l,t,r,b],"w","h","pal"} or "" when the actor has no icon.
		/// </summary>
		public static string Icon(string actorName)
		{
			var world = SimHost.World;
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

			var sprite = world.Map.Sequences.GetSequence(image, sequence).GetSprite(0);
			var paletteName = bi == null ? "chrome" : bi.IconPaletteIsPlayerPalette ? bi.IconPalette + Local.InternalName : bi.IconPalette;
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
			var iw = 2 * w + 1;
			var px = new byte[iw * h * 4];
			for (var v = 0; v < h; v++)
			{
				for (var u = 0; u < w; u++)
				{
					var uv = new MPos(u, v);
					if (!map.Contains(uv))
						continue;

					var (left, right) = map.GetTerrainColorPair(uv);
					var x = 2 * u + (v & 1);
					Put(px, (v * iw + x) * 4, left);
					Put(px, (v * iw + x + 1) * 4, right);
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
