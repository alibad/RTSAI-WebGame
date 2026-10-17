using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenRA;
using OpenRA.Graphics;
using OpenRA.Mods.Cnc.Traits.Render;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>
/// Exercise real faction tech trees, rendering and specialty production against the bundled public game.
/// Original art (public isometric bundles with web/ea): the nine original countries' actors must draw original images
/// with original palettes only, every other actor must never draw an original palette ("original palette iff original
/// image"), and no original file may be missing. --dump writes each own actor's image, voxel image, sequences and
/// palettes; --baseline compares them with a dump made from the pre-change bundle (modern factions: identical).
/// </summary>
static class ContentTest
{
	static readonly string[] Originals = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];
	static readonly HashSet<string> NeutralPalettes = ["shadow", "normals", "ts-normals"];

	static readonly Dictionary<string, string> Signatures = new()
	{
		["america"] = "e1", ["germany"] = "tnkd", ["england"] = "snipe", ["france"] = "gtgcan", ["korea"] = "beag",
		["cuba"] = "terror", ["libya"] = "dtruck", ["iraq"] = "deso", ["russia"] = "ttnk",
		["china"] = "r2cnnetwork", ["iran"] = "r2karrar", ["turkey"] = "r2aras", ["saudi"] = "r2m1a2s",
		["israel"] = "r2merkava", ["yemen"] = "r2ymlr", ["hezbollah"] = "r2hzrifle"
	};

	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var faction = opts.GetValueOrDefault("faction", "america");
		var scenario = new ScenarioSpec
		{
			Map = "twin-fords", Seed = 23,
			Players = [new PlayerSpec { Slot = "Multi0", Faction = faction }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
			Options = new() { ["startingunits"] = "heavy", ["startingcash"] = "50000", ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
		};
		SimHost.Start(scenario);
		var world = SimHost.World; var own = world.LocalPlayer;
		var mcv = world.Actors.FirstOrDefault(a => a.Owner == own && a.Info.Name.EndsWith("mcv")) ?? throw new Exception(faction + ": no starting MCV");
		SimHost.Select([mcv.ActorID], false); Ui.Command("{\"cmd\":\"deploy\"}");
		for (var i = 0; i < 100; i++) SimHost.Tick();
		var soviet = new[] { "cuba", "libya", "iraq", "russia", "iran", "yemen", "hezbollah" }.Contains(faction);
		var yard = soviet ? "nacnst" : "gacnst";
		if (!world.Actors.Any(a => a.Owner == own && a.Info.Name == yard)) throw new Exception(faction + ": MCV did not deploy");
		var power = soviet ? "napowr" : "gapowr";
		var queue = own.PlayerActor.TraitsImplementing<ProductionQueue>().First(q => q.Info.Type == "Building");
		if (!queue.BuildableItems().Any(a => a.Name == power)) throw new Exception(faction + ": power unavailable at start");
		Ui.Command($"{{\"cmd\":\"produce\",\"queue\":\"Building\",\"item\":\"{power}\"}}");
		for (var i = 0; i < 1500 && !Ui.State().Contains("\"done\":true"); i++) SimHost.Tick();
		if (!Ui.State().Contains("\"done\":true")) throw new Exception(faction + ": power production failed");
		// Full infrastructure unlocks the real faction tree. These are test-only fixtures, never user-facing cheats.
		var buildings = soviet ? new[] { "napowr", "narefn", "nahand", "naweap", "naradr", "nadept", "natech", "nayard" }
			: new[] { "gapowr", "garefn", "gapile", "gaweap", "gaairc", "gadept", "gatech", "gayard" };
		for (var i = 0; i < buildings.Length; i++)
			Spawn(world, buildings[i], own, new MPos(10 + i % 4 * 5, 30 + i / 4 * 8).ToCPos(world.Map));
		for (var i = 0; i < 40; i++) SimHost.Tick();
		var roster = own.PlayerActor.TraitsImplementing<ProductionQueue>().SelectMany(q => q.BuildableItems()).DistinctBy(a => a.Name).ToArray();
		var signature = Signatures[faction];
		if (!roster.Any(a => a.Name == signature)) throw new Exception(faction + ": specialty unavailable: " + signature + "; roster " + string.Join(",", roster.Select(a => a.Name)));
		var units = roster.Where(a => a.HasTraitInfo<BuildableInfo>() && !a.HasTraitInfo<BuildingInfo>()).ToArray();
		for (var i = 0; i < units.Length; i++)
		{
			Spawn(world, units[i].Name, own, new MPos(18 + i % 8 * 2, 50 + i / 8 * 3).ToCPos(world.Map));
			Ui.Icon(units[i].Name);
		}
		var structures = roster.Where(a => a.HasTraitInfo<BuildingInfo>()).ToArray();
		for (var i = 0; i < structures.Length; i++)
		{
			Spawn(world, structures[i].Name, own, new MPos(8 + i % 7 * 6, 75 + i / 7 * 6).ToCPos(world.Map));
			Ui.Icon(structures[i].Name);
		}
		if (faction == "america" || faction == "iraq")
			world.CreateActor(true, signature, new TypeDictionary { new OwnerInit(own), new LocationInit(new MPos(40, 55).ToCPos(world.Map)), new FactionInit(faction), new DeployStateInit(DeployState.Deployed) });
		var foundations = world.Map.Sequences.Images.Contains("ea-napowr") && Originals.Contains(faction)
			? world.Actors.Where(a => a.Owner == own && FoundationDimensions.ContainsKey(a.Info.Name))
				.GroupBy(a => a.Info.Name).ToDictionary(g => g.Key, g => g.Last()) : new Dictionary<string, Actor>();
		var makeFrames = foundations.ToDictionary(p => p.Key, _ => new HashSet<int>());
		for (var i = 0; i < 120; i++)
		{
			foreach (var (name, actor) in foundations)
			{
				var animation = actor.Trait<WithSpriteBody>().DefaultAnimation;
				if (animation.CurrentSequence.Name == "make") makeFrames[name].Add(animation.CurrentFrame);
			}
			SimHost.Tick(); Snapshot.Build();
		}
		foreach (var (name, actor) in foundations)
		{
			var info = actor.Info.TraitInfo<BuildingInfo>();
			if (info.Dimensions != FoundationDimensions[name] || makeFrames[name].Count < 2)
				throw new Exception(name + ": incorrect original foundation or construction animation; dimensions " + info.Dimensions + ", make frames " + makeFrames[name].Count);
			var occupied = info.Footprint.Values.Count(v => v == FootprintCellType.Occupied);
			if (occupied != (name == "nadept" ? 3 : info.Dimensions.X * info.Dimensions.Y))
				throw new Exception(name + ": incorrect blocking footprint");
			actor.InflictDamage(actor, new Damage(actor.Info.TraitInfo<HealthInfo>().HP * 2 / 3));
		}
		for (var i = 0; i < 5; i++) { SimHost.Tick(); Snapshot.Build(); }
		foreach (var (name, actor) in foundations)
		{
			var sequence = actor.Trait<WithSpriteBody>().DefaultAnimation.CurrentSequence.Name;
			if (!sequence.StartsWith("damaged-", StringComparison.Ordinal) && !sequence.StartsWith("critical-", StringComparison.Ordinal))
				throw new Exception(name + ": original damage animation not selected: " + sequence);
		}
		var repairedAtOriginalDepot = false;
		var infantryExitedOriginalBarracks = false;
		if (faction == "libya" && foundations.TryGetValue("nadept", out var depot))
		{
			var infantryBefore = world.Actors.Count(a => a.Owner == own && a.Info.Name == "e2");
			Ui.Command("{\"cmd\":\"produce\",\"queue\":\"Infantry\",\"item\":\"e2\"}");
			for (var i = 0; i < 1000 && !infantryExitedOriginalBarracks; i++)
			{
				SimHost.Tick();
				infantryExitedOriginalBarracks = world.Actors.Count(a => a.Owner == own && a.Info.Name == "e2") > infantryBefore;
			}
			if (!infantryExitedOriginalBarracks) throw new Exception("Libya: infantry could not leave the restored barracks");
			var tank = world.CreateActor(true, "htnk", new TypeDictionary { new OwnerInit(own),
				new LocationInit(depot.Location + new CVec(1, 1)), new FactionInit(faction) });
			var health = tank.Trait<Health>();
			tank.InflictDamage(tank, new Damage(health.HP / 2));
			var before = health.HP;
			world.IssueOrder(new Order("Repair", tank, Target.FromActor(depot), false));
			var repairFrames = new HashSet<int>();
			for (var i = 0; i < 1200; i++)
			{
				SimHost.Tick();
				var animation = depot.Trait<WithSpriteBody>().DefaultAnimation;
				if (animation.CurrentSequence.Name.Contains("repair", StringComparison.Ordinal)) repairFrames.Add(animation.CurrentFrame);
				if (health.HP > before && repairFrames.Count > 1) { repairedAtOriginalDepot = true; break; }
			}
			if (!repairedAtOriginalDepot) throw new Exception("Libya: depot did not repair a real tank with its original repair animation");
		}
		var originalExtras = OriginalExtras(world, own, faction, soviet);
		if (Snapshot.UnsupportedRenderables > 0) throw new Exception(faction + ": unsupported renderables");
		var art = RenderArt(world, own, faction);
		var voices = Voices(world, own, faction);
		var cameoImages = new SortedDictionary<string, string>();
		foreach (var actor in roster)
		{
			var icon = Ui.Icon(actor.Name, faction);
			if (string.IsNullOrEmpty(icon)) throw new Exception(faction + ": no cameo for " + actor.Name);
			using var data = JsonDocument.Parse(icon);
			var image = data.RootElement.GetProperty("image").GetString();
			// Project-only extensions (e.g. the purifier) have no original RA2 actor or cameo.
			if (art.Report.TryGetValue(actor.Name, out var visual) && visual.Image?.StartsWith("ea-", StringComparison.Ordinal) == true
				&& !image.StartsWith("ea-", StringComparison.Ordinal))
				throw new Exception(faction + ": substituted cameo for " + actor.Name + ": " + image);
			cameoImages[actor.Name] = image;
		}
		if (opts.TryGetValue("dump", out var dump))
			File.WriteAllText(dump, JsonSerializer.Serialize(art.Report, new JsonSerializerOptions { WriteIndented = true }));
		var compared = opts.TryGetValue("baseline", out var baselinePath) && !Originals.Contains(faction);
		if (compared)
		{
			var baseline = JsonSerializer.Deserialize<SortedDictionary<string, ActorArt>>(File.ReadAllText(baselinePath));
			var diffs = 0;
			foreach (var key in baseline.Keys.Union(art.Report.Keys).OrderBy(k => k, StringComparer.Ordinal))
			{
				var before = baseline.GetValueOrDefault(key);
				var after = art.Report.GetValueOrDefault(key);
				if (before == null || after == null || !before.Equals(after))
				{
					diffs++;
					Console.Error.WriteLine(faction + ": " + key + " differs from the baseline: " + JsonSerializer.Serialize(before) + " -> " + JsonSerializer.Serialize(after));
				}
			}

			if (diffs > 0)
				throw new Exception(faction + ": " + diffs + " actor types render differently from the pre-change baseline");
		}

		Console.WriteLine(JsonSerializer.Serialize(new { faction, signature, production = true, units = units.Select(a => a.Name), unsupported = Snapshot.UnsupportedRenderables,
			originalArtActors = art.OriginalActors, originalArtTypes = art.OriginalTypes, originalVoiceTypes = voices.OriginalTypes,
			projectVoiceTypes = voices.ProjectTypes, originalClipsChecked = voices.Clips, cameoImages,
			originalBuildingMakeFrames = makeFrames.ToDictionary(p => p.Key, p => p.Value.Count),
			infantryExitedOriginalBarracks, repairedAtOriginalDepot, originalExtras, baselineCompared = compared, passed = true }));
		return 0;
	}

	static object OriginalExtras(World world, Player own, string faction, bool soviet)
	{
		var icons = own.PlayerActor.Info.TraitInfoOrDefault<FactionSupportPowerIconsInfo>();
		if (icons == null) return null; // Classic and project-only content.
		var original = icons.Factions.Contains(faction);
		var powerIcons = new SortedDictionary<string, string>();
		foreach (var (key, power) in own.PlayerActor.Trait<SupportPowerManager>().Powers)
		{
			if (power.Info == null || power.Info.IconImage != icons.SourceImage) continue;
			var json = Ui.Icon("$power:" + key);
			if (string.IsNullOrEmpty(json)) throw new Exception(faction + ": missing support-power icon " + key);
			using var data = JsonDocument.Parse(json);
			var image = data.RootElement.GetProperty("image").GetString();
			var expected = original ? icons.Image : power.Info.IconImage;
			if (image != expected) throw new Exception(faction + ": wrong support-power image " + image + " for " + key);
			if (original && data.RootElement.GetProperty("pal").GetInt32() != SimHost.WorldRenderer.Palette(icons.Palette).TextureIndex)
				throw new Exception(faction + ": support-power icon uses the wrong palette: " + key);
			powerIcons[key] = image;
		}
		if (powerIcons.Count == 0) throw new Exception(faction + ": no live support powers were checked");
		foreach (var sequence in new[] { "gps", "invuln", "chrono", "abomb", "paradrop", "airborne", "lightningstorm" })
		{
			var sprite = world.Map.Sequences.GetSequence(icons.Image, sequence).GetSprite(0);
			if (sprite.Bounds.Width != 60 || sprite.Bounds.Height != 48)
				throw new Exception("Original RA2 support-power icon is not 60x48: " + sequence);
		}

		var refinery = world.Actors.First(a => a.Owner == own && a.Info.Name == (soviet ? "narefn" : "garefn"));
		var type = soviet ? "harv" : "cmin";
		var miner = world.CreateActor(true, type, new TypeDictionary { new OwnerInit(own),
			new LocationInit(refinery.Location + new CVec(3, 3)), new FactionInit(faction) });
		var body = miner.Trait<WithOriginalVoxelUnloadBody>();
		var store = miner.Trait<IStoresResources>();
		var harvester = miner.Trait<Harvester>();
		for (var i = 0; i < store.Capacity; i++) harvester.AddResource(miner, "Ore");
		var money = own.PlayerActor.Trait<PlayerResources>();
		var before = money.GetCashAndResources();
		world.IssueOrder(new Order("Dock", miner, Target.FromActor(refinery), false));
		var sawUnload = false;
		var complete = false;
		for (var i = 0; i < 5000; i++)
		{
			SimHost.Tick();
			if (body.IsTraitDisabled == original) throw new Exception(faction + ": wrong original miner body condition");
			if (body.Docked)
			{
				sawUnload = true;
				if (body.VisibleSequence != (original ? "unload" : null))
					throw new Exception(faction + ": wrong docked miner body");
			}
			if (sawUnload && !body.Docked && store.ContentsSum == 0)
			{
				complete = true;
				break;
			}
		}
		if (!complete || money.GetCashAndResources() <= before)
			throw new Exception(faction + ": real refinery delivery did not finish and credit income");
		if (body.VisibleSequence != (original ? "idle" : null))
			throw new Exception(faction + ": miner did not return to its travelling body");
		return new { miner = type, docked = sawUnload, undocked = complete,
			originalUnloadVisible = original, income = money.GetCashAndResources() - before, powerIcons };
	}

	static readonly Dictionary<string, CVec> FoundationDimensions = new()
	{
		["napowr"] = new(3, 2), ["nahand"] = new(2, 2), ["nadept"] = new(4, 3),
		["natech"] = new(3, 3), ["nanrct"] = new(4, 4)
	};

	/// <summary>
	/// Original voices and sounds (public isometric bundles with web/ea/audio; unpack with --audio so the clips are on
	/// disk): every own voiced actor has exactly one enabled voice; an original country's actor speaks with its original
	/// voice set (Ea*) whenever it has one, a modern faction's only when the actor has no project voice (the Attack Dog);
	/// every clip an enabled original voice set or any weapon names exists; a modern faction fires no weapon with original
	/// sounds except the dog's bite.
	/// </summary>
	static (int OriginalTypes, int ProjectTypes, int Clips) Voices(World world, Player own, string faction)
	{
		var original = Originals.Contains(faction);
		var fs = SimHost.ModData.DefaultFileSystem;
		var voiceRules = world.Map.Rules.Voices;
		static bool IsOriginalSet(string set) => set != null && set.StartsWith("ea", StringComparison.Ordinal);
		var bundleHasOriginalVoices = voiceRules.Keys.Any(IsOriginalSet);
		var originalTypes = new HashSet<string>();
		var projectTypes = new HashSet<string>();
		var checkedClips = new HashSet<string>();
		void Check(string name, string where)
		{
			if (checkedClips.Add(name) && !fs.Exists(name))
				throw new Exception(faction + ": " + where + " plays " + name + ", which the bundle does not carry");
		}

		foreach (var a in world.Actors.Where(a => a.Owner == own && a.IsInWorld && !a.IsDead).OrderBy(a => a.ActorID))
		{
			var all = a.TraitsImplementing<IVoiced>().ToList();
			if (all.Count == 0)
				continue;

			var enabled = all.Where(v => !(v is ConditionalTrait<VoicedInfo> c && c.IsTraitDisabled)).ToList();
			if (enabled.Count != 1)
				throw new Exception(faction + ": " + a.Info.Name + " has " + enabled.Count + " enabled voices");

			var set = enabled[0].VoiceSet;
			var hasOriginal = all.Any(v => IsOriginalSet(v.VoiceSet));
			var hasProject = all.Any(v => !IsOriginalSet(v.VoiceSet));
			var expected = hasOriginal && (original || !hasProject);
			if (IsOriginalSet(set) != expected)
				throw new Exception(faction + ": " + a.Info.Name + " speaks with " + set + (expected ? ", not its original voice" : ", an original voice of another faction"));

			if (!IsOriginalSet(set))
			{
				projectTypes.Add(a.Info.Name);
				continue;
			}

			originalTypes.Add(a.Info.Name);
			var rules = voiceRules[set];
			foreach (var (phrase, clips) in rules.Voices)
				foreach (var clip in clips)
					Check(clip + rules.DefaultVariant, a.Info.Name + " (" + set + "." + phrase + ")");
		}

		// Weapons: every original sound a weapon names exists; a modern faction's own armaments play no original sound
		// except the dog's bite.
		var dogJaw = world.Map.Rules.Weapons["dogjaw"];
		static bool IsOriginalSound(string s) => s.Contains("web/ea/", StringComparison.Ordinal);
		var originalWeapons = 0;
		foreach (var (key, weapon) in world.Map.Rules.Weapons)
		{
			var sounds = WeaponSounds(weapon).Where(IsOriginalSound).ToList();
			foreach (var s in sounds)
				Check(s, "weapon " + key);
			originalWeapons += sounds.Count > 0 ? 1 : 0;
		}

		var originalFiring = new HashSet<string>();
		foreach (var a in world.Actors.Where(a => a.Owner == own && a.IsInWorld && !a.IsDead))
			foreach (var armament in a.TraitsImplementing<Armament>())
				if (WeaponSounds(armament.Weapon).Any(IsOriginalSound))
				{
					if (!original && armament.Weapon != dogJaw)
						throw new Exception(faction + ": " + a.Info.Name + " fires " + armament.Info.Weapon + " with original sounds");
					originalFiring.Add(a.Info.Name);
				}

		if (bundleHasOriginalVoices)
		{
			if (!WeaponSounds(dogJaw).Any(IsOriginalSound))
				throw new Exception("DogJaw keeps the project's sounds");

			if (original && originalTypes.Count < 10)
				throw new Exception(faction + ": only " + originalTypes.Count + " actor types speak with original voices");
		}

		Console.Error.WriteLine(faction + ": " + originalWeapons + " weapons with original sounds; own actors firing them: "
			+ string.Join(",", originalFiring.OrderBy(x => x, StringComparer.Ordinal)));

		Console.Error.WriteLine(faction + ": original voices " + string.Join(",", originalTypes.OrderBy(x => x, StringComparer.Ordinal))
			+ "; project voices " + string.Join(",", projectTypes.OrderBy(x => x, StringComparer.Ordinal)));
		return (originalTypes.Count, projectTypes.Count, checkedClips.Count);
	}

	/// <summary>The sounds a weapon plays: Report, StartBurstReport, AfterFireSound and its warheads' ImpactSounds.</summary>
	static IEnumerable<string> WeaponSounds(OpenRA.GameRules.WeaponInfo weapon)
	{
		foreach (var list in new[] { weapon.Report, weapon.StartBurstReport, weapon.AfterFireSound })
			if (!list.IsDefaultOrEmpty)
				foreach (var s in list)
					yield return s;

		foreach (var warhead in weapon.Warheads.OfType<OpenRA.Mods.Common.Warheads.CreateEffectWarhead>())
			if (!warhead.ImpactSounds.IsDefaultOrEmpty)
				foreach (var s in warhead.ImpactSounds)
					yield return s;
	}

	public sealed record ActorArt(string Image, string Voxel, string[] Sequences, string[] Palettes)
	{
		public bool Equals(ActorArt other) => other != null && Image == other.Image && Voxel == other.Voxel
			&& Sequences.SequenceEqual(other.Sequences) && Palettes.SequenceEqual(other.Palettes);

		public override int GetHashCode() => HashCode.Combine(Image, Voxel);
	}

	static readonly System.Reflection.FieldInfo ModelsField = typeof(OpenRA.Mods.Cnc.Graphics.ModelRenderable)
		.GetField("models", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);

	/// <summary>Whether a renderable draws anything: RenderVoxels returns a model renderable even when every voxel
	/// component is disabled (an owner the original voxels are not for), and its palette is then never used.</summary>
	static bool Draws(IPalettedRenderable r)
	{
		if (r is OpenRA.Mods.Cnc.Graphics.ModelRenderable && ModelsField?.GetValue(r) is IEnumerable<ModelAnimation> models)
			return models.Any(m => m.IsVisible);
		return true;
	}

	/// <summary>Each own actor type's image, voxel image, image sequences and drawn palettes; original-art checks.</summary>
	static (SortedDictionary<string, ActorArt> Report, int OriginalActors, int OriginalTypes) RenderArt(World world, Player own, string faction)
	{
		var wr = SimHost.WorldRenderer;
		var original = Originals.Contains(faction);
		var bundleHasOriginalArt = world.Map.Sequences.Images.Any(i => i.StartsWith("ea-", StringComparison.Ordinal));
		string Normalize(string palette)
		{
			foreach (var p in world.Players)
				if (palette.Length > p.InternalName.Length && palette.EndsWith(p.InternalName, StringComparison.Ordinal))
					return palette[..^p.InternalName.Length] + "<player>";
			return palette;
		}

		static bool IsOriginal(string name) => name != null && name.StartsWith("ea", StringComparison.Ordinal);

		var report = new SortedDictionary<string, ActorArt>(StringComparer.Ordinal);
		var originalActors = 0;
		var originalTypes = new HashSet<string>();
		foreach (var a in world.Actors.Where(a => a.Owner == own && a.IsInWorld && !a.IsDead).OrderBy(a => a.ActorID))
		{
			var rs = a.TraitOrDefault<RenderSprites>();
			var rv = a.TraitOrDefault<RenderVoxels>();
			if (rs == null && rv == null)
				continue;

			var image = rs?.GetImage(a);
			var renderables = a.Render(wr).OfType<IPalettedRenderable>().ToList();
			// The voxel image counts only when voxels are drawn (RenderVoxels' image is per actor type).
			var voxel = renderables.Any(r => r is OpenRA.Mods.Cnc.Graphics.ModelRenderable && Draws(r)) ? rv?.Image : null;
			var palettes = renderables.Where(Draws).Select(r => r.Palette?.Name).Where(n => n != null).Select(Normalize).ToHashSet();
			var originalImage = image != null && image.StartsWith("ea-", StringComparison.Ordinal);
			var originalVoxel = voxel != null && voxel.StartsWith("ea-", StringComparison.Ordinal) && original && (rs == null || originalImage);
			if (originalImage && !original)
				throw new Exception(faction + ": " + a.Info.Name + " shows original art " + image);

			if (originalImage || originalVoxel)
			{
				var foreign = palettes.Where(p => !IsOriginal(p) && !NeutralPalettes.Contains(p)).ToList();
				if (foreign.Count > 0)
					throw new Exception(faction + ": " + a.Info.Name + " (" + image + "/" + voxel + ") draws original art with project palettes " + string.Join(", ", foreign));
				originalActors++;
				originalTypes.Add(a.Info.Name);
			}
			else if (palettes.Any(IsOriginal))
				throw new Exception(faction + ": " + a.Info.Name + " (" + image + ") draws project art with original palettes " + string.Join(", ", palettes.Where(IsOriginal)));

			if (original && bundleHasOriginalArt && a.Info.HasTraitInfo<BuildableInfo>() && !originalImage && !originalVoxel)
				throw new Exception(faction + ": buildable actor still uses replacement art: " + a.Info.Name + " (" + image + "/" + voxel + ")");

			var sequences = image != null && world.Map.Sequences.Images.Contains(image)
				? world.Map.Sequences.Sequences(image).OrderBy(x => x, StringComparer.Ordinal).ToArray() : [];
			report.TryAdd(a.Info.Name, new ActorArt(image, voxel, sequences, palettes.OrderBy(x => x, StringComparer.Ordinal).ToArray()));
		}

		// No original file may be missing (the engine draws a missing sprite as nothing and only logs it).
		var missing = world.Map.Sequences.SpriteCache.MissingFiles.Where(m => m.Filename.Contains("web/ea", StringComparison.Ordinal)).Select(m => m.Filename).ToList();
		if (missing.Count > 0)
			throw new Exception(faction + ": original art files not found: " + string.Join(", ", missing));

		if (original && bundleHasOriginalArt && originalTypes.Count < 10)
			throw new Exception(faction + ": only " + originalTypes.Count + " actor types show original art");

		return (report, originalActors, originalTypes.Count);
	}

	static void Spawn(World world, string type, Player owner, CPos cell)
	{
		world.CreateActor(true, type, new TypeDictionary { new OwnerInit(owner), new LocationInit(cell), new FactionInit(owner.Faction.InternalName) });
	}
}
