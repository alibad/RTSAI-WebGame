using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>Campaign objectives shared by the browser and native host. Only simulation ticks advance them.</summary>
	public static class Missions
	{
		public sealed class Definition
		{
			public string Id, Title, Faction, Campaign, Briefing, Adaptation, Slot, Enemy;
			public string[] Protect = [];
			public Objective[] Objectives = [];
		}

		public sealed class Objective
		{
			public string Text, Kind, Target, Via, Entry;
			public string[] Targets = [], Types = [], Route = [];
			public string[][] Lanes = [];
			public int[] Requires = [], Area = [];
			public int Radius = 3, Count = 1, Seconds = 120, Allowed = 1;
			public bool Secondary, Deploy;
		}

		sealed class State
		{
			public Objective Spec;
			public string Status = "active";
			public readonly HashSet<uint> Passed = [];
			public readonly HashSet<uint> Reached = [];
			public readonly HashSet<string> Scouted = [];
			public readonly List<Convoy> Convoys = [];
			public int Delivered;
			public bool Started;
		}

		sealed class Convoy
		{
			public Actor Actor;
			public string[] Route;
			public int Next;
			public bool Delivered;
		}

		static readonly JsonSerializerOptions JsonOptions = new()
		{
			IncludeFields = true, PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase
		};
		static Definition[] catalog;
		static Definition current;
		static List<State> states = [];
		static Dictionary<string, Actor> named;
		static Player human;
		static string difficulty;
		static int nextWave;

		public static Definition[] Catalog
		{
			get
			{
				if (catalog != null) return catalog;
				if (!SimHost.ModData.DefaultFileSystem.TryOpen("ra2|web/content/missions.json", out var stream)) return catalog = [];
				using (stream) return catalog = JsonSerializer.Deserialize<Definition[]>(stream, JsonOptions) ?? [];
			}
		}

		public static string CatalogJson() => JsonSerializer.Serialize(Catalog, JsonOptions);
		public static bool Active => current != null;
		public static void Reset() { current = null; states.Clear(); named = null; human = null; }

		public static void Start(string id)
		{
			Reset();
			if (string.IsNullOrEmpty(id)) return;
			current = Catalog.FirstOrDefault(m => m.Id == id) ?? throw new InvalidDataException("Unknown mission: " + id);
			if (SimHost.Scenario.Map != current.Id || SimHost.Scenario.Multiplayer)
				throw new InvalidDataException("Missions require their own single-player map.");
			human = SimHost.World.LocalPlayer;
			if (human == null || human.InternalName != current.Slot) throw new InvalidDataException("Invalid mission player slot.");
			named = SimHost.World.WorldActor.Trait<SpawnMapActors>().Actors;
			states = current.Objectives.Select(o => new State { Spec = o }).ToList();
			difficulty = SimHost.Scenario.Options.GetValueOrDefault("difficulty", "normal");
			nextWave = difficulty == "easy" ? 2250 : difficulty == "hard" ? 1000 : 1500;
			foreach (var s in states)
				foreach (var target in s.Spec.Targets.Concat(s.Spec.Route).Concat(s.Spec.Lanes.SelectMany(l => l))
					.Concat(new[] { s.Spec.Target, s.Spec.Via, s.Spec.Entry }).Where(t => !string.IsNullOrEmpty(t)))
					if (!named.ContainsKey(target)) throw new InvalidDataException("Mission target missing: " + target);
		}

		static bool Alive(Actor a) => a != null && a.IsInWorld && !a.IsDead;
		static Actor Named(string name) => named.GetValueOrDefault(name);
		static bool Near(Actor a, Actor b, int radius) => Alive(a) && b != null && (a.CenterPosition - b.CenterPosition).HorizontalLengthSquared <= (long)radius * radius * 1024 * 1024;
		static IEnumerable<Actor> Own(World world) => world.Actors.Where(a => a.Owner == human && Alive(a));

		public static void Tick(World world)
		{
			if (current == null || human.WinState != WinState.Undefined) return;
			if (!Own(world).Any(a => a.TraitOrDefault<MustBeDestroyed>() != null)) { Finish(world, false); return; }
			foreach (var target in current.Protect)
				if (!Alive(Named(target))) { Finish(world, false); return; }
			for (var i = 0; i < states.Count; i++)
			{
				var s = states[i]; var o = s.Spec;
				if (s.Status != "active") continue;
				if (o.Requires.Any(r => states[r].Status != "complete")) continue;
				switch (o.Kind)
				{
					case "destroy":
						if (o.Targets.All(t => !Alive(Named(t)))) s.Status = "complete";
						break;
					case "capture":
						if (o.Targets.Any(t => !Alive(Named(t)))) s.Status = "failed";
						else if (o.Targets.All(t => Named(t).Owner == human)) s.Status = "complete";
						break;
					case "build":
						if (o.Types.All(t => Own(world).Any(a => a.Info.Name == t))) s.Status = "complete";
						break;
					case "reach":
						foreach (var a in Own(world).Where(a => o.Types.Contains(a.Info.Name)))
						{
							if (!string.IsNullOrEmpty(o.Via) && Near(a, Named(o.Via), 8)) s.Passed.Add(a.ActorID);
							if ((string.IsNullOrEmpty(o.Via) || s.Passed.Contains(a.ActorID)) && Near(a, Named(o.Target), o.Radius)
								&& (!o.Deploy || a.TraitOrDefault<GrantConditionOnDeploy>()?.DeployState == DeployState.Deployed)) s.Reached.Add(a.ActorID);
						}
						if (s.Reached.Count >= (difficulty == "easy" ? 1 : o.Count)) s.Status = "complete";
						break;
					case "scout":
						foreach (var t in o.Targets)
							if (Own(world).Any(a => a.OccupiesSpace != null && a.TraitOrDefault<Building>() == null && Near(a, Named(t), o.Radius))) s.Scouted.Add(t);
						if (s.Scouted.Count == o.Targets.Length) s.Status = "complete";
						break;
					case "disperse":
						if (world.WorldTick >= o.Seconds * 25)
						{
							var exposed = Own(world).Count(a => a.OccupiesSpace != null && a.TraitOrDefault<Building>() == null && InArea(world, a, o.Area));
							s.Status = exposed <= o.Allowed ? "complete" : "failed";
						}
						break;
					case "protect":
						if (o.Targets.Any(t => !Alive(Named(t)))) s.Status = "failed";
						break;
					case "survive":
						if (world.WorldTick >= o.Seconds * 25) s.Status = "complete";
						break;
					case "escort": case "shipping":
						if (!s.Started) StartConvoy(world, s);
						foreach (var convoy in s.Convoys)
						{
							if (convoy.Delivered || !Alive(convoy.Actor)) continue;
							if (Near(convoy.Actor, Named(convoy.Route[convoy.Next]), o.Kind == "shipping" ? 4 : 3))
							{
								if (++convoy.Next >= convoy.Route.Length) { convoy.Delivered = true; s.Delivered++; continue; }
								Move(world, convoy.Actor, Named(convoy.Route[convoy.Next]).Location);
							}
						}
						var need = o.Kind == "shipping" ? o.Count : difficulty == "easy" ? 1 : o.Count;
						if (s.Delivered >= need) s.Status = "complete";
						else if (s.Delivered + s.Convoys.Count(c => !c.Delivered && Alive(c.Actor)) < need) s.Status = "failed";
						break;
				}
			}
			if (states.Any(s => !s.Spec.Secondary && s.Status == "failed")) { Finish(world, false); return; }
			if (states.Where(s => !s.Spec.Secondary && s.Spec.Kind != "protect").All(s => s.Status == "complete"))
			{
				foreach (var s in states.Where(s => s.Spec.Kind == "protect" && s.Status == "active")) s.Status = "complete";
				Finish(world, true); return;
			}
			if (world.WorldTick >= nextWave) { Wave(world); nextWave += difficulty == "easy" ? 2000 : difficulty == "hard" ? 850 : 1400; }
		}

		static bool InArea(World world, Actor a, int[] area)
		{
			var pos = a.Location.ToMPos(world.Map);
			return area.Length == 4 && pos.U >= area[0] && pos.V >= area[1] && pos.U <= area[2] && pos.V <= area[3];
		}

		static void Move(World world, Actor actor, CPos cell) => actor.QueueActivity(actor.Trait<IMove>().MoveTo(cell, 2, evaluateNearestMovableCell: true));

		static void StartConvoy(World world, State s)
		{
			s.Started = true;
			var o = s.Spec;
			var lanes = o.Kind == "shipping" ? o.Lanes : Enumerable.Range(0, 3).Select(_ => new[] { o.Entry }.Concat(o.Route).ToArray()).ToArray();
			var civilian = world.Players.FirstOrDefault(p => p.InternalName is "Civilians" or "Civilian Shipping") ?? human;
			for (var i = 0; i < lanes.Length; i++)
			{
				// Shipping lanes have separate entrances; offsetting the eastern one put it outside the map.
				var cell = Named(lanes[i][0]).Location + (o.Kind == "shipping" ? CVec.Zero : new CVec(i % 2, i / 2));
				var actor = world.CreateActor(true, o.Kind == "shipping" ? "lcrf" : "sapc", new TypeDictionary
				{
					new OwnerInit(civilian), new LocationInit(cell), new FactionInit(civilian.Faction.InternalName)
				});
				var c = new Convoy { Actor = actor, Route = lanes[i], Next = 1 };
				s.Convoys.Add(c); Move(world, actor, Named(c.Route[1]).Location);
			}
		}

		static void Wave(World world)
		{
			var enemy = world.Players.FirstOrDefault(p => p.InternalName == current.Enemy);
			var entry = named.FirstOrDefault(kv => kv.Key.Contains("GroundEntry") || kv.Key.Contains("WaveEntry") || kv.Key == "NorthEntry" || kv.Key == "WestEntry").Value;
			var target = Own(world).FirstOrDefault(a => a.TraitOrDefault<Building>() != null);
			if (enemy == null || entry == null || target == null) return;
			var count = difficulty == "easy" ? 2 : difficulty == "hard" ? 6 : 4;
			var type = enemy.Faction.InternalName switch { "yemen" => "r2technical", "saudi" => "r2m1a2s", "israel" => "r2merkava", _ => "htnk" };
			for (var i = 0; i < count; i++)
			{
				var actor = world.CreateActor(true, type, new TypeDictionary { new OwnerInit(enemy), new LocationInit(entry.Location + new CVec(i % 2, i / 2)), new FactionInit(enemy.Faction.InternalName) });
				actor.QueueActivity(new OpenRA.Mods.Common.Activities.AttackMoveActivity(actor, () => new OpenRA.Mods.Common.Activities.Move(actor, target.Location)));
			}
		}

		static void Finish(World world, bool won)
		{
			human.WinState = won ? WinState.Won : WinState.Lost;
			world.OnPlayerWinStateChanged(human);
		}

		public static string StateJson()
		{
			if (current == null) return "null";
			return JsonSerializer.Serialize(new
			{
				current.Id, current.Title, Difficulty = difficulty,
				Objectives = states.Select(s => new { s.Spec.Text, s.Status, s.Spec.Secondary,
					Progress = s.Spec.Kind is "escort" or "shipping" ? $"{s.Delivered}/{(s.Spec.Kind == "escort" && difficulty == "easy" ? 1 : s.Spec.Count)}" : s.Spec.Kind == "disperse" ? $"Sweep at {s.Spec.Seconds / 60}:{s.Spec.Seconds % 60:00}; zone {string.Join(",", s.Spec.Area)}" : s.Spec.Kind == "survive" ? $"{Math.Max(0, s.Spec.Seconds - SimHost.World.WorldTick / 25)} seconds remaining" : "",
					Markers = Markers(s.Spec) })
			}, JsonOptions);
		}

		static IEnumerable<object> Markers(Objective o)
		{
			if (o.Area.Length == 4)
			{
				var cell = new MPos((o.Area[0] + o.Area[2]) / 2, (o.Area[1] + o.Area[3]) / 2).ToCPos(SimHost.World.Map);
				var center = SimHost.WorldRenderer.ScreenPxPosition(SimHost.World.Map.CenterOfCell(cell));
				yield return new { Name = "SurveillanceZone", X = center.X, Y = center.Y };
			}
			var names = o.Targets.Concat(new[] { o.Target, o.Via }).Where(n => !string.IsNullOrEmpty(n)).Distinct();
			foreach (var name in names)
			{
				var a = Named(name);
				if (a == null) continue;
				var pos = SimHost.WorldRenderer.ScreenPxPosition(a.CenterPosition);
				yield return new { Name = name, X = pos.X, Y = pos.Y };
			}
		}
	}
}
