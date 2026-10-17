using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Read-only rules export and disposable live-engine tech-tree audit. No user maps/saves are edited.</summary>
static class FactionRosterAudit
{
	static object Rules(Ruleset rules)
	{
		return rules.Actors.Values.Where(a => !a.Name.StartsWith('^')).OrderBy(a => a.Name).Select(a => {
			var b = a.TraitInfoOrDefault<BuildableInfo>();
			var tooltip = a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			return new { id = a.Name, nameKey = tooltip?.Name,
				name = tooltip == null ? null : FluentProvider.GetMessage(tooltip.Name),
				cost = a.TraitInfoOrDefault<ValuedInfo>()?.Cost,
				queue = b?.Queue.ToArray(), prerequisites = b?.Prerequisites.ToArray(),
				building = a.HasTraitInfo<BuildingInfo>(), drawable = a.HasTraitInfo<RenderSpritesInfo>(),
				providers = a.TraitInfos<ProvidesPrerequisiteInfo>().Select(p => new { name = p.Prerequisite ?? a.Name,
					factions = p.Factions.Order().ToArray(), requires = p.RequiresPrerequisites.ToArray(), condition = p.RequiresCondition?.ToString() }).ToArray(),
				techProviders = a.TraitInfos<ProvidesTechPrerequisiteInfo>().Select(p => new { id = p.Id, prerequisites = p.Prerequisites.ToArray() }).ToArray(),
				starting = a.TraitInfos<StartingUnitsInfo>().Select(s => new { factions = s.Factions.Order().ToArray(), baseActor = s.BaseActor, support = s.SupportActors.ToArray() }).ToArray(),
				transforms = a.TraitInfos<TransformsInfo>().Select(t => t.IntoActor).ToArray() };
		}).ToArray();
	}

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
			Write(output, new { target = opts["mod"], actors = Rules(mod.DefaultRules),
				factions = mod.DefaultRules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable && f.RandomFactionMembers.Count == 0)
				.Select(f => new { id = f.InternalName, name = FluentProvider.GetMessage(f.Name) }).ToArray() });
			return 0;
		}

		SimHost.Boot(opts["root"]);
		var rules = SimHost.ModData.DefaultRules;
		var actors = Rules(rules);
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
