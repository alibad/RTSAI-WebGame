using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using OpenRA;
using OpenRA.GameRules;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Projectiles;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// Every faction's whole roster, through the same visible-snapshot path as CombatEffectsTest: each unit killed by each
/// common damage type must leave something on screen (a death animation, an explosion, a husk or its fall), and each
/// weapon fired at each kind of target it can hit, and at bare ground and water as a miss, must draw an impact when it
/// has an effect warhead. `websim effectsaudit --root <unpacked root> [--factions a,b] [--out file.json]`; the exit code
/// is the number of failures, so a release can gate on it.
/// </summary>
static class EffectsAudit
{
	static readonly FieldInfo AnimationField = typeof(SpriteEffect).GetField("anim", BindingFlags.Instance | BindingFlags.NonPublic);
	const int DeathTicks = 150, ImpactTicks = 40, Near = 1536;

	sealed record Seen(int Frames, string[] Sequences, string[] Actors);

	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var rules = SimHost.ModData.DefaultRules;
		using var rosterJson = JsonDocument.Parse(Ui.Rosters(rules));
		var only = opts.TryGetValue("factions", out var list) ? list.Split(',').ToHashSet() : null;
		var map = opts.GetValueOrDefault("map", "twin-fords");

		// The damage a hit carries is a set (e.g. Prone50Percent, TriggerProne, ExplosionDeath): a unit is killed by each of
		// the sets weapons deal most often.
		var damageTypes = rules.Weapons.Values.SelectMany(w => w.Warheads.OfType<DamageWarhead>()).Where(d => d.DamageTypes.Any())
			.GroupBy(d => string.Join(", ", d.DamageTypes.Order())).OrderByDescending(g => g.Count())
			.Take(int.Parse(opts.GetValueOrDefault("damage-types", "12"))).Select(g => g.Key).ToArray();

