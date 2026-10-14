using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// Scripted players for the chapters a waypoint sweep cannot play (plans "stealth", "boarding", "finale"): each stands
/// in for a careful human who knows the map. They prove a mission can be finished and show where it bites; they are
/// not a measure of how hard it feels.
/// </summary>
static class Scripted
{
	public static Action<int> For(string plan, World world, Player human, Dictionary<string, Actor> named, Missions.Definition def) => plan switch
	{
		"stealth" => new Stealth(world, human, named, def).Tick,
		"boarding" => new Boarding(world, human, named).Tick,
		"finale" => new Finale(world, human, named).Tick,
		_ => null,
	};

	internal static bool Alive(Actor a) => a != null && a.IsInWorld && !a.IsDead;
	internal static CPos Cell(World world, int u, int v) => new MPos(u, v).ToCPos(world.Map);
	internal static void Issue(string order, Actor a, Target target, bool queued = false) => SimHost.IssueScripted(new Order(order, a, target, queued));
	internal static long Dist2(WPos a, WPos b) => (a - b).HorizontalLengthSquared;
	internal static IEnumerable<Actor> Enemies(World world, Player human) =>
		world.Actors.Where(a => Alive(a) && a.Owner != human && a.Owner.RelationshipWith(human) == PlayerRelationship.Enemy && a.OccupiesSpace != null);
	internal static void Log(World world, string text) => Console.WriteLine($"{world.WorldTick / 1500.0:F2} min: script {text}");

	/// <summary>Glass Island: the team walks a route of legs; a leg through a sensor zone starts only when that sensor's
	/// sweep is off for long enough to get across. Tanya and the Red Spear clear the guards at the core first.</summary>
	sealed class Stealth
	{
		readonly World world; readonly Player human; readonly Dictionary<string, Actor> named; readonly Missions.Definition def;
		// (u, v, step): "" moves the team, "clear" sends Tanya and the Red Spear ahead to clear guards around the cell,
		// "deploy" deploys the specialist there and waits for the logs.
		readonly (int U, int V, string Step)[] route =
		[
			(9, 44, ""), (19, 44, ""), (27, 45, ""), (40, 45, ""), (43, 45, ""), (49, 53, "clear"), (49, 53, ""), (56, 64, ""), (63, 67, ""),
			(70, 67, ""), (75, 64, ""), (83, 63, ""), (86, 58, "clear"), (86, 58, ""), (86, 58, "deploy"), (86, 52, ""), (81, 48, ""),
		];
		int leg, started = -1, waited;

		public Stealth(World world, Player human, Dictionary<string, Actor> named, Missions.Definition def)
		{
			this.world = world; this.human = human; this.named = named; this.def = def;
		}

		Actor[] Team => new[] { "Tanya", "Specialist", "RedSpear" }.Select(n => named[n]).Where(Alive).ToArray();

		bool SensorOn(Missions.Sensor s, int tick)
		{
			if (s.Sweep.Length < 2) return true;
			return (tick + s.Offset * 25) % ((s.Sweep[0] + s.Sweep[1]) * 25) < s.Sweep[0] * 25;
		}

		/// <summary>The part of the straight line from a to b within the sensor's radius plus half a cell of margin, as
		/// fractions of the line (null: it never comes that close).</summary>
		(double Enter, double Exit)? Crossing(WPos a, WPos b, Missions.Sensor s)
		{
			var c = named[s.Actor];
			if (!Alive(c)) return null;
			var r = (long)(s.Radius * 1024 + 512);
			double? enter = null, exit = null;
			for (var k = 0; k <= 40; k++)
			{
				var p = a + (b - a) * k / 40;
				if (Dist2(p, c.CenterPosition) > r * r) continue;
				enter ??= k / 40.0;
				exit = k / 40.0;
			}
			return enter == null ? null : (enter.Value, exit.Value);
		}

		readonly HashSet<string> seen = [];

