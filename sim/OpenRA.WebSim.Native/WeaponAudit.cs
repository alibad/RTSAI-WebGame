using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using OpenRA;
using OpenRA.Effects;
using OpenRA.GameRules;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// How every weapon fires, flies, lands and looks, measured in the engine: each armed roster unit of every faction (and
/// its elite rank where that changes its guns) fires each of its weapons, through a real attack order, at a fitting
/// target at short, medium and maximum range in four directions. Every tick it records where the muzzle is, what the
/// muzzle overlay draws and where, every projectile's and beam's position and look, every sprite effect that spawns
/// (image, sequence, screen rectangle), the damage the target takes and the sounds named.
/// `websim weaponaudit --root &lt;vfs&gt; [--factions a,b] [--units a,b] [--out raw.json] [--trials full|quick]`.
/// Raw measurements only: tools/weapon-fidelity.mjs applies the thresholds, compares with Red Alert 2 and ranks causes.
/// </summary>
static class WeaponAudit
{
	const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
	static readonly FieldInfo SpriteAnim = typeof(SpriteEffect).GetField("anim", Any);
	static readonly FieldInfo SpritePos = typeof(SpriteEffect).GetField("pos", Any);
	static readonly FieldInfo MuzzleVisible = typeof(WithMuzzleOverlay).GetField("visible", Any);
	static readonly FieldInfo MuzzleAnims = typeof(WithMuzzleOverlay).GetField("anims", Any);
	static readonly FieldInfo BeamWidth = typeof(BeamRenderable).GetField("width", Any);
	static readonly FieldInfo BeamColor = typeof(BeamRenderable).GetField("color", Any);
	static readonly FieldInfo BeamLength = typeof(BeamRenderable).GetField("length", Any);
	const int MaxTicks = 320, Settle = 24;
	static readonly Dictionary<string, int> NoConditions = [];
	static readonly Dictionary<string, int> Airborne = new() { ["airborne"] = 1 };

	sealed class Track
	{
		public IEffect Effect;
		public string Kind, Type, Image, Weapon;
		public readonly SortedSet<string> Sequences = [];
		public int First, Last;
		public int[] SourcePx, EndPx, AimPx;
		public WPos? Aim;
		public WPos Source, End;
		public int VisibleTicks, Ticks;
		public Rectangle Rect;
		public readonly List<int[]> Path = [];
		public readonly List<object> Beams = [];
		public readonly SortedSet<string> Other = [];
	}

	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var rules = SimHost.ModData.DefaultRules;
		using var rosterJson = JsonDocument.Parse(Ui.Rosters(rules));
		var onlyFactions = opts.TryGetValue("factions", out var fl) ? fl.Split(',').ToHashSet() : null;
		var onlyUnits = opts.TryGetValue("units", out var ul) ? ul.Split(',').ToHashSet() : null;
		var quick = opts.GetValueOrDefault("trials", "full") == "quick";
		var weaponNames = rules.Weapons.GroupBy(w => w.Value).ToDictionary(g => g.Key, g => g.First().Key);
		var explosionImages = rules.Weapons.Values.SelectMany(w => w.Warheads.OfType<CreateEffectWarhead>()).Select(c => c.Image).Where(i => i != null).ToHashSet();

		var trials = new List<object>();
		var weapons = new SortedDictionary<string, object>();
		var skipped = new List<string>();
		var measured = new HashSet<string>();
		var started = DateTime.UtcNow;

