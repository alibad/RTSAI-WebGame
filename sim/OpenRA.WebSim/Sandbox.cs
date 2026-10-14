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

using System.Collections.Generic;
using System.Linq;
using System.Text;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The battle sandbox's results readout, measured from the running simulation: shots fired (weapon reloads
	/// starting), damage taken, kills, time to first kill and to eliminate a side, survivors by unit type.
	/// Read-only and unsynced: it only looks at the world after each tick.
	/// </summary>
	public static class Sandbox
	{
		sealed class Tracked
		{
			public int Side;
			public string Type;
			public int LastHp;
			public int[] LastDelay;
			public bool Dead;
		}

		sealed class TypeStat
		{
			public int Total, Alive, Shots;
			public long DamageTaken;
		}

		static List<Player> sides;
		static readonly Dictionary<Actor, Tracked> Actors = [];
		static readonly Dictionary<(int Side, string Type), TypeStat> Types = [];
		static readonly int[] Shots = new int[2], Kills = new int[2], Eliminated = new int[2];
		static readonly long[] DamageTaken = new long[2], HpStart = new long[2];
		static int startTick, firstKill;

		public static bool Active => sides != null;

		/// <summary>The world ended: drop its players and actors, which would otherwise keep it reachable.</summary>
		public static void Forget()
		{
			Actors.Clear();
			Types.Clear();
			sides = null;
		}

		public static void Start(List<Player> players)
		{
			Actors.Clear();
			Types.Clear();
			sides = players != null && players.Count >= 2 ? players.Take(2).ToList() : null;
			for (var i = 0; i < 2; i++)
			{
				Shots[i] = Kills[i] = 0;
				DamageTaken[i] = HpStart[i] = 0;
				Eliminated[i] = -1;
			}

			firstKill = -1;
			if (sides == null)
				return;

			var world = sides[0].World;
			startTick = world.WorldTick;
			foreach (var a in world.Actors)
			{
				var side = sides.IndexOf(a.Owner);
				var health = a.TraitOrDefault<IHealth>();
				if (side < 0 || health == null || a.OccupiesSpace == null || a.Info.HasTraitInfo<BuildingInfo>() || !a.IsInWorld)
					continue;

				Actors[a] = new Tracked
				{
					Side = side,
					Type = a.Info.Name,
					LastHp = health.HP,
					LastDelay = a.TraitsImplementing<Armament>().Select(x => x.FireDelay).ToArray(),
				};
				HpStart[side] += health.MaxHP;
				var t = Stat(side, a.Info.Name);
				t.Total++;
				t.Alive++;
			}
		}

		static TypeStat Stat(int side, string type)
		{
			if (!Types.TryGetValue((side, type), out var t))
				Types[(side, type)] = t = new TypeStat();
			return t;
		}

		public static void Tick(World world)
		{
			if (sides == null)
				return;

			foreach (var (a, tr) in Actors)
			{
				if (tr.Dead)
					continue;

				var stat = Stat(tr.Side, tr.Type);
				var health = a.Disposed ? null : a.TraitOrDefault<IHealth>();
				if (a.Disposed || !a.IsInWorld || health == null || health.IsDead)
				{
					tr.Dead = true;
					stat.Alive--;
					stat.DamageTaken += tr.LastHp;
					DamageTaken[tr.Side] += tr.LastHp;
					Kills[1 - tr.Side]++;
					if (firstKill < 0)
						firstKill = world.WorldTick;
					continue;
				}

				var hp = health.HP;
				if (hp < tr.LastHp)
				{
					stat.DamageTaken += tr.LastHp - hp;
					DamageTaken[tr.Side] += tr.LastHp - hp;
				}

				tr.LastHp = hp;

				var i = 0;
				foreach (var arm in a.TraitsImplementing<Armament>())
				{
					// A shot (or the first of a burst) restarts the weapon's delay.
					if (i < tr.LastDelay.Length && arm.FireDelay > tr.LastDelay[i])
					{
						stat.Shots++;
						Shots[tr.Side]++;
					}

					if (i < tr.LastDelay.Length)
						tr.LastDelay[i] = arm.FireDelay;
					i++;
				}
			}

			for (var s = 0; s < 2; s++)
				if (Eliminated[s] < 0 && Actors.Values.Any(t => t.Side == s) && Actors.Values.All(t => t.Side != s || t.Dead))
					Eliminated[s] = world.WorldTick;
		}

		static string Seconds(int tick) => tick < 0 ? "null" : ((tick - startTick) * 0.04).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);

		public static string Json()
		{
			if (sides == null)
				return "null";

			var world = sides[0].World;
			var sb = new StringBuilder("{");
			sb.Append($"\"elapsed\":{Seconds(world.WorldTick)},\"firstKill\":{Seconds(firstKill)},\"sides\":[");
			for (var s = 0; s < 2; s++)
			{
				if (s > 0)
					sb.Append(',');
				var alive = Actors.Values.Count(t => t.Side == s && !t.Dead);
				var total = Actors.Values.Count(t => t.Side == s);
				var hp = Actors.Values.Where(t => t.Side == s && !t.Dead).Sum(t => (long)t.LastHp);
				sb.Append($"{{\"alive\":{alive},\"total\":{total},\"hp\":{hp},\"hpStart\":{HpStart[s]},\"shots\":{Shots[s]},\"kills\":{Kills[s]},")
					.Append($"\"damageTaken\":{DamageTaken[s]},\"damageDealt\":{DamageTaken[1 - s]},\"eliminatedAt\":{Seconds(Eliminated[s])}}}");
			}

			sb.Append("],\"types\":[");
			sb.Append(string.Join(",", Types.OrderBy(kv => kv.Key.Side).ThenBy(kv => kv.Key.Type).Select(kv =>
				$"{{\"side\":{kv.Key.Side},\"type\":{Snapshot.Json(kv.Key.Type)},\"total\":{kv.Value.Total},\"alive\":{kv.Value.Alive},\"shots\":{kv.Value.Shots},\"damageTaken\":{kv.Value.DamageTaken}}}")));
			sb.Append("]}");
			return sb.ToString();
		}
	}
}