		public void Tick(int i)
		{
			var team = Team;
			foreach (var s in def.Sensors.Where(s => !seen.Contains(s.Actor) && Missions.Tripped(s.Actor)))
			{
				seen.Add(s.Actor);
				var c = named[s.Actor].CenterPosition;
				Log(world, $"{s.Actor} tripped: " + string.Join(", ", world.Actors.Where(a => Alive(a) && a.Owner == human && a.OccupiesSpace != null)
					.Select(a => $"{a.Info.Name} {Math.Sqrt(Dist2(a.CenterPosition, c)) / 1024:F1} cells {a.Location.ToMPos(world.Map)}")));
			}
			if (leg >= route.Length || team.Length == 0) return;
			var (u, v, step) = route[leg];
			var cell = Cell(world, u, v);
			var target = world.Map.CenterOfCell(cell);
			var specialist = named["Specialist"];
			if (started >= 0)
			{
				var done = step switch
				{
					"clear" => !Enemies(world, human).Any(e => e.TraitOrDefault<Mobile>() != null && Dist2(e.CenterPosition, target) < 6L * 6 * 1024 * 1024)
						|| (i - started > 25 * 20 && team.Where(a => a != specialist).All(a => a.IsIdle)),
					"deploy" => Missions.FiredEvents.Contains("boat"),
					_ => i - started > 25 && team.All(a => a.IsIdle),
				};
				if (done || i - started > 25 * 90)
				{
					var near = Enemies(world, human).Where(e => Dist2(e.CenterPosition, target) < 8L * 8 * 1024 * 1024).Select(e => e.Info.Name)
						.Append($"specialist {Math.Sqrt(Dist2(specialist.CenterPosition, named["CoreNode"].CenterPosition)) / 1024:F1} cells from the core, {specialist.TraitOrDefault<GrantConditionOnDeploy>()?.DeployState}");
					Log(world, $"leg {leg} ({u},{v} {step}) done{(done ? "" : $" (timeout; near: {string.Join(",", near)})")} after {(i - started) / 25} s; team at "
						+ string.Join(" ", team.Select(a => $"{a.Info.Name}{a.Location.ToMPos(world.Map)}{(a.IsIdle ? "" : "*")}")));
					leg++; started = -1;
				}
				return;
			}
			if (step == "deploy")
			{
				Issue("GrantConditionOnDeploy", specialist, Target.Invalid);
				started = i; return;
			}
			// Wait at the leg start until every sweeping sensor on the way will be off while the movers are near it, from
			// the mover furthest from the leg's end: Tanya (a cell every 14 ticks) reaches a zone first, the specialist (a
			// cell every 19 ticks; reckoned at 20) leaves it last; half a second of margin either side. To clear, Tanya
			// and the Red Spear go ahead on an attack-move while the specialist waits.
			var movers = step == "clear" ? team.Where(a => a != specialist).ToArray() : team;
			if (movers.Length == 0) { leg++; return; }
			var from = movers.OrderByDescending(a => Dist2(a.CenterPosition, target)).First().CenterPosition;
			var ticks = Math.Sqrt(Dist2(from, target)) / 1024 * 20;
			var crossings = def.Sensors.Select(s => (s, c: Crossing(from, target, s))).Where(x => x.c != null).ToArray();
			(int First, int Last)? Window(Missions.Sensor s)
			{
				var w = movers.Select(a => (a, c: Crossing(a.CenterPosition, target, s))).Where(x => x.c != null)
					.Select(x => (Cells: Math.Sqrt(Dist2(x.a.CenterPosition, target)) / 1024, x.c.Value)).ToArray();
				return w.Length == 0 ? null : ((int)w.Min(x => x.Value.Enter * x.Cells * 13) - 12, (int)w.Max(x => x.Value.Exit * x.Cells * 20) + 12);
			}
			if (def.Sensors.Select(s => (s, w: Window(s))).Any(x => x.w != null
				&& Enumerable.Range(Math.Max(0, x.w.Value.First), x.w.Value.Last - Math.Max(0, x.w.Value.First) + 1).Any(t => SensorOn(x.s, world.WorldTick + t))))
			{
				waited++;
				return;
			}
			var blocked = crossings.Select(x => x.s).ToArray();
			Log(world, $"leg {leg} starts: waited {waited / 25} s; crosses {string.Join(", ", crossings.Select(x => $"{x.s.Actor} {x.c.Value.Enter:F2}-{x.c.Value.Exit:F2}"))} over {ticks / 25:F1} s");
			waited = 0;
			foreach (var a in movers) Issue(step == "clear" ? "AttackMove" : "Move", a, Target.FromCell(world, cell));
			started = i;
		}
	}

