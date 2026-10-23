using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// Read-only rules export and disposable live-engine tech-tree audit. No user maps/saves are edited. The export is what a
/// build ships, actor by actor: names, cost, tech tree and the unit's numbers (health, armour, speed, sight and every
/// weapon it fires at rest for each faction), so a desktop build and a web bundle can be compared field by field
/// (tools/roster-audit/compare.py).
/// </summary>
static class FactionRosterAudit
{
	static object Weapon(Ruleset rules, ArmamentInfo armament)
	{
		if (armament.Weapon == null || !rules.Weapons.TryGetValue(armament.Weapon.ToLowerInvariant(), out var w))
			return new { armament = armament.Name, weapon = armament.Weapon, missing = true };
		var damage = w.Warheads.OfType<DamageWarhead>().ToArray();
		return new { armament = armament.Name, weapon = armament.Weapon, range = w.Range.Length, reload = w.ReloadDelay, burst = w.Burst,
			damage = damage.Sum(d => d.Damage), versus = damage.SelectMany(d => d.Versus).GroupBy(v => v.Key).OrderBy(g => g.Key).ToDictionary(g => g.Key, g => g.First().Value),
			targets = w.ValidTargets.Order().ToArray(), excludes = w.InvalidTargets.Order().ToArray(), projectile = w.Projectile?.GetType().Name.Replace("Info", "") };
	}

	/// <summary>Conditions an owner of this faction holds at rest (GrantConditionOnFaction); every other condition is off.</summary>
	static Dictionary<string, int> RestingConditions(ActorInfo a, string faction)
	{
		// GrantConditionOnFactionInfo is internal to the engine: read its two fields by name.
		return a.TraitInfos<TraitInfo>().Where(t => t.GetType().Name == "GrantConditionOnFactionInfo")
			.Where(t => faction != null && ((IEnumerable<string>)t.GetType().GetField("Factions").GetValue(t)).Contains(faction))
			.Select(t => (string)t.GetType().GetField("Condition").GetValue(t)).Distinct().ToDictionary(c => c, _ => 1);
	}

	static string[] ActiveArmaments(ActorInfo a, string faction)
	{
		var symbols = RestingConditions(a, faction);
		return a.TraitInfos<ArmamentInfo>().Where(m => m.RequiresCondition == null || m.RequiresCondition.Evaluate(symbols))
			.Select(m => m.Name + ":" + m.Weapon).Distinct().Order().ToArray();
	}

