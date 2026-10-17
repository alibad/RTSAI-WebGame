using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using OpenRA.Graphics;
using OpenRA.Primitives;
using OpenRA.Mods.Common.EditorBrushes;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	public static class EditorPlacement
	{
		public static IEnumerable<CPos> Cells(ActorInfo info, CPos location)
		{
			var dimensions = info.TraitInfoOrDefault<BuildingInfo>()?.Dimensions ?? new CVec(1, 1);
			for (var y = 0; y < dimensions.Y; y++)
				for (var x = 0; x < dimensions.X; x++) yield return location + new CVec(x, y);
		}

		public static bool Water(Map map, CPos c)
		{
			var name = map.GetTerrainInfo(c).Type;
			return name == "Water" || name.Contains("Water", StringComparison.Ordinal);
		}

		public static string Blocked(World world, EditorActorPreview preview)
		{
			var map = world.Map;
			var info = preview.Info;
			var cells = Cells(info, preview.Location).ToArray();
			if (cells.Any(c => !map.Contains(c))) return "Place the whole object inside the battlefield.";
			if (info.TraitInfoOrDefault<MapEditorDataInfo>()?.Categories.Contains("System") == true) return null;
			var b = info.TraitInfoOrDefault<BuildingInfo>();
			if (info.Name.StartsWith("lobrd", StringComparison.Ordinal))
			{
				if (info.Name.Contains("_r_", StringComparison.Ordinal))
				{
					if (cells.Any(c => Water(map, c)) || !cells.Any(c => CVec.Directions.Any(d => map.Contains(c + d) && Water(map, c + d))))
						return "Bridge ramps belong on a dry riverbank beside water. Use the crossing tool to join both banks.";
				}
				else if (!cells.Any(c => Water(map, c))) return "Bridge spans must cross water. Drag between two banks with the crossing tool.";
			}
			else if (b != null && b.TerrainTypes.Count > 0 && cells.Any(c => !b.TerrainTypes.Contains(map.GetTerrainInfo(c).Type)))
				return b.TerrainTypes.Contains("Water") ? "This structure needs water." : "This structure needs suitable dry ground.";
			if (b != null && (cells.Any(c => map.Ramp[c] != 0) || cells.Select(c => map.Height[c]).Distinct().Count() > 1))
				return "Flatten this structure's whole footprint before placing it.";
			if (b != null && cells.Any(c => map.Resources[c].Type != 0)) return "Place structures clear of ore and gems.";
			var actors = world.WorldActor.Trait<EditorActorLayer>();
			var mobile = info.TraitInfoOrDefault<MobileInfo>();
			if (mobile != null && cells.Any(c => !mobile.LocomotorInfo.TerrainSpeeds.ContainsKey(map.GetTerrainInfo(c).Type)
				&& !actors.PreviewsAtCell(c).Any(p => p.Type.StartsWith("lobrd", StringComparison.Ordinal) && !p.Type.EndsWith("_d", StringComparison.Ordinal))))
				return mobile.LocomotorInfo.TerrainSpeeds.ContainsKey("Water") ? "This unit needs navigable water." : "This unit needs passable ground.";
			if (cells.Any(c => actors.PreviewsAtCell(c).Any(p => mobile?.LocomotorInfo.SharesCell != true || p.Info.TraitInfoOrDefault<MobileInfo>()?.LocomotorInfo.SharesCell != true))
				|| mobile?.LocomotorInfo.SharesCell == true && actors.FreeSubCellAt(preview.Location) == SubCell.Invalid)
				return "This space already contains an object.";
			return null;
		}

		public static IEnumerable<IRenderable> Tint(IEnumerable<IRenderable> renderables, bool invalid)
		{
			foreach (var r in renderables)
				yield return invalid && r is IModifyableRenderable mr ? mr.WithTint(new Vector3(1f, .25f, .2f), mr.TintModifiers) : r;
		}
	}

	/// <summary>Keep native actor placement and undo, but reject unusable footprints before adding history.</summary>
	public sealed class EditorCheckedActorBrush : IEditorBrush
	{
		readonly EditorActorBrush native;
		readonly IEditorBrush brush;
		readonly WorldRenderer wr;
		public int Added { get; private set; }
		public string Blocked { get; private set; }
		public EditorCheckedActorBrush(EditorViewportControllerWidget controller, ActorInfo info, PlayerReference owner, WorldRenderer wr)
		{
			this.wr = wr;
			native = new EditorActorBrush(controller, info, owner, wr);
			brush = native;
		}
		public bool HandleMouseInput(MouseInput mi)
		{
			if (mi.Button == MouseButton.Left && mi.Event == MouseInputEvent.Down)
			{
				brush.TickRender(wr, wr.World.WorldActor);
				Added = 0;
				Blocked = EditorPlacement.Blocked(wr.World, native.Preview);
				if (Blocked != null) return true;
				brush.HandleMouseInput(mi); Added = 1; return true;
			}
			return brush.HandleMouseInput(mi);
		}
		public void Tick() => brush.Tick();
		public void TickRender(WorldRenderer renderer, Actor self) => brush.TickRender(renderer, self);
		public IEnumerable<IRenderable> RenderAboveShroud(Actor self, WorldRenderer renderer) => EditorPlacement.Tint(brush.RenderAboveShroud(self, renderer), EditorPlacement.Blocked(wr.World, native.Preview) != null);
		public IEnumerable<IRenderable> RenderAnnotations(Actor self, WorldRenderer renderer) => brush.RenderAnnotations(self, renderer);
		public void Dispose() => brush.Dispose();
	}

	/// <summary>A complete three-cell-wide ground-level crossing, one native editor action.</summary>
	public sealed class EditorBridgeBrush : IEditorBrush
	{
		readonly EditorViewportControllerWidget controller;
		readonly WorldRenderer wr;
		readonly PlayerReference owner;
		readonly string material;
		readonly bool ruined;
		CPos? start;
		CPos? previous;
		EditorActorPreview[] previews = [];
		public int Added { get; private set; }
		public string Blocked { get; private set; }
		public EditorBridgeBrush(EditorViewportControllerWidget controller, WorldRenderer wr, string material, bool ruined)
		{
			this.controller = controller; this.wr = wr; this.material = material == "concrete" ? "lobrdb" : "lobrdg"; this.ruined = ruined;
			var players = wr.World.WorldActor.Trait<EditorActorLayer>().Players.Players;
			owner = players.TryGetValue("Neutral", out var neutral) ? neutral : players.Values.First();
		}

		public static (List<ActorReference> Actors, string Error) Plan(World world, CPos from, CPos to, string material, bool ruined = false)
		{
			var map = world.Map;
			var actors = world.WorldActor.Trait<EditorActorLayer>();
			var travelY = Math.Abs(to.Y - from.Y) >= Math.Abs(to.X - from.X);
			var distance = travelY ? Math.Abs(to.Y - from.Y) : Math.Abs(to.X - from.X);
			if (distance < 2) return ([], "Drag from a dry bank to the opposite bank across water.");
			if (distance > 64) return ([], "Choose a crossing shorter than 64 cells.");
			var a = travelY ? new CPos(from.X, Math.Min(from.Y, to.Y)) : new CPos(Math.Min(from.X, to.X), from.Y);
			var step = travelY ? new CVec(0, 1) : new CVec(1, 0);
			var width = travelY ? new CVec(1, 0) : new CVec(0, 1);
			var family = material is "concrete" or "lobrdb" ? "lobrdb" : "lobrdg";
			// A mapper can start back from the shore: snap the approaches to the first
			// dry three-cell row at each edge instead of asking for pixel-perfect banks.
			var requested = Enumerable.Range(0, distance + 1).SelectMany(i => Enumerable.Range(-1, 3).Select(j => a + step * i + width * j)).ToArray();
			if (requested.Any(c => !map.Contains(c))) return ([], "Keep the entire crossing inside the battlefield.");
			var wetRows = Enumerable.Range(0, distance + 1).Where(i => Enumerable.Range(-1, 3).Any(j => Water(map, a + step * i + width * j))).ToArray();
			if (wetRows.Length > 0)
			{
				if (wetRows[0] == 0 || wetRows[^1] == distance) return ([], "Start and finish on dry banks on opposite sides of the water.");
				a += step * (wetRows[0] - 1);
				distance = wetRows[^1] - wetRows[0] + 2;
			}
			var list = new List<ActorReference>();
			for (var i = 0; i <= distance; i++)
			{
				var center = a + step * i;
				var type = family + (i == 0 ? travelY ? "_r_ne" : "_r_nw" : i == distance ? travelY ? "_r_sw" : "_r_se" : travelY ? "_a" : "_b");
				if (ruined && i > 0 && i < distance) type += "_d";
				list.Add(new ActorReference(type, new TypeDictionary { new LocationInit(center - width), new OwnerInit("Neutral") }));
			}
			var footprint = Enumerable.Range(0, distance + 1).SelectMany(i => Enumerable.Range(-1, 3).Select(j => a + step * i + width * j)).ToArray();
			if (footprint.Any(c => !map.Contains(c))) return ([], "Keep the entire crossing inside the battlefield.");
			var bankA = Enumerable.Range(-1, 3).Select(j => a + width * j);
			var bankB = Enumerable.Range(-1, 3).Select(j => a + step * distance + width * j);
			if (bankA.Concat(bankB).Any(c => Water(map, c))) return (list, "Both ends need a dry, three-cell-wide bank. Spans go over water; ramps go on land.");
			if (!Enumerable.Range(1, distance - 1).Any(i => Water(map, a + step * i))) return (list, "A bridge must cross water. This route is entirely on land.");
			if (Enumerable.Range(1, distance - 1).Any(i => !GroundPreparation.Water(map, a + step * i))) return (list, "Choose the banks directly beside one continuous river or channel.");
			if (footprint.Any(c => map.Ramp[c] != 0) || footprint.Select(c => map.Height[c]).Distinct().Count() > 1)
				return (list, "The crossing needs flat banks at the water's height. Flatten the approaches first.");
			if (footprint.Any(c => actors.PreviewsAtCell(c).Any())) return (list, "The crossing overlaps an existing object. Choose a clear route.");
			if (footprint.Any(c => map.Resources[c].Type != 0)) return (list, "The crossing overlaps ore or gems. Choose clear banks.");
			return (list, null);
		}

		static bool Water(Map map, CPos c) => EditorPlacement.Water(map, c);
		void Preview(CPos end)
		{
			if (start == null || previous == end) return;
			previous = end;
			var plan = Plan(wr.World, start.Value, end, material, ruined);
			Blocked = plan.Error;
			previews = plan.Actors.Select(r => new EditorActorPreview(wr, null, r, owner)).ToArray();
		}
		public bool HandleMouseInput(MouseInput mi)
		{
			if (mi.Button == MouseButton.Right) { if (mi.Event == MouseInputEvent.Up) controller.ClearBrush(); return true; }
			var cell = wr.Viewport.ViewToWorld(mi.Location);
			if (mi.Button == MouseButton.Left && mi.Event == MouseInputEvent.Down)
			{
				start = cell; previous = null; Added = 0; previews = []; Blocked = "Drag to the opposite dry bank, then release."; return true;
			}
			if (mi.Event == MouseInputEvent.Move) { Preview(cell); return true; }
			if (mi.Button == MouseButton.Left && mi.Event == MouseInputEvent.Up && start != null)
			{
				var plan = Plan(wr.World, start.Value, cell, material, ruined);
				Blocked = plan.Error;
				if (Blocked == null)
				{
					var action = new CrossingAction(wr.World.WorldActor.Trait<EditorActorLayer>(), plan.Actors);
					wr.World.WorldActor.Trait<EditorActionManager>().Add(action); Added = plan.Actors.Count;
				}
				start = null; previous = null; previews = []; return true;
			}
			return false;
		}
		public void Tick() { }
		public void TickRender(WorldRenderer renderer, Actor self) { }
		public IEnumerable<IRenderable> RenderAboveShroud(Actor self, WorldRenderer renderer) => EditorPlacement.Tint(previews.SelectMany(p => p.Render()), Blocked != null);
		public IEnumerable<IRenderable> RenderAnnotations(Actor self, WorldRenderer renderer) => [];
		public void Dispose() { previews = []; }

		sealed class CrossingAction(EditorActorLayer layer, List<ActorReference> references) : IEditorAction
		{
			EditorActorPreview[] placed = [];
			public string Text => "Placed river crossing";
			public void Execute() => Do();
			public void Do() => placed = references.Select(r => layer.Add(r.Clone())).ToArray();
			public void Undo() { foreach (var p in placed) layer.Remove(p); }
		}
	}
}
