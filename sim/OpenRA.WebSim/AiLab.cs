using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>Deterministic practice objectives and bounded, fog-respecting tactical doctrines.
	/// Existing native bots retain production and economy. This director only orders idle combat units.</summary>
	public static class AiLab
	{
		sealed class DoctrineState
		{
			public Player Player;
			public string Doctrine;
			public readonly List<object> Decisions = [];
		}
		static readonly List<DoctrineState> doctrines = [];
		static int startTick;
		static string status = "active";
		static string metrics;

		/// <summary>The world ended: drop its players, which would otherwise keep it reachable.</summary>
		public static void Forget() => doctrines.Clear();

		public static void Start()
		{
			doctrines.Clear(); startTick = SimHost.World.WorldTick; status = "active"; metrics = null;
			var players = SimHost.PlayablePlayers();
			for (var i = 0; i < players.Count; i++)
			{
				var d = SimHost.Scenario.Players[i].Doctrine;
				if (d != null && d != "standard")
				{
					if (d != "raider" && d != "sentinel" && d != "adaptive") throw new ArgumentException("Unknown doctrine: " + d);
					if (!players[i].IsBot) throw new ArgumentException("Doctrines require an AI opponent.");
					doctrines.Add(new DoctrineState { Player = players[i], Doctrine = d });
				}
			}
			if (SimHost.Scenario.Objective != null && SimHost.Scenario.Objective != "eliminate" && SimHost.Scenario.Objective != "survive")
				throw new ArgumentException("Unknown practice objective.");
		}
		static bool Alive(Actor a) => a.IsInWorld && !a.IsDead && !a.Disposed;
		static bool Fighter(Actor a) => a.OccupiesSpace != null && !a.Info.HasTraitInfo<BuildingInfo>() && a.Info.HasTraitInfo<AttackBaseInfo>();
		public static void Tick(World world)
		{
			if (world.WorldTick % 125 != 0 || SimHost.Scenario.Multiplayer) return;
			foreach (var d in doctrines)
			{
				if (d.Player.WinState != WinState.Undefined) continue;
				var own = world.Actors.Where(a => a.Owner == d.Player && Alive(a)).OrderBy(a => a.ActorID).ToArray();
				var enemies = world.Actors.Where(a => Alive(a) && a.OccupiesSpace != null && d.Player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && a.CanBeViewedByPlayer(d.Player)).OrderBy(a => a.ActorID).ToArray();
				var units = own.Where(a => Fighter(a) && a.IsIdle && a.TraitOrDefault<Mobile>() != null).Take(8).ToArray();
				if (units.Length == 0 || enemies.Length == 0) continue;
				var home = own.FirstOrDefault(a => a.Info.HasTraitInfo<BuildingInfo>()) ?? own.FirstOrDefault(Fighter);
				if (home == null) continue;
				var close = enemies.Where(a => (a.CenterPosition - home.CenterPosition).HorizontalLengthSquared < 16L * 16 * 1024 * 1024).ToArray();
				var outnumbered = enemies.Count(Fighter) > own.Count(Fighter) * 3 / 2;
				var retreat = d.Doctrine == "adaptive" && outnumbered;
				if (d.Doctrine == "sentinel" && close.Length == 0) continue;
				var target = retreat ? home : (close.Length > 0 ? close : enemies).OrderBy(a => (a.CenterPosition - units[0].CenterPosition).HorizontalLengthSquared).ThenBy(a => a.ActorID).First();
				var cell = target.Location;
				var issued = 0;
				foreach (var a in units)
				{
					// Native movement checks reject impassable destinations; attack-move resolves weapons normally.
					var destination = new[] { cell, cell + new CVec(1, 0), cell + new CVec(-1, 0), cell + new CVec(0, 1), cell + new CVec(0, -1) }
						.Where(c => world.Map.Contains(c) && a.Trait<Mobile>().CanEnterCell(c, check: BlockedByActor.Immovable)).ToArray();
					if (destination.Length == 0) continue;
					SimHost.IssueScripted(new Order(retreat ? "Move" : "AttackMove", a, Target.FromCell(world, destination[0]), false)); issued++;
				}
				if (issued > 0)
				{
					d.Decisions.Add(new { tick = world.WorldTick, mode = retreat ? "regroup" : close.Length > 0 ? "defend" : "pressure", units = issued, observedEnemies = enemies.Length });
					if (d.Decisions.Count > 200) d.Decisions.RemoveAt(0);
				}
			}
			if (SimHost.Scenario.Objective == null || status != "active") return;
			var sides = SimHost.PlayablePlayers();
			var ours = world.Actors.Any(a => a.Owner == sides[0] && Alive(a) && Fighter(a));
			var theirs = world.Actors.Any(a => a.Owner == sides[1] && Alive(a) && Fighter(a));
			var elapsed = (world.WorldTick - startTick) * world.Timestep / 1000;
			if (!ours) status = "failed";
			else if (SimHost.Scenario.Objective == "eliminate" && !theirs) status = "complete";
			else if (elapsed >= SimHost.Scenario.Duration) status = SimHost.Scenario.Objective == "survive" ? "complete" : "failed";
			if (status != "active") metrics = Sandbox.Json();
		}
		public static string StateJson() => JsonSerializer.Serialize(new {
			objective = SimHost.Scenario.Objective, duration = SimHost.Scenario.Duration, status,
			elapsed = (SimHost.World.WorldTick - startTick) * SimHost.World.Timestep / 1000,
			metrics = JsonSerializer.Deserialize<JsonElement>(metrics ?? "null"),
			doctrines = doctrines.Select(d => new { player = d.Player.InternalName, doctrine = d.Doctrine, decisions = d.Decisions })
		});
		public static string Validate(World world)
		{
			var errors = new List<string>();
			var sides = SimHost.PlayablePlayers();
			var actors = world.Actors.Where(a => Alive(a) && sides.Contains(a.Owner) && Fighter(a)).OrderBy(a => a.ActorID).ToArray();
			foreach (var p in sides) if (!actors.Any(a => a.Owner == p)) errors.Add("Each side needs at least one combat unit.");
			foreach (var a in actors)
			{
				if (!world.Map.Contains(a.Location)) { errors.Add(a.Info.Name + ": outside the map."); continue; }
				var mobile = a.TraitOrDefault<Mobile>();
				if (mobile == null) continue;
				if (!mobile.CanEnterCell(a.Location, a, BlockedByActor.Immovable)) errors.Add(a.Info.Name + ": invalid terrain.");
				// Ground connectivity is a terrain question: the target cell itself holds an enemy, which blocks every
				// vehicle (only allied movers step aside), so actors must not count here or no armour ever validates.
				var target = actors.FirstOrDefault(b => b.Owner != a.Owner);
				if (target != null && world.WorldActor.Trait<PathFinder>().FindPathToTargetCell(a, new[] { a.Location }, target.Location, BlockedByActor.None).Count == 0)
					errors.Add(a.Info.Name + ": no ground route to opposing force.");
			}
			// routes = "terrain": tells the page this runtime checks routes over terrain (older ones blocked on the target).
			return JsonSerializer.Serialize(new { valid = errors.Count == 0, errors, units = actors.Length, routes = "terrain" });
		}

		/// <summary>The co-commander's view of the player's side, written straight into Ui.State's builder every tick.</summary>
		public static void WriteCoachJson(System.Text.StringBuilder sb, World world, Player player)
		{
			sb.Append("{\"earned\":").Append(player.PlayerActor.TraitOrDefault<PlayerResources>()?.Earned ?? 0)
				.Append(",\"losses\":").Append(player.PlayerActor.TraitOrDefault<PlayerStatistics>()?.UnitsDead ?? 0)
				.Append(",\"actors\":[");
			var first = true;
			foreach (var a in world.Actors)
			{
				if (a.Owner != player || !Alive(a) || a.OccupiesSpace == null)
					continue;
				var px = SimHost.WorldRenderer.ScreenPxPosition(a.CenterPosition);
				if (!first)
					sb.Append(',');
				first = false;
				sb.Append("{\"id\":").Append(a.ActorID).Append(",\"building\":").Append(a.Info.HasTraitInfo<BuildingInfo>() ? "true" : "false")
					.Append(",\"x\":").Append(px.X).Append(",\"y\":").Append(px.Y).Append('}');
			}

			sb.Append("]}");
		}
	}
}