		var deaths = new List<object>();
		var impacts = new List<object>();
		var weaponsWithoutExplosions = new SortedSet<string>();
		var failures = new List<string>();
		foreach (var faction in rosterJson.RootElement.GetProperty("rosters").EnumerateObject())
		{
			if (only != null && !only.Contains(faction.Name)) continue;
			var roster = faction.Value.EnumerateArray().Select(e => e.GetString()).Where(n => rules.Actors.ContainsKey(n)).Select(n => rules.Actors[n]).ToArray();
			var enemyFaction = faction.Name == "iran" ? "saudi" : "iran";
			SimHost.Start(new ScenarioSpec
			{
				Map = map, Bare = true, Sandbox = true,
				Players = [new PlayerSpec { Slot = "Multi0", Faction = faction.Name, Team = 1 }, new PlayerSpec { Slot = "Multi1", Faction = enemyFaction, Bot = "webidle", Team = 2 }],
				Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
			});
			var world = SimHost.World;
			var players = world.Players.Where(p => p.Playable).ToArray();
			var (own, enemy) = (players[0], players[1]);
			var cells = new Cells(world);

			// Deaths: every unit, every common damage type.
			foreach (var info in roster.Where(a => a.HasTraitInfo<HealthInfo>() && (a.HasTraitInfo<MobileInfo>() || a.HasTraitInfo<AircraftInfo>())))
				foreach (var type in damageTypes)
				{
					var victim = Spawn(world, info, own, cells.For(world, info));
					if (victim == null) { failures.Add($"{faction.Name} {info.Name}: no cell to place it"); break; }
					var at = victim.CenterPosition;
					var before = world.Actors.ToHashSet();
					victim.Kill(victim, new BitSet<DamageType>(type.Split(", ")));
					var seen = Watch(world, at, before, DeathTicks, victim);
					var ok = seen.Frames > 3;
					deaths.Add(new { faction = faction.Name, unit = info.Name, damage = type, ok, seen.Frames, seen.Sequences, seen.Actors });
					if (!ok) failures.Add($"{faction.Name} {info.Name} killed by {type}: nothing drawn");
					Clear(world, before);
				}

			// Impacts: every weapon an armed roster actor carries once its conditions are applied (the original countries'
			// renamed retail twins included), at each kind of target it can hit and at bare ground and water.
			var victims = new Dictionary<string, ActorInfo>
			{
				["vehicle"] = Pick(rules, a => a.HasTraitInfo<MobileInfo>() && !a.HasTraitInfo<AircraftInfo>() && a.Name is "mtnk" or "htnk" or "r2m1a2" or "r2merkava"),
				["infantry"] = rules.Actors.GetValueOrDefault("e1"),
				["building"] = rules.Actors.GetValueOrDefault("gapowr") ?? rules.Actors.GetValueOrDefault("napowr"),
				["aircraft"] = Pick(rules, a => a.Name is "orca" or "r2ah64sa"),
				["ship"] = Pick(rules, a => a.Name is "dest" or "aegis"),
			};
			foreach (var info in roster.Where(a => a.TraitInfos<ArmamentInfo>().Any()))
			{
				var shooter = Spawn(world, info, own, cells.For(world, info));
				if (shooter == null) continue;
				SimHost.Tick();
				var weapons = shooter.TraitsImplementing<Armament>().Where(a => !a.IsTraitDisabled).Select(a => a.Weapon).Distinct().ToArray();
				foreach (var weapon in weapons)
				{
					var name = rules.Weapons.First(w => w.Value == weapon).Key;
					var drawsEffects = weapon.Warheads.Any(w => w is CreateEffectWarhead c && c.Explosions.Length > 0);
					if (!drawsEffects) weaponsWithoutExplosions.Add($"{info.Name} {name}");
					foreach (var (kind, victimInfo) in victims.Where(v => v.Value != null).Select(v => (v.Key, v.Value)).Append(("ground", null)).Append(("water", null)))
					{
						var before = world.Actors.ToHashSet();
						Actor victim = null;
						Target target;
						if (victimInfo != null)
						{
							victim = Spawn(world, victimInfo, enemy, cells.For(world, victimInfo));
							if (victim == null) continue;
							target = Target.FromActor(victim);
							if (!weapon.IsValidAgainst(target, world, shooter)) { Clear(world, before); continue; }
						}
						else
						{
							// A miss lands on the ground or in the water; a shot that cannot miss never does.
							if (weapon.Projectile is null or InstantHitInfo) continue;
							var cell = kind == "water" ? cells.Water() : cells.Land();
							if (cell == null) continue;
							target = Target.FromPos(world.Map.CenterOfCell(cell.Value));
						}
						var at = target.CenterPosition;
						// No damage: the target stays alive, so whatever draws is the impact, not a death.
						weapon.Impact(target, new WarheadArgs { Weapon = weapon, SourceActor = shooter, Source = shooter.CenterPosition, WeaponTarget = target, ImpactPosition = at, DamageModifiers = [0] });
						var seen = Watch(world, at, before, ImpactTicks, null);
						var ok = !drawsEffects || seen.Frames > 0;
						impacts.Add(new { faction = faction.Name, shooter = info.Name, weapon = name, target = kind, drawsEffects, ok, seen.Frames, seen.Sequences });
						if (!ok) failures.Add($"{faction.Name} {info.Name} {name} on {kind}: has an explosion but nothing drawn");
						Clear(world, before);
					}
				}
				if (!shooter.Disposed) shooter.Dispose();
				SimHost.Tick();
			}

			SimHost.EndGame();
		}

