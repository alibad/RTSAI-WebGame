using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using OpenRA;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.WebSim;

/// <summary>Actual deaths and falling husks must enter the same visible snapshot path in games and simulators.</summary>
static class CombatEffectsTest
{
	static readonly FieldInfo AnimationField = typeof(SpriteEffect).GetField("anim", BindingFlags.Instance | BindingFlags.NonPublic);
	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		var baseline = opts.ContainsKey("baseline");
		if (baseline) Game.Settings.Game.Platform = "Null";
		var results = new List<object>();
		foreach (var simulator in new[] { true, false })
		foreach (var unit in new[] { "r2basij", "r2sang", "e1", "r2ah64sa", "orca" })
		foreach (var water in unit is "r2ah64sa" or "orca" ? new[] { false, true } : new[] { false })
		{
			SimHost.Start(new ScenarioSpec
			{
				Map = opts.GetValueOrDefault("map", "twin-fords"), Bare = simulator, Sandbox = simulator,
				Players = [new PlayerSpec { Slot = "Multi0", Faction = "saudi", Bot = "webidle" }, new PlayerSpec { Slot = "Multi1", Faction = "iran", Bot = "webidle" }],
				Options = new() { ["fog"] = "False", ["explored"] = "True", ["crates"] = "False" }
			});
			var world = SimHost.World;
			var bounds = world.Map.Bounds;
			var cell = world.Map.AllCells.Where(c => world.Map.Contains(c) && (world.Map.GetTerrainInfo(c).Type == "Water") == water)
				.OrderBy(c => Math.Abs(c.ToMPos(world.Map).U - bounds.Left - bounds.Width / 2) + Math.Abs(c.ToMPos(world.Map).V - bounds.Top - bounds.Height / 2)).First();
			var actor = world.CreateActor(true, unit, new TypeDictionary
			{
				new OwnerInit(world.Players.First(p => p.Playable)), new LocationInit(cell),
				new CenterPositionInit(world.Map.CenterOfCell(cell) + new WVec(0, 0, unit is "r2ah64sa" or "orca" ? 3072 : 0)),
				new SkipMakeAnimsInit()
			});
			actor.Kill(actor, new BitSet<DamageType>("BulletDeath"));
			var seen = new HashSet<string>();
			var frames = 0;
			var fallFrames = 0;
			for (var tick = 0; tick < 180; tick++)
			{
				SimHost.Tick();
				Snapshot.Build();
				if (world.Actors.Any(a => a.Info.HasTraitInfo<FallsToEarthInfo>())) fallFrames++;
				foreach (var effect in world.Effects.OfType<SpriteEffect>())
				{
					var anim = (Animation)AnimationField.GetValue(effect);
					if (anim.CurrentSequence == null) continue;
					seen.Add(anim.CurrentSequence.Name);
					// Render() alone is insufficient: Snapshot only sees spatial effects registered in ScreenMap.
					if (world.ScreenMap.RenderableEffectsInBox(new int2(-100000, -100000), new int2(100000, 100000)).Contains(effect)
						&& effect.Render(SimHost.WorldRenderer).Any()) frames++;
				}
			}
			var passed = frames > 3 && (unit is "r2ah64sa" or "orca" ? fallFrames > 3 && seen.Contains(water ? "large_watersplash" : "large_twlt") : seen.Any(s => s.StartsWith("die")));
			results.Add(new { simulator, unit, water, frames, fallFrames, sequences = seen.Order().ToArray(), passed });
			if (!baseline && !passed) throw new Exception(JsonSerializer.Serialize(results));
		}
		Console.WriteLine(JsonSerializer.Serialize(new { passed = !baseline, baseline, cases = results }));
		SimHost.EndGame();
		return 0;
	}
}