	/// <summary>Black Platform: the team crosses the catwalk and clears the control deck up the blind middle lane,
	/// an engineer takes the control room, the team sweeps both wings while Tanya charges the generators, then everyone
	/// holds the room.</summary>
	sealed class Boarding
	{
		readonly World world; readonly Player human; readonly Dictionary<string, Actor> named;
		int phase, started;

		public Boarding(World world, Player human, Dictionary<string, Actor> named) { this.world = world; this.human = human; this.named = named; }

		Actor[] Fighters => world.Actors.Where(a => Alive(a) && a.Owner == human && a.TraitOrDefault<Mobile>() != null && a.Info.Name != "engineer").ToArray();
		Actor Tanya => named["Tanya"];

		void Sweep(params (int U, int V)[] cells)
		{
			foreach (var a in Fighters.Where(a => a != Tanya))
				for (var k = 0; k < cells.Length; k++) Issue("AttackMove", a, Target.FromCell(world, Cell(world, cells[k].U, cells[k].V)), k > 0);
		}

		bool Clear((int U, int V) at, int cells) => !Enemies(world, human).Any(e => e.TraitOrDefault<Mobile>() != null
			&& Dist2(e.CenterPosition, world.Map.CenterOfCell(Cell(world, at.U, at.V))) < (long)cells * cells * 1024 * 1024);

		void Next(int i, string what) { Log(world, what); phase++; started = i; }

		public void Tick(int i)
		{
			if (!Alive(Tanya)) return;
			switch (phase)
			{
				case 0:
					Sweep((48, 62));
					Issue("AttackMove", Tanya, Target.FromCell(world, Cell(world, 48, 61)));
					Next(i, "the team crosses the catwalk");
					break;
				case 1:
					if (!Clear((48, 60), 6) && i - started < 25 * 60) break;
					Sweep((48, 55), (48, 52));
					Issue("AttackMove", Tanya, Target.FromCell(world, Cell(world, 48, 54)));
					Next(i, "the team clears the control deck");
					break;
				case 2:
					if (!Clear((47, 47), 7) && i - started < 25 * 60) break;
					var engineer = new[] { "Engineer1", "Engineer2" }.Select(n => named[n]).FirstOrDefault(Alive);
					if (engineer == null) { Next(i, "no engineer left"); phase = 99; break; }
					Issue("CaptureActor", engineer, Target.FromActor(named["CurtainControl"]));
					Next(i, $"{engineer.Info.Name} goes for the control room");
					break;
				case 3:
					if (named["CurtainControl"].Owner != human) { if (i - started > 25 * 60) { phase = 2; } break; }
					Sweep((35, 56), (35, 40), (40, 28), (48, 28), (56, 28), (61, 40), (61, 56));
					foreach (var gen in new[] { "GenSW", "GenNW", "GenNE", "GenSE" }) Issue("C4", Tanya, Target.FromActor(named[gen]), true);
					Next(i, "curtain down: the team sweeps the wings, Tanya charges the generators");
					break;
				case 4:
					if (new[] { "GenSW", "GenNW", "GenNE", "GenSE" }.Any(n => Alive(named[n])))
					{
						if (Tanya.IsIdle) foreach (var gen in new[] { "GenSW", "GenNW", "GenNE", "GenSE" }.Where(n => Alive(named[n]))) Issue("C4", Tanya, Target.FromActor(named[gen]), true);
						break;
					}
					Sweep((48, 52));
					Issue("AttackMove", Tanya, Target.FromCell(world, Cell(world, 48, 53)));
					Next(i, "generators down: everyone back to hold the control room");
					break;
			}
		}
	}