		var report = new { passed = failures.Count == 0, damageTypes, failures, weaponsWithoutExplosions, deaths, impacts };
		var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = false });
		if (opts.TryGetValue("out", out var outFile)) File.WriteAllText(outFile, json);
		Console.WriteLine(JsonSerializer.Serialize(new { passed = failures.Count == 0, deaths = deaths.Count, impacts = impacts.Count, failures = failures.Count, first = failures.Take(40) }));
		return failures.Count;
	}

	static ActorInfo Pick(Ruleset rules, Func<ActorInfo, bool> match) => rules.Actors.Values.Where(match).OrderBy(a => a.Name).FirstOrDefault();

	static Actor Spawn(World world, ActorInfo info, Player owner, CPos? cell)
	{
		if (cell == null) return null;
		var air = info.HasTraitInfo<AircraftInfo>();
		var a = world.CreateActor(true, info.Name, new TypeDictionary
		{
			new OwnerInit(owner), new LocationInit(cell.Value), new FacingInit(WAngle.Zero),
			new CenterPositionInit(world.Map.CenterOfCell(cell.Value) + new WVec(0, 0, air ? 2048 : 0)), new SkipMakeAnimsInit()
		});
		SimHost.Tick();
		return a;
	}

	/// <summary>Frames in which something new is drawn near the spot: effects, new actors (husks) or the dying actor itself (a fall).</summary>
	static Seen Watch(World world, WPos at, HashSet<Actor> before, int ticks, Actor dying)
	{
		var frames = 0;
		var sequences = new HashSet<string>();
		var actors = new HashSet<string>();
		var wr = SimHost.WorldRenderer;
		var oldEffects = world.Effects.ToHashSet();
		for (var t = 0; t < ticks; t++)
		{
			SimHost.Tick();
			Snapshot.Build();
			var drawn = false;
			if (t == 3 && dying != null && Environment.GetEnvironmentVariable("EFFECTS_AUDIT_DEBUG") == dying.Info.Name)
				foreach (var e in world.Effects)
				{
					string r;
					try { r = e.Render(wr).Count() + " renderables"; } catch (Exception x) { r = "render threw " + x.Message; }
					var anim = e is SpriteEffect se ? AnimationField.GetValue(se) as Animation : null;
					Console.Error.WriteLine($"  {dying.Info.Name}: {e.GetType().Name} {anim?.Name}.{anim?.CurrentSequence?.Name} {r} inScreenMap={world.ScreenMap.RenderableEffectsInBox(new int2(-100000, -100000), new int2(100000, 100000)).Contains(e)}");
				}
			// Only what the snapshot sees: spatial effects registered in the ScreenMap, plus unpartitioned ones.
			foreach (var e in world.ScreenMap.RenderableEffectsInBox(new int2(-100000, -100000), new int2(100000, 100000)).Concat(world.UnpartitionedEffects))
			{
				if (oldEffects.Contains(e) || !e.Render(wr).Any(r => (r.Pos - at).HorizontalLength < Near)) continue;
				drawn = true;
				if (e is SpriteEffect s && AnimationField.GetValue(s) is Animation anim && anim.CurrentSequence != null) sequences.Add(anim.Name + "." + anim.CurrentSequence.Name);
				else sequences.Add(e.GetType().Name);
			}
			foreach (var a in world.Actors)
			{
				if ((before.Contains(a) && a != dying) || !a.IsInWorld || a.Disposed || (a.CenterPosition - at).HorizontalLength >= Near * 2 || !a.Render(wr).Any()) continue;
				drawn = true;
				actors.Add(a.Info.Name);
			}
			if (drawn) frames++;
		}
		return new Seen(frames, sequences.Order().ToArray(), actors.Order().ToArray());
	}

	static void Clear(World world, HashSet<Actor> keep)
	{
		foreach (var a in world.Actors.Where(a => !keep.Contains(a) && !a.Disposed && a.Owner.Playable).ToArray()) a.Dispose();
		for (var i = 0; i < 4; i++) SimHost.Tick();
	}

	/// <summary>Spread-out free cells near the map's middle, land and water, used round-robin.</summary>
	sealed class Cells
	{
		readonly List<CPos> land, water;
		int nextLand, nextWater;
		public Cells(World world)
		{
			var map = world.Map;
			var mid = map.CenterOfCell(map.AllCells.First(c => map.Contains(c)) + new CVec(map.Bounds.Width / 2, map.Bounds.Height / 2));
			var all = map.AllCells.Where(c => map.Contains(c)).OrderBy(c => (map.CenterOfCell(c) - mid).HorizontalLengthSquared).ToArray();
			List<CPos> Spread(Func<CPos, bool> ok)
			{
				var picked = new List<CPos>();
				foreach (var c in all)
					if (ok(c) && picked.All(p => (p - c).LengthSquared >= 36)) { picked.Add(c); if (picked.Count == 24) break; }
				return picked;
			}
			bool Around(CPos c, string type) => Enumerable.Range(-1, 3).All(dx => Enumerable.Range(-1, 3).All(dy => map.Contains(c + new CVec(dx, dy)) && map.GetTerrainInfo(c + new CVec(dx, dy)).Type == type));
			land = Spread(c => Around(c, "Clear"));
			water = Spread(c => Around(c, "Water"));
		}

		public CPos? Land() => land.Count == 0 ? null : land[nextLand++ % land.Count];
		public CPos? Water() => water.Count == 0 ? null : water[nextWater++ % water.Count];
		public CPos? For(World world, ActorInfo info)
		{
			if (info.HasTraitInfo<AircraftInfo>() || info.HasTraitInfo<BuildingInfo>()) return Land();
			var mobile = info.TraitInfoOrDefault<MobileInfo>();
			if (mobile == null) return Land();
			var locomotor = world.WorldActor.TraitsImplementing<Locomotor>().First(l => l.Info.Name == mobile.Locomotor);
			var pool = locomotor.MovementCostForCell(Land() ?? default) == short.MaxValue ? water : land;
			if (pool.Count == 0) return null;
			return pool == water ? Water() : Land();
		}
	}
}