	/// <summary>The name an owner of this faction sees: the first tooltip enabled at rest.</summary>
	static string Name(ActorInfo a, string faction)
	{
		var symbols = RestingConditions(a, faction);
		var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.RequiresCondition == null || t.RequiresCondition.Evaluate(symbols));
		return tooltip == null ? null : FluentProvider.GetMessage(tooltip.Name);
	}

	static object Rules(Ruleset rules)
	{
		var factions = rules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0)
			.Select(f => f.InternalName).ToArray();
		return rules.Actors.Values.Where(a => !a.Name.StartsWith('^')).OrderBy(a => a.Name).Select(a => {
			var b = a.TraitInfoOrDefault<BuildableInfo>();
			var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			var atRest = ActiveArmaments(a, null);
			return new { id = a.Name, nameKey = tooltip?.Name,
				name = tooltip == null ? null : FluentProvider.GetMessage(tooltip.Name),
				cost = a.TraitInfoOrDefault<ValuedInfo>()?.Cost,
				queue = b?.Queue.ToArray(), prerequisites = b?.Prerequisites.ToArray(),
				building = a.HasTraitInfo<BuildingInfo>(), drawable = a.HasTraitInfo<RenderSpritesInfo>(),
				providers = a.TraitInfos<ProvidesPrerequisiteInfo>().Select(p => new { name = p.Prerequisite ?? a.Name,
					factions = p.Factions.Order().ToArray(), requires = p.RequiresPrerequisites.ToArray(), condition = p.RequiresCondition?.ToString() }).ToArray(),
				techProviders = a.TraitInfos<ProvidesTechPrerequisiteInfo>().Select(p => new { id = p.Id, prerequisites = p.Prerequisites.ToArray() }).ToArray(),
				starting = a.TraitInfos<StartingUnitsInfo>().Select(s => new { factions = s.Factions.Order().ToArray(), baseActor = s.BaseActor, support = s.SupportActors.ToArray() }).ToArray(),
				transforms = a.TraitInfos<TransformsInfo>().Select(t => t.IntoActor).ToArray(),
				hp = a.TraitInfoOrDefault<HealthInfo>()?.HP,
				armor = a.TraitInfos<ArmorInfo>().FirstOrDefault(t => t.EnabledByDefault)?.Type,
				speed = a.TraitInfoOrDefault<MobileInfo>()?.Speed ?? a.TraitInfoOrDefault<AircraftInfo>()?.Speed,
				sight = a.TraitInfos<RevealsShroudInfo>().Select(r => r.Range.Length).DefaultIfEmpty(0).Max(),
				weapons = a.TraitInfos<ArmamentInfo>().Select(m => Weapon(rules, m)).ToArray(),
				armaments = atRest,
				// Only factions whose own conditions change the weapons or the name at rest (e.g. the original countries' retail twins).
				factionArmaments = factions.Select(f => (f, list: ActiveArmaments(a, f))).Where(x => !x.list.SequenceEqual(atRest)).ToDictionary(x => x.f, x => x.list),
				factionNames = factions.Select(f => (f, name: Name(a, f))).Where(x => x.name != Name(a, null)).ToDictionary(x => x.f, x => x.name) };
		}).ToArray();
	}

	static JsonElement Rosters(Ruleset rules) => JsonDocument.Parse(Ui.Rosters(rules)).RootElement.GetProperty("rosters").Clone();

	public static int Run(Dictionary<string, string> opts)
	{
		var output = opts["out"];
		if (opts.TryGetValue("desktop", out var native))
		{
			// Same ModData / DefaultRules and localization path as OpenRA.Utility, using the selected desktop build.
			Platform.OverrideEngineDir(native);
			Platform.OverrideSupportDir(opts["support"]);
			Game.InitializeSettings(Arguments.Empty);
			AppContext.SetSwitch("OpenRA.EmbeddedModAssemblies", true);
			var mods = new InstalledMods([Path.Combine(native, "mods")], []);
			using var mod = new ModData(mods[opts["mod"]], mods);
			Game.ModData = mod;
			mod.ObjectCreator.SetTypeOverride("CompanionBridgeInfo", typeof(OpenRA.Mods.RTSAI.Traits.CompanionBridgeInfo));
			Write(output, new { target = opts["mod"], actors = Rules(mod.DefaultRules), rosters = Rosters(mod.DefaultRules),
				factions = mod.DefaultRules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0)
				.Select(f => new { id = f.InternalName, name = FluentProvider.GetMessage(f.Name) }).ToArray() });
			return 0;
		}

		SimHost.Boot(opts["root"]);
		var rules = SimHost.ModData.DefaultRules;
		var actors = Rules(rules);
		if (opts.ContainsKey("rules-only"))
		{
			// What the bundle ships, without the slow live-world tech-tree pass (the release-time comparison).
			Write(output, new { target = SimHost.ModId, actors, rosters = Rosters(rules),
				factions = rules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0)
				.Select(f => new { id = f.InternalName, name = FluentProvider.GetMessage(f.Name) }).ToArray() });
			return 0;
		}
		using var drawer = JsonDocument.Parse(Ui.Rosters(rules));
		var factions = rules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0).ToArray();
		var reports = new List<object>();
		foreach (var faction in factions)
		{
			var enemyBase = rules.Actors[SystemActors.World].TraitInfos<StartingUnitsInfo>()
				.First(s => s.BaseActor != null && (s.Factions.Count == 0 || s.Factions.Contains(faction.InternalName))).BaseActor;
			SimHost.Start(new ScenarioSpec { Map = opts.GetValueOrDefault("map", "web-arena"), Seed = 20261018, Bare = true,
				Players = [new PlayerSpec { Slot = "Multi0", Faction = faction.InternalName }, new PlayerSpec { Slot = "Multi1", Faction = faction.InternalName, Bot = "webidle" }],
				Spawns = [new SpawnSpec { Type = enemyBase, Player = 1, X = 85, Y = 25 }],
				Options = new() { ["techlevel"] = "unrestricted", ["startingcash"] = "50000", ["crates"] = "False", ["fog"] = "False", ["explored"] = "True" } });
			var world = SimHost.World;
			var owner = world.LocalPlayer;
			var tech = owner.PlayerActor.Trait<TechTree>();
			var spawned = new HashSet<string>();
			var unlocked = new HashSet<string>();
			var start = world.Map.Rules.Actors[SystemActors.World].TraitInfos<StartingUnitsInfo>()
				.Where(s => s.Factions.Count == 0 || s.Factions.Contains(faction.InternalName)).SelectMany(s => s.SupportActors.Append(s.BaseActor)).Where(n => n != null).ToArray();
			void Spawn(string name)
			{
				name = name.ToLowerInvariant();
				if (!spawned.Add(name)) return;
				var cell = new MPos(8 + spawned.Count % 8 * 5, 18 + spawned.Count / 8 * 5).ToCPos(world.Map);
				world.CreateActor(true, name, new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(faction.InternalName) });
			}
			foreach (var name in start) Spawn(name);
			foreach (var name in spawned.ToArray())
				foreach (var t in world.Map.Rules.Actors[name].TraitInfos<TransformsInfo>()) Spawn(t.IntoActor);
			var passes = 0;
			for (; passes < 40; passes++)
			{
				for (var i = 0; i < 8; i++) SimHost.Tick();
				tech.Update();
				var queues = owner.PlayerActor.TraitsImplementing<ProductionQueue>()
					.Concat(world.Actors.Where(a => a.Owner == owner && a != owner.PlayerActor).SelectMany(a => a.TraitsImplementing<ProductionQueue>())).ToArray();
				var available = queues.SelectMany(q => q.BuildableItems()).DistinctBy(a => a.Name).ToArray();
				foreach (var a in available) unlocked.Add(a.Name);
				var next = available.Where(a => !spawned.Contains(a.Name) && (a.HasTraitInfo<BuildingInfo>() || a.TraitInfos<ProvidesPrerequisiteInfo>().Any() || a.TraitInfos<TransformsInfo>().Any())).ToArray();
				if (next.Length == 0) break;
				foreach (var a in next) Spawn(a.Name);
			}
			if (passes == 40) throw new InvalidDataException(faction.InternalName + ": infrastructure did not converge");
			var prerequisites = world.ActorsWithTrait<ITechTreePrerequisite>().Where(p => p.Actor.Owner == owner && p.Actor.IsInWorld && !p.Actor.IsDead)
				.SelectMany(p => p.Trait.ProvidesPrerequisites).Where(p => p != null).Distinct().Order().ToArray();
			var eligible = world.Map.Rules.Actors.Values.Where(a => !a.Name.StartsWith('^') && a.HasTraitInfo<BuildableInfo>() && a.HasTraitInfo<RenderSpritesInfo>())
				.Where(a => tech.HasPrerequisites(a.TraitInfo<BuildableInfo>().Prerequisites)).Select(a => a.Name).Order().ToArray();
			reports.Add(new { id = faction.InternalName, name = FluentProvider.GetMessage(faction.Name), passes,
				starting = start, spawned = spawned.Order().ToArray(), unlocked = unlocked.Order().ToArray(), eligible, prerequisites,
				drawer = drawer.RootElement.GetProperty("rosters").GetProperty(faction.InternalName).EnumerateArray().Select(n => n.GetString()).ToArray() });
			Console.WriteLine($"AUDITED {SimHost.ModId}/{faction.InternalName}: {eligible.Length} eligible actors; {unlocked.Count} unlocked production items");
			SimHost.EndGame();
		}
		Write(output, new { target = SimHost.ModId, actors, factions = reports, scope = "Unrestricted technology, own-country infrastructure, no captured foreign buildings; disposable live OpenRA worlds. No AllTech cheat." });
		return 0;
	}

	static void Write(string path, object data) => File.WriteAllText(path, JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
}