		foreach (var faction in rosterJson.RootElement.GetProperty("rosters").EnumerateObject())
		{
			if (onlyFactions != null && !onlyFactions.Contains(faction.Name)) continue;
			var roster = faction.Value.EnumerateArray().Select(e => e.GetString()).Where(n => rules.Actors.ContainsKey(n) && (onlyUnits == null || onlyUnits.Contains(n)))
				.Select(n => rules.Actors[n]).Where(a => a.TraitInfos<ArmamentInfo>().Any()).ToArray();
			if (roster.Length == 0) continue;
			foreach (var naval in new[] { false, true })
			{
				var units = roster.Where(a => IsNaval(rules, a) == naval).ToArray();
				if (units.Length == 0) continue;
				var enemyFaction = faction.Name == "iran" ? "saudi" : "iran";
				SimHost.Start(new ScenarioSpec
				{
					Map = naval ? "ra2-little-big-lake" : "twin-fords", Bare = true, Sandbox = true,
					Players = [new PlayerSpec { Slot = "Multi0", Faction = faction.Name, Team = 1 }, new PlayerSpec { Slot = "Multi1", Faction = enemyFaction, Bot = "webidle", Team = 2 }],
					Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False", ["shortgame"] = "False" }
				});
				var world = SimHost.World;
				var wr = SimHost.WorldRenderer;
				var players = world.Players.Where(p => p.Playable).ToArray();
				var (own, enemy) = (players[0], players[1]);

				// A bare map leaves both sides with nothing that must be destroyed: each gets a soldier far away, holding
				// fire, so neither loses (a lost side's new units are killed on the spot).
				var corners = new[] { world.Map.AllCells.First(c => world.Map.Contains(c) && world.Map.GetTerrainInfo(c).Type == "Clear"),
					world.Map.AllCells.Last(c => world.Map.Contains(c) && world.Map.GetTerrainInfo(c).Type == "Clear") };
				foreach (var (p, c) in new[] { (own, corners[0]), (enemy, corners[1]) })
				{
					var anchor = Spawn(world, rules.Actors["e1"], p, c, WAngle.Zero);
					anchor.TraitOrDefault<AutoTarget>()?.SetStance(anchor, UnitStance.HoldFire);
				}
				foreach (var p in players)
				{
					var dev = p.PlayerActor.TraitOrDefault<DeveloperMode>();
					if (dev != null && !dev.UnlimitedPower) dev.ResolveOrder(p.PlayerActor, new Order("DevUnlimitedPower", p.PlayerActor, false));
				}

				SimHost.Tick();
				var origin = Origin(world, naval);
				foreach (var info in units)
				{
					var levels = new List<int> { 0 };
					var gains = info.TraitInfoOrDefault<GainsExperienceInfo>();
					if (gains != null && gains.Conditions.Count > 0) levels.Add(gains.Conditions.Count);
					foreach (var level in levels)
					{
						// Which armaments this unit has at this rank for this owner (the original countries' twins included).
						var probe = Spawn(world, info, own, origin, WAngle.Zero);
						if (probe == null) { skipped.Add($"{faction.Name} {info.Name}: no cell to place it"); break; }
						if (level > 0) probe.TraitOrDefault<GainsExperience>()?.GiveLevels(level, true);
						for (var i = 0; i < 3; i++) SimHost.Tick();
						if (probe.Disposed || probe.IsDead) { skipped.Add($"{faction.Name} {info.Name}: died on spawn (owner {own.WinState})"); Console.Error.WriteLine($"{info.Name} died on spawn, owner {own.WinState}"); continue; }
						var arms = probe.TraitsImplementing<Armament>().Where(a => !a.IsTraitDisabled).GroupBy(a => a.Weapon).Select(g => g.First()).ToArray();
						var signature = $"{info.Name}|{string.Join(",", arms.Select(a => weaponNames[a.Weapon]).Order())}";
						var muzzleImage = probe.TraitOrDefault<RenderSprites>()?.GetImage(probe);
						probe.Dispose();
						SimHost.Tick();
						if (arms.Length == 0 || !measured.Add(signature)) continue;
						foreach (var arm in arms)
						{
							var weapon = arm.Weapon;
							var name = weaponNames[weapon];
							if (!weapons.ContainsKey(name)) weapons[name] = Facts(weapon);
							var victimInfo = PickVictim(world, rules, weapon, own, enemy, naval);
							if (victimInfo == null) { skipped.Add($"{faction.Name} {info.Name} {name}: no standard target it can hit"); continue; }
							var min = Math.Max(weapon.MinRange.Length + 384, 1024 + 512);
							var max = Math.Max(min, weapon.Range.Length - 320);
							var ranges = new List<(string, int)> { ("short", min), ("medium", (min + max) / 2), ("max", max) };
							var facings = quick ? new[] { 256 } : new[] { 0, 256, 512, 768 };
							foreach (var (rangeName, distance) in ranges.DistinctBy(r => r.Item2))
								foreach (var (angle, moving) in (rangeName == "medium" || quick ? facings.Take(quick ? 1 : 4) : facings.Take(2)).Select(f => (f, false))
									.Concat(rangeName == "medium" && !quick ? [(256, true)] : [])
									.Concat(rangeName == "medium" && info.Name == "atesla" ? [(768, false)] : []))
								{
									// The Prism Tower once more with two towers beside it, to see their support beams.
									var supporters = info.Name == "atesla" && rangeName == "medium" && angle == 768 && !moving ? 2 : 0;
									var trial = Trial(world, wr, info, level, arm.Info.Name, name, weaponNames, victimInfo, own, enemy, origin, distance, angle, explosionImages, muzzleImage, moving, supporters);
									if (trial == null) { skipped.Add($"{faction.Name} {info.Name} {name} {rangeName} {angle}: target cell not placeable"); continue; }
									trial["faction"] = faction.Name;
									trial["range"] = rangeName;
									trials.Add(trial);
								}
						}
					}
				}

				SimHost.EndGame();
			}
		}

