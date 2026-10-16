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
			public Sensor[] Sensors = [];
			public Event[] Events = [];

			/// <summary>An operation's outcome texts (campaign chapters keep theirs in the story).</summary>
			public string Victory, Defeat;

			/// <summary>An operation's reinforcement waves: where they enter (MPos u, v) and the unit types they field.</summary>
			public int[] WaveFrom = [];
			public string[] WaveUnits = [];
		}

		public sealed class Objective
		{
			public string Text, Kind, Target, Via, Entry;
			public string[] Targets = [], Types = [], Route = [], After = [];
			public string[][] Lanes = [];
			public int[] Requires = [], Area = [];
			public int Radius = 3, Count = 1, Seconds = 120, Allowed = 1, Until = -1, Limit;
			public bool Secondary, Deploy;
		}

		/// <summary>A detection zone around a named actor. While the actor stands and its sweep is on (Sweep: [on, off]
		/// seconds, shifted by Offset; always on without one), a player unit within Radius cells trips it, once.
		/// The actor's rules show it: conditions "sensor-on" and "sensor-tripped" (ExternalCondition), range circles.</summary>
		public sealed class Sensor
		{
			public string Actor;
			public int Radius = 5, Offset;
			public int[] Sweep = [];
		}

		/// <summary>What fires an event, the first field set: game seconds, objective n complete or failed, a sensor
		/// tripping ("*": any), a named actor lost, or another event.</summary>
		public sealed class Trigger
		{
			public int Time = -1, Objective = -1, Failed = -1;
			public string Detected, Killed, Event;
		}

		/// <summary>An event fires once (or every Repeat seconds until the Until event) Delay seconds after its trigger.</summary>
		public sealed class Event
		{
			public string Id, Until;
			public Trigger When = new();
			public int Delay, Repeat;
			public Spawn[] Spawn = [];
			public Reveal[] Reveal = [];
			public Grant[] Grant = [], Revoke = [];
			public string[] Conceal = [];
		}

		/// <summary>Units for a player (default: the enemy) at a named actor. The player's move to To; others attack-move
		/// to To, else to the trigger's site (the sensor or the lost actor), else to the nearest player unit.</summary>
		public sealed class Spawn
		{
			public string Owner, At, To;
			public string[] Types = [];
		}

		/// <summary>The player sees around a named actor (the whole map without one) for Seconds (0: until concealed).</summary>
		public sealed class Reveal
		{
			public string At;
			public int Radius = 8, Seconds;
		}

		/// <summary>An external condition (e.g. "invulnerability", the Iron Curtain's) on named actors.</summary>
		public sealed class Grant
		{
			public string Condition;
			public string[] Actors = [];
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
			public int Opened = -1;
			public bool Started;
		}

		sealed class Convoy
		{
			public Actor Actor;
			public string[] Route;
			public int Next;
			public bool Delivered;
		}

		sealed class SensorState
		{
			public Sensor Spec;
			public Actor Actor;
			public bool On, Tripped;
		}

		sealed class EventState
		{
			public Event Spec;
			public Actor Site;
			public int Due = -1;
			public bool Done;
			public readonly List<object> Reveals = [];
		}

		static readonly JsonSerializerOptions JsonOptions = new()
		{
			IncludeFields = true, PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase
		};
		static Definition[] catalog;
		static Definition current;
		static List<State> states = [];
		static List<SensorState> sensors = [];
		static List<EventState> events = [];
		static readonly List<string> fired = [];
		static readonly List<(int Tick, object Key)> expiring = [];
		static readonly HashSet<object> reveals = [];
		static readonly Dictionary<(uint Actor, string Condition), int> granted = [];
		static readonly object ConditionSource = new();
		static Dictionary<string, Actor> named;
		static Player human;
		static string difficulty;
		static int nextWave;
		static int lastWave;

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
		public static Definition ParseDefinition(string json) => JsonSerializer.Deserialize<Definition>(json, JsonOptions);
		public static bool Active => current != null;
		public static void Reset()
		{
			current = null; states.Clear(); named = null; human = null;
			sensors.Clear(); events.Clear(); fired.Clear(); expiring.Clear(); reveals.Clear(); granted.Clear();
		}

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
			sensors = current.Sensors.Select(x => new SensorState { Spec = x, Actor = Named(x.Actor) }).ToList();
			events = current.Events.Select(e => new EventState { Spec = e }).ToList();
			difficulty = SimHost.Scenario.Options.GetValueOrDefault("difficulty", "normal");
			nextWave = difficulty == "easy" ? 2250 : difficulty == "hard" ? 1000 : 1500;
			foreach (var s in states)
				foreach (var target in s.Spec.Targets.Concat(s.Spec.Route).Concat(s.Spec.Lanes.SelectMany(l => l))
					.Concat(new[] { s.Spec.Target, s.Spec.Via, s.Spec.Entry }).Where(t => !string.IsNullOrEmpty(t)))
					if (!named.ContainsKey(target)) throw new InvalidDataException("Mission target missing: " + target);
			// Events name actors and other events: a typo must not leave a mission without its reinforcements.
			var ids = current.Events.Select(e => e.Id).ToHashSet();
			var refs = current.Sensors.Select(x => x.Actor).Concat(current.Events.SelectMany(e => e.Spawn.SelectMany(sp => new[] { sp.At, sp.To })
				.Concat(e.Reveal.Select(r => r.At)).Concat(e.Grant.Concat(e.Revoke).SelectMany(g => g.Actors)).Append(e.When.Killed)
				.Append(e.When.Detected == "*" ? null : e.When.Detected)));
			foreach (var target in refs.Where(t => !string.IsNullOrEmpty(t)))
				if (!named.ContainsKey(target)) throw new InvalidDataException("Mission event actor missing: " + target);
			foreach (var e in current.Events.SelectMany(e => e.Conceal.Append(e.Until).Append(e.When.Event)).Concat(current.Objectives.SelectMany(o => o.After)))
				if (e != null && !ids.Contains(e)) throw new InvalidDataException("Mission event missing: " + e);
		}

		/// <summary>
		/// An operation: a mission the scenario defines (the simulator's missions from a real place). Its targets are the
		/// spawns' names; an objective whose target was taken off the battlefield is dropped. The human is the local player
		/// on any map, the enemy the player the definition names.
		/// </summary>
		public static void StartOperation(Definition operation, IReadOnlyDictionary<string, Actor> names)
		{
			Reset();
			human = SimHost.World.LocalPlayer;
			if (human == null || operation == null) return;
			named = new Dictionary<string, Actor>(names);
			bool Present(Objective o) => o.Targets.Concat(new[] { o.Target, o.Via }).Where(t => !string.IsNullOrEmpty(t)).All(named.ContainsKey);
			operation.Objectives = operation.Objectives.Where(Present).ToArray();
			operation.Protect = operation.Protect.Where(named.ContainsKey).ToArray();
			if (!operation.Objectives.Any(o => !o.Secondary)) return;
			current = operation;
			states = current.Objectives.Select(o => new State { Spec = o }).ToList();
			difficulty = SimHost.Scenario.Options.GetValueOrDefault("difficulty", "normal");
			nextWave = current.WaveUnits.Length == 0 ? int.MaxValue : difficulty == "easy" ? 2250 : difficulty == "hard" ? 1000 : 1500;
			lastWave = 0;
		}

		static bool Alive(Actor a) => a != null && a.IsInWorld && !a.IsDead;
		static Actor Named(string name) => name == null ? null : named.GetValueOrDefault(name);
		static bool Near(Actor a, Actor b, int radius) => Alive(a) && b != null && (a.CenterPosition - b.CenterPosition).HorizontalLengthSquared <= (long)radius * radius * 1024 * 1024;
		static IEnumerable<Actor> Own(World world) => world.Actors.Where(a => a.Owner == human && Alive(a));
		static IEnumerable<Actor> Units(World world) => Own(world).Where(a => a.OccupiesSpace != null && a.TraitOrDefault<Building>() == null);

		/// <summary>Protect, squad and stay-undetected objectives hold until the end: they complete with the mission.</summary>
		static bool Passive(string kind) => kind is "protect" or "squad" or "undetected";

		/// <summary>An objective counts only once the objectives it requires are complete and the events it waits for fired.</summary>
		static bool Open(Objective o) => o.Requires.All(r => states[r].Status == "complete") && o.After.All(fired.Contains);

		/// <summary>Timed objectives behind a gate count from the tick it opened; the others from the start.</summary>
		static int Since(State s) => s.Spec.Requires.Length > 0 || s.Spec.After.Length > 0 ? Math.Max(0, s.Opened) : 0;

		/// <summary>Sensor trips an undetected objective tolerates: one more on easy, one fewer on hard.</summary>
		static int Allowance(Objective o) => Math.Max(0, o.Allowed + (difficulty == "easy" ? 1 : difficulty == "hard" ? -1 : 0));

		/// <summary>An objective with a Limit fails if it is not complete by then (game seconds from the start, whether or not
		/// its gates have opened): half as long again on easy, a fifth shorter on hard.</summary>
		static int Deadline(Objective o) => difficulty == "easy" ? o.Limit * 3 / 2 : difficulty == "hard" ? o.Limit * 4 / 5 : o.Limit;
		static int Seen(Objective o) => sensors.Count(x => x.Tripped && (o.Targets.Length == 0 || o.Targets.Contains(x.Spec.Actor)));

		public static void Tick(World world)
		{
			if (current == null || human.WinState != WinState.Undefined) return;
			if (!Own(world).Any(a => a.TraitOrDefault<MustBeDestroyed>() != null)) { Finish(world, false); return; }
			foreach (var target in current.Protect)
				if (!Alive(Named(target))) { Finish(world, false); return; }
			var tripped = Sense(world);
			for (var i = 0; i < states.Count; i++)
			{
				var s = states[i]; var o = s.Spec;
				if (s.Status != "active") continue;
				if (o.Limit > 0 && world.WorldTick >= Deadline(o) * 25) { s.Status = "failed"; continue; }
				if (!Open(o)) continue;
				if (s.Opened < 0) s.Opened = world.WorldTick;
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
							if (Units(world).Any(a => Near(a, Named(t), o.Radius))) s.Scouted.Add(t);
						if (s.Scouted.Count == o.Targets.Length) s.Status = "complete";
						break;
					case "disperse":
						if (world.WorldTick - Since(s) >= o.Seconds * 25)
						{
							var exposed = Units(world).Count(a => InArea(world, a, o.Area));
							s.Status = exposed <= o.Allowed ? "complete" : "failed";
						}
						break;
					case "protect":
						if (o.Targets.Any(t => !Alive(Named(t)))) s.Status = "failed";
						break;
					case "squad":
						if (o.Targets.Count(t => Alive(Named(t))) < o.Count) s.Status = "failed";
						break;
					case "undetected":
						if (Seen(o) > Allowance(o)) s.Status = "failed";
						break;
					case "survive":
						if (world.WorldTick - Since(s) >= o.Seconds * 25) s.Status = "complete";
						break;
					case "defeat":
						// Every unit and building of the enemy player is gone (the attack force, a base).
						var enemy = world.Players.FirstOrDefault(p => p.InternalName == current.Enemy);
						if (enemy != null && !world.Actors.Any(a => a.Owner == enemy && Alive(a) && a.TraitOrDefault<MustBeDestroyed>() != null)) s.Status = "complete";
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
				// A passive objective can last only until another completes (keep an engineer alive until the capture).
				if (s.Status == "active" && o.Until >= 0 && states[o.Until].Status == "complete") s.Status = "complete";
			}
			RunEvents(world, tripped);
			if (states.Any(s => !s.Spec.Secondary && s.Status == "failed")) { Finish(world, false); return; }
			if (states.Where(s => !s.Spec.Secondary && !Passive(s.Spec.Kind)).All(s => s.Status == "complete"))
			{
				foreach (var s in states.Where(s => Passive(s.Spec.Kind) && s.Status == "active")) s.Status = "complete";
				Finish(world, true); return;
			}
			if (world.WorldTick >= nextWave) { Wave(world); lastWave = world.WorldTick; nextWave += difficulty == "easy" ? 2000 : difficulty == "hard" ? 850 : 1400; }
			else if (current.WaveUnits.Length > 0 && world.WorldTick >= lastWave + 250 && EnemyStrength(world) <= 3)
			{
				// An operation's attacker is never wiped out before the clock runs down: its next wave comes as soon as its
				// force is down to its last few (otherwise the engine would end the match as a conquest at once).
				Wave(world);
				lastWave = world.WorldTick;
			}
		}

		static bool InArea(World world, Actor a, int[] area)
		{
			var pos = a.Location.ToMPos(world.Map);
			return area.Length == 4 && pos.U >= area[0] && pos.V >= area[1] && pos.U <= area[2] && pos.V <= area[3];
		}

		static void Move(World world, Actor actor, CPos cell) => actor.QueueActivity(actor.Trait<IMove>().MoveTo(cell, 2, evaluateNearestMovableCell: true));

		/// <summary>Sweeps the sensors (their "sensor-on" condition follows) and trips those that see a player unit.</summary>
		static List<SensorState> Sense(World world)
		{
			var tripped = new List<SensorState>();
			if (sensors.Count == 0) return tripped;
			var units = Units(world).ToList();
			foreach (var x in sensors)
			{
				if (x.Tripped || !Alive(x.Actor)) continue;
				var sweep = x.Spec.Sweep;
				var on = sweep.Length < 2 || (world.WorldTick + x.Spec.Offset * 25) % ((sweep[0] + sweep[1]) * 25) < sweep[0] * 25;
				if (on != x.On) { x.On = on; SetCondition(x.Actor, "sensor-on", on); }
				if (!on || !units.Any(a => Near(a, x.Actor, x.Spec.Radius))) continue;
				x.Tripped = true;
				SetCondition(x.Actor, "sensor-tripped", true);
				tripped.Add(x);
			}
			return tripped;
		}

		static void SetCondition(Actor a, string condition, bool on)
		{
			var key = (a.ActorID, condition);
			var trait = a.TraitsImplementing<ExternalCondition>().FirstOrDefault(t => t.Info.Condition == condition);
			if (trait == null) return;
			if (on && !granted.ContainsKey(key) && trait.CanGrantCondition(ConditionSource)) granted[key] = trait.GrantCondition(a, ConditionSource);
			else if (!on && granted.Remove(key, out var token)) trait.TryRevokeCondition(a, ConditionSource, token);
		}

		static void RunEvents(World world, List<SensorState> tripped)
		{
			foreach (var e in events)
			{
				var w = e.Spec.When;
				if (e.Due < 0 && !e.Done)
				{
					Actor site = null;
					var met = w.Time >= 0 ? world.WorldTick >= w.Time * 25
						: w.Objective >= 0 ? states[w.Objective].Status == "complete"
						: w.Failed >= 0 ? states[w.Failed].Status == "failed"
						: w.Detected != null ? (site = tripped.FirstOrDefault(x => w.Detected == "*" || x.Spec.Actor == w.Detected)?.Actor) != null
						: w.Killed != null ? !Alive(site = Named(w.Killed))
						: w.Event != null && fired.Contains(w.Event);
					if (met) { e.Due = world.WorldTick + e.Spec.Delay * 25; e.Site = site; }
				}
				if (e.Due < 0 || world.WorldTick < e.Due) continue;
				if (e.Spec.Until != null && fired.Contains(e.Spec.Until)) { e.Due = -1; e.Done = true; continue; }
				Fire(world, e);
				if (e.Spec.Repeat > 0) e.Due += e.Spec.Repeat * 25;
				else { e.Due = -1; e.Done = true; }
			}
			foreach (var (_, key) in expiring.Where(x => world.WorldTick >= x.Tick).ToList())
			{
				expiring.RemoveAll(x => x.Key == key);
				Conceal(key);
			}
		}

		static void Fire(World world, EventState e)
		{
			foreach (var sp in e.Spec.Spawn) SpawnGroup(world, sp, e.Site);
			foreach (var r in e.Spec.Reveal)
			{
				var cells = string.IsNullOrEmpty(r.At) ? world.Map.ProjectedCells
					: Shroud.ProjectedCellsInRange(world.Map, Named(r.At).CenterPosition, WDist.Zero, WDist.FromCells(r.Radius)).ToArray();
				var key = new object();
				human.Shroud.AddSource(key, Shroud.SourceType.Visibility, cells);
				reveals.Add(key); e.Reveals.Add(key);
				if (r.Seconds > 0) expiring.Add((world.WorldTick + r.Seconds * 25, key));
			}
			foreach (var other in events.Where(x => e.Spec.Conceal.Contains(x.Spec.Id)))
				foreach (var key in other.Reveals) Conceal(key);
			foreach (var g in e.Spec.Grant)
				foreach (var a in g.Actors.Select(Named).Where(Alive)) SetCondition(a, g.Condition, true);
			foreach (var g in e.Spec.Revoke)
				foreach (var a in g.Actors.Select(Named).Where(Alive)) SetCondition(a, g.Condition, false);
			if (!fired.Contains(e.Spec.Id)) fired.Add(e.Spec.Id);
		}

		static void Conceal(object key)
		{
			if (reveals.Remove(key)) human.Shroud.RemoveSource(key);
		}

		static void SpawnGroup(World world, Spawn sp, Actor site)
		{
			var owner = world.Players.FirstOrDefault(p => p.InternalName == (sp.Owner ?? current.Enemy));
			var at = Named(sp.At);
			if (owner == null || at == null) return;
			var enemy = owner != human;
			// Enemy groups follow the difficulty: easy fields every other unit, hard half as many again.
			var types = !enemy ? sp.Types : difficulty == "easy" ? sp.Types.Where((_, i) => i % 2 == 0).ToArray()
				: difficulty == "hard" ? sp.Types.Concat(sp.Types.Take(sp.Types.Length / 2)).ToArray() : sp.Types;
			var used = new HashSet<CPos>();
			foreach (var type in types)
			{
				var mobile = world.Map.Rules.Actors[type].TraitInfoOrDefault<MobileInfo>();
				var cell = at.Location;
				foreach (var c in world.Map.FindTilesInCircle(at.Location, 8))
				{
					if (used.Contains(c) || world.ActorMap.GetActorsAt(c).Any()) continue;
					if (mobile != null && !mobile.CanEnterCell(world, null, c, check: BlockedByActor.None)) continue;
					cell = c;
					break;
				}
				used.Add(cell);
				var actor = world.CreateActor(true, type, new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName) });
				var to = Named(sp.To) ?? (enemy ? site ?? Units(world).MinByOrDefault(a => (a.CenterPosition - actor.CenterPosition).HorizontalLengthSquared) : null);
				if (to == null || actor.TraitOrDefault<IMove>() == null) continue;
				var destination = to.Location;
				if (enemy) actor.QueueActivity(new OpenRA.Mods.Common.Activities.AttackMoveActivity(actor, () => actor.Trait<IMove>().MoveTo(destination, 2, evaluateNearestMovableCell: true)));
				else Move(world, actor, destination);
			}
		}

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
			// Relay's authored defence phase is four minutes, then a counterattack on the surviving command post.
			// Endless free heavy-armour waves after that phase turned the counterattack into an economy trap.
			if (current.Id == "hezbollah-relay" && states.Any(s => s.Spec.Kind == "survive" && !s.Spec.Secondary && s.Status == "complete"))
				return;
			if (current.WaveUnits.Length > 0) { OperationWave(world); return; }
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

		static int EnemyStrength(World world)
		{
			var enemy = world.Players.FirstOrDefault(p => p.InternalName == current.Enemy);
			return enemy == null ? int.MaxValue : world.Actors.Count(a => a.Owner == enemy && Alive(a) && a.TraitOrDefault<MustBeDestroyed>() != null);
		}

		/// <summary>An operation's wave: its units from where the definition says, attack-moving on the human's base.</summary>
		static void OperationWave(World world)
		{
			var enemy = world.Players.FirstOrDefault(p => p.InternalName == current.Enemy);
			var target = Own(world).Where(a => a.TraitOrDefault<Building>() != null).OrderBy(a => a.ActorID).FirstOrDefault() ?? Own(world).FirstOrDefault();
			if (enemy == null || target == null || current.WaveFrom.Length != 2) return;
			var entry = new MPos(current.WaveFrom[0], current.WaveFrom[1]).ToCPos(world.Map);
			var count = difficulty == "easy" ? 2 : difficulty == "hard" ? 6 : 4;
			for (var i = 0; i < count; i++)
			{
				var type = current.WaveUnits[i % current.WaveUnits.Length];
				if (!world.Map.Rules.Actors.ContainsKey(type)) continue;
				var actor = world.CreateActor(true, type, new TypeDictionary { new OwnerInit(enemy), new LocationInit(entry + new CVec(i % 3, i / 3)), new FactionInit(enemy.Faction.InternalName) });
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
				current.Id, current.Title, Difficulty = difficulty, Events = fired, current.Victory, current.Defeat,
				Objectives = states.Select(s => new { s.Spec.Text, Status = Shown(s), s.Spec.Secondary, Waiting = s.Status == "active" && !Open(s.Spec),
					Progress = Progress(s), Markers = Markers(s.Spec) })
			}, JsonOptions);
		}

		/// <summary>The events fired so far, and whether a sensor has tripped (native tests and probes).</summary>
		public static IReadOnlyList<string> FiredEvents => fired.ToArray();
		public static bool Tripped(string actor) => sensors.Any(x => x.Tripped && x.Spec.Actor == actor);

		static string Progress(State s)
		{
			var o = s.Spec;
			var elapsed = s.Opened < 0 ? 0 : SimHost.World.WorldTick - Since(s);
			switch (o.Kind)
			{
				case "escort": case "shipping": return $"{s.Delivered}/{(o.Kind == "escort" && difficulty == "easy" ? 1 : o.Count)}";
				case "disperse": return $"Sweep at {o.Seconds / 60}:{o.Seconds % 60:00}; zone {string.Join(",", o.Area)}";
				case "survive": return $"{Math.Max(0, o.Seconds - elapsed / 25)} seconds remaining";
				case "squad": return $"{o.Targets.Count(t => Alive(Named(t)))}/{o.Targets.Length} alive";
				case "undetected":
					var spare = Allowance(o) - Seen(o);
					return spare > 0 ? $"{spare} alarm{(spare > 1 ? "s" : "")} to spare" : spare == 0 ? "no alarm to spare" : "";
				default:
					var left = o.Limit > 0 && s.Status == "active" ? Math.Max(0, Deadline(o) - SimHost.World.WorldTick / 25) : -1;
					return left >= 0 ? $"{left / 60}:{left % 60:00} left" : "";
			}
		}

		/// <summary>
		/// An objective's status as shown. An operation won by wiping the attacker out before the clock ran down (the
		/// engine's conquest) has held: its open objectives read as complete.
		/// </summary>
		static string Shown(State s) =>
			s.Status == "active" && current.WaveUnits.Length > 0 && human?.WinState == WinState.Won ? "complete" : s.Status;

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