	/// <summary>Every Light On: the base keeps training tanks and riflemen; the army attack-moves to each dome in turn,
	/// then into the hub, taking on the guns it meets; when the strike unlocks, an engineer goes for the Chronosphere.</summary>
	sealed class Finale
	{
		readonly World world; readonly Player human; readonly Dictionary<string, Actor> named;
		readonly string[] targets = ["DomeWest", "DomeNorth", "DomeEast", "Chronosphere"];
		int target = -1, started;

		public Finale(World world, Player human, Dictionary<string, Actor> named) { this.world = world; this.human = human; this.named = named; }

		Actor[] Army => world.Actors.Where(a => Alive(a) && a.Owner == human && a.TraitOrDefault<Mobile>() != null
			&& a.TraitsImplementing<AttackBase>().Any() && a.Info.Name != "harv").ToArray();

		public void Tick(int i)
		{
			if (i % (25 * 20) == 0)
			{
				Ui.Command("{\"cmd\":\"produce\",\"queue\":\"Vehicle\",\"item\":\"r2m1a2s\",\"count\":2}");
				Ui.Command("{\"cmd\":\"produce\",\"queue\":\"Infantry\",\"item\":\"r2sang\",\"count\":2}");
			}
			if (Missions.FiredEvents.Contains("towns-clear") && named["Chronosphere"].Owner != human && i % 250 == 0)
			{
				var engineer = world.Actors.FirstOrDefault(a => Alive(a) && a.Owner == human && a.Info.Name == "engineer" && a.IsIdle);
				if (engineer != null) { Issue("CaptureActor", engineer, Target.FromActor(named["Chronosphere"])); Log(world, "an engineer goes for the Chronosphere"); }
			}
			// Domes until they fall (or three minutes), then the hub gate for good; idle units rejoin every 30 s.
			var current = target >= 0 ? named[targets[target]] : null;
			var last = target == targets.Length - 1;
			var down = current != null && !last && !Alive(current);
			if (target < 0 || down || (!last && i - started > 25 * 180))
			{
				if (target >= 0) Log(world, $"{targets[target]} {(down ? "down" : "timed out")}");
				do target++; while (target < targets.Length - 1 && !Alive(named[targets[target]]));
				started = i;
				foreach (var a in Army) Issue("AttackMove", a, Target.FromCell(world, named[targets[target]].Location));
				Log(world, $"army ({Army.Length}) to {targets[target]}");
			}
			else if (i % (25 * 10) == 0)
			{
				// Attack-moving units fight what shoots back but leave a dome standing: near it, they are ordered onto it.
				// Idle units go for the nearest gun or unit within reach, else rejoin the attack.
				var guns = Enemies(world, human).Where(e => e.TraitsImplementing<AttackBase>().Any()).ToArray();
				foreach (var a in Army)
				{
					var gun = guns.Where(e => Dist2(a.CenterPosition, e.CenterPosition) < 10L * 10 * 1024 * 1024).OrderBy(e => Dist2(a.CenterPosition, e.CenterPosition)).FirstOrDefault();
					if (!last && Alive(current) && Dist2(a.CenterPosition, current.CenterPosition) < 12L * 12 * 1024 * 1024) Issue("Attack", a, Target.FromActor(current));
					else if (a.IsIdle && gun != null) Issue("Attack", a, Target.FromActor(gun));
					else if (a.IsIdle) Issue("AttackMove", a, Target.FromCell(world, current.Location));
				}
			}
		}
	}
}