		var report = new { passed = true, seconds = (DateTime.UtcNow - started).TotalSeconds, trials, weapons, skipped };
		var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = false });
		if (opts.TryGetValue("out", out var outFile)) File.WriteAllText(outFile, json);
		Console.WriteLine(JsonSerializer.Serialize(new { passed = true, trials = trials.Count, weapons = weapons.Count, skipped = skipped.Count, seconds = (int)(DateTime.UtcNow - started).TotalSeconds }));
		return 0;
	}

	static bool IsNaval(Ruleset rules, ActorInfo info)
	{
		var mobile = info.TraitInfoOrDefault<MobileInfo>();
		if (mobile == null) return false;
		var loco = rules.Actors[SystemActors.World].TraitInfos<LocomotorInfo>().FirstOrDefault(l => l.Name == mobile.Locomotor);
		return loco != null && loco.TerrainSpeeds.TryGetValue("Water", out var w) && w.Speed > 0 && (!loco.TerrainSpeeds.TryGetValue("Clear", out var c) || c.Speed == 0);
	}

	/// <summary>A standard target the weapon can hit: a heavy tank first, else a soldier, a building, a ship, an aircraft.</summary>
	static ActorInfo PickVictim(World world, Ruleset rules, WeaponInfo weapon, Player own, Player enemy, bool naval)
	{
		var order = naval ? new[] { "dest", "aegis", "htnk", "mtnk", "e1", "napowr", "gapowr", "shad", "orca" } : new[] { "htnk", "mtnk", "e1", "napowr", "gapowr", "dest", "shad", "orca" };
		foreach (var name in order)
		{
			if (!rules.Actors.TryGetValue(name, out var info)) continue;
			// The target types it has when it stands there with no conditions granted (not parachuting, not damaged).
			var symbols = info.HasTraitInfo<AircraftInfo>() ? Airborne : NoConditions;
			var types = info.TraitInfos<TargetableInfo>().Where(t => t.RequiresCondition == null || t.RequiresCondition.Evaluate(symbols))
				.SelectMany(t => t.GetTargetTypes()).ToHashSet();
			if (weapon.IsValidTarget(new BitSet<TargetableType>(types.Select(t => t.ToString()).ToArray()))) return info;
		}

		return null;
	}

	static CPos Origin(World world, bool naval)
	{
		var map = world.Map;
		var mid = map.CenterOfCell(map.AllCells.First(c => map.Contains(c)) + new CVec(map.Bounds.Width / 2, map.Bounds.Height / 2));
		var want = naval ? "Water" : "Clear";
		// The cell with the most cells of the wanted terrain within 9 cells (a lake's middle, an open field).
		return map.AllCells.Where(c => map.Contains(c) && map.GetTerrainInfo(c).Type == want)
			.OrderByDescending(c => map.FindTilesInCircle(c, 9).Count(x => map.Contains(x) && map.GetTerrainInfo(x).Type == want))
			.ThenBy(c => (map.CenterOfCell(c) - mid).HorizontalLengthSquared).First();
	}

	static Actor Spawn(World world, ActorInfo info, Player owner, CPos cell, WAngle facing)
	{
		var air = info.HasTraitInfo<AircraftInfo>();
		var a = world.CreateActor(true, info.Name, new TypeDictionary
		{
			new OwnerInit(owner), new LocationInit(cell), new FacingInit(facing),
			new CenterPositionInit(world.Map.CenterOfCell(cell) + new WVec(0, 0, air ? 2048 : 0)), new SkipMakeAnimsInit()
		});
		return a;
	}

	static Dictionary<string, object> Trial(World world, WorldRenderer wr, ActorInfo info, int level, string armName, string weaponName,
		Dictionary<WeaponInfo, string> weaponNames, ActorInfo victimInfo, Player own, Player enemy, CPos origin, int distance, int angle,
		HashSet<string> explosionImages, string muzzleImage, bool moving = false, int supporters = 0)
	{
		var map = world.Map;
		var before = world.Actors.ToHashSet();
		var known = world.Effects.ToHashSet();
		var shooterPos = map.CenterOfCell(origin);
		var aim = shooterPos + new WVec(0, -distance, 0).Rotate(WRot.FromYaw(new WAngle(angle)));
		var cell = map.CellContaining(aim);
		var victimMobile = victimInfo.TraitInfoOrDefault<MobileInfo>();
		var air = victimInfo.HasTraitInfo<AircraftInfo>();
		if (!map.Contains(cell)) return null;
		if (victimMobile != null)
		{
			var loco = world.WorldActor.TraitsImplementing<Locomotor>().First(l => l.Info.Name == victimMobile.Locomotor);
			var free = map.FindTilesInAnnulus(cell, 0, 2).Where(c => map.Contains(c) && loco.MovementCostForCell(c) != short.MaxValue)
				.OrderBy(c => Math.Abs((map.CenterOfCell(c) - shooterPos).HorizontalLength - distance)).ThenBy(c => (c - cell).LengthSquared).Cast<CPos?>().FirstOrDefault();
			if (free == null) return null;
			cell = free.Value;
		}
		else if (!air && map.GetTerrainInfo(cell).Type != "Clear")
		{
			var clear = map.FindTilesInAnnulus(cell, 0, 2).Where(c => map.Contains(c) && map.GetTerrainInfo(c).Type == "Clear").Cast<CPos?>().FirstOrDefault();
			if (clear == null) return null;
			cell = clear.Value;
		}

		var shooter = Spawn(world, info, own, origin, WAngle.Zero);
		for (var i = 0; i < supporters; i++)
		{
			var donor = Spawn(world, info, own, origin + new CVec(i == 0 ? -2 : 0, i == 0 ? 2 : 4), WAngle.Zero);
			donor.TraitOrDefault<AutoTarget>()?.SetStance(donor, UnitStance.HoldFire);
		}
		if (level > 0) shooter.TraitOrDefault<GainsExperience>()?.GiveLevels(level, true);
		SimHost.Tick();
		shooter.TraitOrDefault<AutoTarget>()?.SetStance(shooter, UnitStance.HoldFire);
		var victim = Spawn(world, victimInfo, enemy, cell, new WAngle(angle + 512));
		// The target never shoots back: holding fire from its first tick, every armament paused for good measure.
		victim.TraitOrDefault<AutoTarget>()?.SetStance(victim, UnitStance.HoldFire);
		SimHost.Tick();
		SimHost.Tick();
		if (!OriginalRa2Rules.Alive(shooter) || !OriginalRa2Rules.Alive(victim)) { Clear(world, before, known); return null; }
		victim.CancelActivity();
		if (moving)
		{
			// A target driving (or flying) across the line of fire at its own speed, 8 cells sideways.
			var across = victim.CenterPosition + new WVec(0, -8192, 0).Rotate(WRot.FromYaw(new WAngle(angle + 256)));
			var dest = map.Clamp(map.CellContaining(across));
			victim.ResolveOrder(new Order("Move", victim, Target.FromCell(world, dest), false));
		}
		var health = victim.Trait<IHealth>();
		var arm = shooter.TraitsImplementing<Armament>().First(a => a.Info.Name == armName && !a.IsTraitDisabled);
		var victimCentre = victim.CenterPosition;
		var victimRect = Union(victim.ScreenBounds(wr));
		var shooterRect = Union(shooter.ScreenBounds(wr));
		var target = Target.FromActor(victim);
		shooter.ResolveOrder(new Order("Attack", shooter, target, false));

		var tracks = new List<Track>();
		var fires = new List<object>();
		var muzzles = new List<object>();
		var muzzleOverlays = shooter.TraitsImplementing<WithMuzzleOverlay>().ToArray();
		var prev = shooter.TraitsImplementing<Armament>().ToDictionary(a => a, a => (a.Burst, a.FireDelay));
		int damage = 0, lastHp = health.HP, lastActivity = -1, t = 0;
		var victimPath = new List<int[]>();
		var killed = false;
		for (; t < MaxTicks; t++)
		{
			SimHost.Tick();
			if (!OriginalRa2Rules.Alive(shooter)) break;

			// Shots: an armament's burst counter moved or its reload restarted.
			foreach (var a in shooter.TraitsImplementing<Armament>())
			{
				var (burst, delay) = prev[a];
				if (!a.IsTraitDisabled && (a.Burst != burst || a.FireDelay > delay))
				{
					fires.Add(new
					{
						tick = t, armament = a.Info.Name, weapon = weaponNames[a.Weapon], facing = (shooter.TraitOrDefault<IFacing>()?.Facing.Angle ?? 0),
						muzzles = a.Barrels.Select(b => Px(wr, shooter.CenterPosition + a.MuzzleOffset(shooter, b))).ToArray(),
						muzzlesWorld = a.Barrels.Select(b => W(shooter.CenterPosition + a.MuzzleOffset(shooter, b))).ToArray(),
						centre = Px(wr, shooter.CenterPosition)
					});
					lastActivity = t;
				}

				prev[a] = (a.Burst, a.FireDelay);
			}

			// Muzzle overlays drawn this tick, and where.
			foreach (var mo in muzzleOverlays)
			{
				if (mo.IsTraitDisabled) continue;
				var vis = (Dictionary<Barrel, bool>)MuzzleVisible.GetValue(mo);
				var anims = (Dictionary<Barrel, AnimationWithOffset>)MuzzleAnims.GetValue(mo);
				foreach (var (barrel, on) in vis)
				{
					if (!on) continue;
					var anim = anims[barrel];
					var owner = shooter.TraitsImplementing<Armament>().FirstOrDefault(a => a.Barrels.Contains(barrel));
					var tip = owner != null ? shooter.CenterPosition + owner.MuzzleOffset(shooter, barrel) : shooter.CenterPosition;
					var rect = Union(anim.Render(shooter, wr.Palette(owner?.Info.MuzzlePalette ?? "effect")).Select(r => r is SpriteRenderable sr ? VisibleRect(sr, wr) : r.PrepareRender(wr).ScreenBounds(wr)));
					muzzles.Add(new
					{
						tick = t, armament = owner?.Info.Name, image = anim.Animation.Name, sequence = anim.Animation.CurrentSequence?.Name,
						frame = anim.Animation.CurrentFrame, length = anim.Animation.CurrentSequence?.Length ?? 0,
						tip = Px(wr, tip), drawn = Px(wr, shooter.CenterPosition + anim.OffsetFunc()), rect = R(rect)
					});
				}
			}

			// New effects, and every live one's state.
			var live = world.Effects.ToHashSet();
			foreach (var e in live)
			{
				if (!known.Add(e)) continue;
				var track = new Track { Effect = e, First = t, Type = e.GetType().Name };
				if (e is SpriteEffect se)
				{
					track.Kind = "sprite";
					track.Image = (SpriteAnim.GetValue(se) as Animation)?.Name;
				}
				else if (e is IProjectile)
				{
					track.Kind = "projectile";
					var args = Field<ProjectileArgs>(e);
					if (args != null)
					{
						track.Weapon = weaponNames.GetValueOrDefault(args.Weapon);
						track.Source = args.Source;
						track.SourcePx = Px(wr, args.Source);
						// Where it was sent: a shell's landing point (with any inaccuracy), a missile's aim.
						track.Aim = Field<WPos?>(e, "target") ?? Field<WPos?>(e, "targetPosition");
						if (track.Aim != null) track.AimPx = Px(wr, track.Aim.Value);
						// The Prism's flat line before 20 Nov 2026, measured the same way, for the comparison.
						if (e.GetType().Name == "OriginalRa2Laser")
						{
							var width = new WDist(track.Weapon is "ea-retail-prismshot" or "ea-retail-prismsupport" ? 70 : 50);
							var to = Field<WPos?>(e, "target") ?? args.Source;
							var old = new BeamRenderable(args.Source, 2047, to - args.Source, BeamRenderableShape.Cylindrical, width, args.SourceActor.OwnerColor());
							track.Beams.Add(new { tick = t, type = "Before (flat LaserZap line)", light = Light(old, wr, Px(wr, args.Source), Px(wr, to)) });
						}
					}
				}
				else track.Kind = "other";
				tracks.Add(track);
			}

			foreach (var track in tracks.Where(k => live.Contains(k.Effect)))
			{
				track.Last = t;
				track.Ticks++;
				var renderables = SafeRender(track.Effect, wr);
				var spriteRects = new List<Rectangle>();
				foreach (var r in renderables)
				{
					if (r is SpriteRenderable sr)
					{
						var b = VisibleRect(sr, wr);
						if (b.Width > 0 && b.Height > 0) spriteRects.Add(b);
					}
					else if (r is BeamRenderable br)
					{
						var width = (WDist)BeamWidth.GetValue(br);
						var color = (Color)BeamColor.GetValue(br);
						var length = (WVec)BeamLength.GetValue(br);
						track.Beams.Add(new { tick = t, type = "BeamRenderable", widthPx = wr.ScreenVector(new WVec(width, WDist.Zero, WDist.Zero))[0], argb = new int[] { color.A, color.R, color.G, color.B }, from = Px(wr, br.Pos), to = Px(wr, br.Pos + length),
							light = Light(br, wr, Px(wr, br.Pos), Px(wr, br.Pos + length)) });
					}
					else
					{
						track.Other.Add(r.GetType().Name);
						// Beams and lasers of any kind: what the page draws for them, measured from the captured draws.
						if (track.Kind == "projectile" && track.SourcePx != null)
						{
							// Measured along where it is drawn (a renderable's own ends when it has them).
							var from = Field<WPos?>(r, "from") ?? track.Source;
							var to = Field<WPos?>(r, "to") ?? Field<WPos?>(track.Effect, "target") ?? track.Source;
							var light = Light(r, wr, Px(wr, from), Px(wr, to));
							if (light != null) track.Beams.Add(new { tick = t, type = r.GetType().Name, light });
						}
					}
				}

				if (spriteRects.Count > 0)
				{
					track.VisibleTicks++;
					track.Rect = track.Rect.IsEmpty ? Union(spriteRects) : Rectangle.Union(track.Rect, Union(spriteRects));
				}

				if (track.Effect is SpriteEffect s && SpriteAnim.GetValue(s) is Animation an && an.CurrentSequence != null)
				{
					track.Sequences.Add(an.CurrentSequence.Name);
					track.End = (WPos)SpritePos.GetValue(s);
				}
				else
				{
					var pos = Position(track.Effect);
					if (pos != null) track.End = pos.Value;
					var targetPos = Field<WPos?>(track.Effect, "target");
					if (pos == null && targetPos != null) track.End = targetPos.Value;
				}

				track.EndPx = Px(wr, track.End);
				if (track.Kind == "projectile" && (track.Path.Count == 0 || track.Path[^1][0] != track.EndPx[0] || track.Path[^1][1] != track.EndPx[1]))
					track.Path.Add([t, track.EndPx[0], track.EndPx[1], track.End.Z]);
				lastActivity = Math.Max(lastActivity, t);
			}

			// Damage the target takes; keep it alive so later shots have something to hit.
			if (OriginalRa2Rules.Alive(victim))
			{
				var vp = Px(wr, victim.CenterPosition);
				victimPath.Add([t, vp[0], vp[1], victim.CenterPosition.X, victim.CenterPosition.Y, victim.CenterPosition.Z]);
				if (health.HP < lastHp) damage += lastHp - health.HP;
				if (health.HP < health.MaxHP * 6 / 10) health.InflictDamage(victim, victim, new Damage(-(health.MaxHP - health.HP)), true);
				lastHp = health.HP;
			}
			else if (!killed) { killed = true; damage += lastHp; }

			if (fires.Count > 0 && t - lastActivity > Settle && !tracks.Any(k => live.Contains(k.Effect))) break;
			if (fires.Count == 0 && t > 200) break;
		}

		var result = new Dictionary<string, object>
		{
			["unit"] = info.Name, ["level"] = level, ["armament"] = armName, ["weapon"] = weaponName, ["target"] = victimInfo.Name,
			["muzzleSequence"] = arm.Info.MuzzleSequence, ["muzzleOverlay"] = muzzleOverlays.Any(m => !m.IsTraitDisabled), ["barrels"] = arm.Barrels.Length,
			["shooterKind"] = info.HasTraitInfo<BuildingInfo>() ? "building" : info.HasTraitInfo<AircraftInfo>() ? "aircraft"
				: info.TraitInfos<TargetableInfo>().Any(t => t.TargetTypes.Contains("Infantry")) ? "infantry" : IsNaval(world.Map.Rules, info) ? "ship" : "vehicle",
			["distance"] = (victimCentre - shooterPos).HorizontalLength, ["angle"] = angle, ["ticks"] = t, ["killed"] = killed, ["damage"] = damage,
			["victimHp"] = health.MaxHP, ["victimCentre"] = Px(wr, victimCentre), ["victimCentreWorld"] = W(victimCentre), ["victimRect"] = R(victimRect),
			["shooterCentre"] = Px(wr, shooterPos), ["shooterRect"] = R(shooterRect), ["muzzleImage"] = muzzleImage,
			["fires"] = fires, ["muzzles"] = muzzles, ["moving"] = moving, ["supporters"] = supporters, ["victimPath"] = moving ? victimPath : victimPath.Take(1).ToList(),
			["tracks"] = tracks.Select(k => new
			{
				k.Kind, k.Type, k.Image, k.Weapon, sequences = k.Sequences.ToArray(), first = k.First, last = k.Last, k.Ticks, k.VisibleTicks,
				source = k.SourcePx, sourceWorld = k.SourcePx == null ? null : W(k.Source), aim = k.AimPx, aimWorld = k.Aim == null ? null : W(k.Aim.Value), end = k.EndPx, endWorld = W(k.End), rect = R(k.Rect),
				explosion = k.Image != null && explosionImages.Contains(k.Image), path = k.Path, beams = k.Beams, other = k.Other.ToArray()
			}).ToArray()
		};
		Clear(world, before, known);
		return result;
	}

	/// <summary>
	/// The light a non-sprite renderable adds over plain grass, from the quads the engine sends the page (the same
	/// recording the snapshot replays): across the beam at its middle, the peak contrast with the grass, the width where
	/// the contrast is at least 0.25 and 0.1, how white the brightest point is, and the lit area around each end.
	/// </summary>
	static object Light(IRenderable r, WorldRenderer wr, int[] from, int[] to)
	{
		Capture.Begin();
		try
		{
			r.PrepareRender(wr).Render(wr);
			Game.Renderer.Flush();
		}
		catch (Exception) { return null; }
		finally { Capture.End(); }

		var verts = Capture.Vertices.ToArray();
		var batches = Capture.Batches.ToArray();
		if (verts.Length == 0) return null;
		var tris = new List<(System.Numerics.Vector2 A, System.Numerics.Vector2 B, System.Numerics.Vector2 C, System.Numerics.Vector4 Ca, System.Numerics.Vector4 Cb, System.Numerics.Vector4 Cc, bool Add)>();
		var blends = new SortedSet<string>();
		for (var bi = 0; bi < batches.Length / Capture.BatchBytes; bi++)
		{
			var b = batches.AsSpan(bi * Capture.BatchBytes);
			int first = BitConverter.ToInt32(b), count = BitConverter.ToInt32(b[4..]);
			var blend = (BlendMode)b[8];
			blends.Add(blend.ToString());
			for (var q = first; q + 3 < first + count; q += 4)
			{
				(System.Numerics.Vector2 P, System.Numerics.Vector4 C) V(int i)
				{
					var o = i * Capture.VertexBytes;
					return (new(BitConverter.ToSingle(verts, o), BitConverter.ToSingle(verts, o + 4)),
						new(BitConverter.ToSingle(verts, o + 12), BitConverter.ToSingle(verts, o + 16), BitConverter.ToSingle(verts, o + 20), BitConverter.ToSingle(verts, o + 24)));
				}

				var (p0, c0) = V(q); var (p1, c1) = V(q + 1); var (p2, c2) = V(q + 2); var (p3, c3) = V(q + 3);
				tris.Add((p0, p1, p2, c0, c1, c2, blend == BlendMode.Additive));
				tris.Add((p0, p2, p3, c0, c2, c3, blend == BlendMode.Additive));
			}
		}

		var grass = new System.Numerics.Vector3(0.29f, 0.43f, 0.18f);
		static float Lum(System.Numerics.Vector3 c) => 0.2126f * c.X + 0.7152f * c.Y + 0.0722f * c.Z;
		System.Numerics.Vector3 Shade(System.Numerics.Vector2 p)
		{
			var c = grass;
			foreach (var t in tris)
			{
				var v0 = t.B - t.A; var v1 = t.C - t.A; var v2 = p - t.A;
				var den = v0.X * v1.Y - v1.X * v0.Y;
				if (MathF.Abs(den) < 1e-6f) continue;
				var v = (v2.X * v1.Y - v1.X * v2.Y) / den;
				var w = (v0.X * v2.Y - v2.X * v0.Y) / den;
				var u = 1 - v - w;
				if (u < -1e-4f || v < -1e-4f || w < -1e-4f) continue;
				var col = u * t.Ca + v * t.Cb + w * t.Cc;
				var rgb = new System.Numerics.Vector3(col.X, col.Y, col.Z);
				c = t.Add ? c + rgb : rgb + (1 - col.W) * c;
			}

			return System.Numerics.Vector3.Clamp(c, System.Numerics.Vector3.Zero, System.Numerics.Vector3.One);
		}

		var a = new System.Numerics.Vector2(from[0], from[1]);
		var e = new System.Numerics.Vector2(to[0], to[1]);
		var dir = e - a;
		var len = dir.Length();
		var mid = (a + e) / 2;
		var nrm = len > 0.5f ? new System.Numerics.Vector2(-dir.Y, dir.X) / len : new System.Numerics.Vector2(0, 1);
		float peak = 0, w25 = 0, w10 = 0, white = 0;
		var baseLum = Lum(grass);
		for (var s = -40f; s <= 40f; s += 0.5f)
		{
			var c = Shade(mid + nrm * s);
			var contrast = MathF.Abs(Lum(c) - baseLum);
			if (contrast >= 0.25f) w25 += 0.5f;
			if (contrast >= 0.1f) w10 += 0.5f;
			if (contrast > peak) { peak = contrast; white = MathF.Min(c.X, MathF.Min(c.Y, c.Z)) / MathF.Max(1e-3f, MathF.Max(c.X, MathF.Max(c.Y, c.Z))); }
		}

		int Area(System.Numerics.Vector2 c)
		{
			var n = 0;
			for (var y = -30; y <= 30; y++)
				for (var x = -30; x <= 30; x++)
					if (MathF.Abs(Lum(Shade(c + new System.Numerics.Vector2(x, y))) - baseLum) >= 0.25f) n++;
			return n;
		}

		return new { peak = MathF.Round(peak, 3), width25 = w25, width10 = w10, white = MathF.Round(white, 2), blends = blends.ToArray(), quads = verts.Length / Capture.VertexBytes / 4,
			areaStart = Area(a), areaEnd = Area(e) };
	}

	static readonly Dictionary<Sprite, (int X0, int Y0, int X1, int Y1)?> Opaque = [];

	/// <summary>
	/// The screen rectangle of a sprite's visible pixels as drawn (scale included). The engine's own ScreenBounds is the
	/// whole frame canvas at scale 1, which for the soft explosion sheets is several times the blast itself.
	/// </summary>
	static Rectangle VisibleRect(SpriteRenderable sr, WorldRenderer wr)
	{
		var sprite = sr.Sprite;
		if (sprite == null || sprite.Bounds.Width == 0) return Rectangle.Empty;
		if (!Opaque.TryGetValue(sprite, out var box))
		{
			box = null;
			try
			{
				var data = sprite.Sheet.GetData();
				var w = sprite.Sheet.Size.Width;
				var rgba = sprite.Channel == TextureChannel.RGBA;
				var channel = rgba ? 3 : new[] { 2, 1, 0, 3 }[(int)sprite.Channel];
				int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
				for (var y = 0; y < sprite.Bounds.Height; y++)
					for (var x = 0; x < sprite.Bounds.Width; x++)
					{
						var v = data[((sprite.Bounds.Top + y) * w + sprite.Bounds.Left + x) * 4 + channel];
						if (rgba ? v <= 24 : v == 0) continue;
						x0 = Math.Min(x0, x); y0 = Math.Min(y0, y); x1 = Math.Max(x1, x); y1 = Math.Max(y1, y);
					}
				if (x1 >= 0) box = (x0, y0, x1, y1);
			}
			catch (Exception) { box = (0, 0, sprite.Bounds.Width - 1, sprite.Bounds.Height - 1); }
			Opaque[sprite] = box;
		}

		if (box == null) return Rectangle.Empty;
		// Snapshot.Build's placement of a sprite (SpriteRenderable.ScreenPosition plus the sprite's own offset).
		var scale = sr.Scale;
		var half = 0.5f * scale * sprite.Size;
		var s3 = wr.Screen3DPosition(sr.Origin);
		var off = wr.ScreenPxOffset(sr.Offset);
		var ox = s3.X + off.X - (int)half.X + scale * sprite.Offset.X;
		var oy = s3.Y + off.Y - (int)half.Y + scale * sprite.Offset.Y;
		var sx = scale * sprite.Size.X / sprite.Bounds.Width;
		var sy = scale * sprite.Size.Y / sprite.Bounds.Height;
		var (bx0, by0, bx1, by1) = box.Value;
		return new Rectangle((int)(ox + bx0 * sx), (int)(oy + by0 * sy), Math.Max(1, (int)MathF.Ceiling((bx1 - bx0 + 1) * sx)), Math.Max(1, (int)MathF.Ceiling((by1 - by0 + 1) * sy)));
	}

	static IEnumerable<IRenderable> SafeRender(IEffect e, WorldRenderer wr)
	{
		try { return e.Render(wr).ToArray(); }
		catch (Exception) { return []; }
	}

	static T Field<T>(object o, string name = null)
	{
		for (var type = o.GetType(); type != null; type = type.BaseType)
			foreach (var f in type.GetFields(Any | BindingFlags.DeclaredOnly))
			{
				if (name != null && f.Name != name) continue;
				var v = f.GetValue(o);
				if (v is T t) return t;
				if (name != null && typeof(T) == typeof(WPos?) && v is WPos p) return (T)(object)(WPos?)p;
			}

		return default;
	}

	static WPos? Position(IEffect e)
	{
		foreach (var name in new[] { "pos", "headPos" })
		{
			var p = Field<WPos?>(e, name);
			if (p != null) return p;
		}

		return null;
	}

	static Rectangle Union(IEnumerable<Rectangle> rects)
	{
		var r = Rectangle.Empty;
		foreach (var x in rects)
			if (x.Width > 0 && x.Height > 0) r = r.IsEmpty ? x : Rectangle.Union(r, x);
		return r;
	}

	static int[] Px(WorldRenderer wr, WPos p)
	{
		var s = wr.ScreenPxPosition(p);
		return [s.X, s.Y];
	}

	static int[] W(WPos p) => [p.X, p.Y, p.Z];
	static int[] R(Rectangle r) => r.IsEmpty ? null : [r.X, r.Y, r.Width, r.Height];

	static object Facts(WeaponInfo w)
	{
		var p = w.Projectile;
		var fields = new SortedDictionary<string, string>();
		if (p != null)
			foreach (var f in p.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public))
			{
				var v = f.GetValue(p);
				if (v == null) continue;
				var text = v switch
				{
					string s => s,
					bool or int or WDist or WAngle or Color => v.ToString(),
					System.Collections.IEnumerable e when v is not string => string.Join(", ", e.Cast<object>()),
					_ => null
				};
				if (text != null) fields[f.Name] = text;
			}

		return new
		{
			projectile = p?.GetType().Name.Replace("Info", ""), fields, range = w.Range.Length, minRange = w.MinRange.Length, reload = w.ReloadDelay, burst = w.Burst,
			report = w.Report.IsDefault ? [] : w.Report.ToArray(), targetActorCenter = w.TargetActorCenter,
			effects = w.Warheads.OfType<CreateEffectWarhead>().Select(c => new { image = c.Image, explosions = c.Explosions, palette = c.ExplosionPalette, sounds = c.ImpactSounds, valid = c.ValidTargets.ToString() }).ToArray(),
			damage = w.Warheads.OfType<DamageWarhead>().Select(d => d.Damage).Sum()
		};
	}

	static void Clear(World world, HashSet<Actor> keep, HashSet<IEffect> known)
	{
		foreach (var a in world.Actors.Where(a => !keep.Contains(a) && !a.Disposed && a.Owner.Playable).ToArray()) a.Dispose();
		for (var i = 0; i < 90 && world.Effects.Any(e => e is IProjectile || e is SpriteEffect); i++) SimHost.Tick();
		for (var i = 0; i < 3; i++) SimHost.Tick();
		known.Clear();
	}
}
