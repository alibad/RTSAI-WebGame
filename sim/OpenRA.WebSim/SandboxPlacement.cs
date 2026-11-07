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
using System.Numerics;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Orders;
using OpenRA.Mods.Common.Traits;
using OpenRA.Orders;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The battle simulator's placement brush, armed from the palette. At the cursor it draws the engine's own placement
	/// preview: a building shows its green and red footprint grid with its picture see-through, as a match's
	/// PlaceBuildingOrderGenerator draws it; units show see-through on the cells they would take. One rule (Where)
	/// decides both the preview and the click: a building stands only where it can (no water, cliff, slope or other
	/// actor under it), and units go on cells their locomotor can enter, the nearest free ones if the cursor's are taken.
	/// </summary>
	public static class SandboxPlacement
	{
		public readonly record struct Spot(CPos Cell, bool Ok);

		/// <summary>Where a click places: the cells (a building's footprint, or one cell per unit) and why it can't, if it can't.</summary>
		public sealed class Plan
		{
			public CPos TopLeft;
			public readonly List<Spot> Spots = [];
			public string Blocked;
		}

		/// <summary>Units further than this from the cursor's cells are not placed (cells, searching outwards).</summary>
		const int SearchRadius = 6;

		/// <summary>The cell under the cursor changed since the last snapshot (the preview needs redrawing).</summary>
		static bool moved;

		public static bool TakeMoved()
		{
			var m = moved;
			moved = false;
			return m;
		}

		public static Plan Where(World world, ActorInfo info, CPos cell, int count)
		{
			var plan = new Plan();
			var building = info.TraitInfoOrDefault<BuildingInfo>();
			if (building != null)
			{
				// The cursor holds the building's middle, as the click places it (Ui "spawn").
				plan.TopLeft = cell - new CVec(building.Dimensions.X / 2, building.Dimensions.Y / 2);
				foreach (var t in building.Tiles(plan.TopLeft))
				{
					var ok = world.Map.Contains(t) && world.IsCellBuildable(t, info, building);
					plan.Spots.Add(new Spot(t, ok));
					if (!ok)
						plan.Blocked ??= WhyNot(world, t, info, building);
				}

				return plan;
			}

			plan.TopLeft = cell;
			var used = new HashSet<CPos>();
			var columns = System.Math.Max(1, (int)System.Math.Ceiling(System.Math.Sqrt(count)));
			for (var i = 0; i < count; i++)
			{
				var wanted = cell + new CVec(i % columns - columns / 2, i / columns - columns / 2);
				var spot = CanStand(world, info, wanted) && used.Add(wanted) ? wanted : Nearest(world, info, wanted, used);
				if (spot is CPos found)
					plan.Spots.Add(new Spot(found, true));
				else
					plan.Spots.Add(new Spot(wanted, false));
			}

			if (plan.Spots.All(s => !s.Ok))
				plan.Blocked = WhyNot(world, cell, info, null);

			return plan;
		}

		static CPos? Nearest(World world, ActorInfo info, CPos from, HashSet<CPos> used)
		{
			foreach (var c in world.Map.FindTilesInCircle(from, SearchRadius))
				if (!used.Contains(c) && CanStand(world, info, c))
				{
					used.Add(c);
					return c;
				}

			return null;
		}

		static bool CanStand(World world, ActorInfo info, CPos cell)
		{
			if (!world.Map.Contains(cell))
				return false;

			var mobile = info.TraitInfoOrDefault<MobileInfo>();
			if (mobile != null)
				return mobile.CanEnterCell(world, null, cell);

			// Aircraft and the rest: anywhere on the map but inside a building.
			return !world.WorldActor.Trait<BuildingInfluence>().AnyBuildingAt(cell);
		}

		/// <summary>The player's reason, in a few words.</summary>
		static string WhyNot(World world, CPos cell, ActorInfo info, BuildingInfo building)
		{
			if (!world.Map.Contains(cell))
				return "Off the map";

			if (world.ActorMap.GetActorsAt(cell).Any() || world.WorldActor.Trait<BuildingInfluence>().AnyBuildingAt(cell))
				return "Something is already there";

			var terrain = world.Map.GetTerrainInfo(cell).Type;
			var mobile = building == null ? info.TraitInfoOrDefault<MobileInfo>() : null;
			if (mobile != null && terrain != "Water" && mobile.Locomotor.Contains("naval", System.StringComparison.OrdinalIgnoreCase))
				return "Ships need water";

			if (building != null && world.Map.Ramp[cell] != 0)
				return "Buildings need level ground";

			if (terrain == "Water")
				return building != null ? "Not on water" : "Land units can't go on water";

			if (terrain == "Cliff" || terrain == "Impassable")
				return "Not on cliffs or rocks";

			return "Can't place it here";
		}

		/// <summary>
		/// An actor's sprites as the page composes them into a picture (Renderer.renderTiles), relative to its centre on
		/// screen: the map editor's palette and the simulator's card for actors whose art is sprites (buildings).
		/// </summary>
		public static List<object> SpriteParts(WorldRenderer wr, IEnumerable<IRenderable> renderables, WPos center)
		{
			var origin = wr.ScreenPxPosition(center);
			var parts = new List<object>();
			foreach (var renderable in renderables)
			{
				if (renderable is not SpriteRenderable sr || sr.IsDecoration || sr.Sprite.Bounds.Width == 0)
					continue;
				var s = sr.Sprite;
				var half = 0.5f * sr.Scale * s.Size;
				var screen = wr.Screen3DPosition(sr.Origin);
				var off = wr.ScreenPxOffset(sr.Offset);
				var tex = Snapshot.TextureId(s.Sheet);
				Snapshot.MarkTexture(tex);
				parts.Add(new { x = screen.X + off.X - (int)half.X + sr.Scale * s.Offset.X - origin.X,
					y = screen.Y + off.Y - (int)half.Y + sr.Scale * s.Offset.Y - origin.Y,
					tex, channel = (int)s.Channel, uv = new[] { s.Left, s.Top, s.Right, s.Bottom },
					w = s.Bounds.Width, h = s.Bounds.Height, pal = sr.Palette?.TextureIndex ?? 0,
					scale = sr.Scale, alpha = sr.Alpha });
			}

			return parts;
		}

		/// <summary>An actor's placement preview as an owner would build it (its idle look, facing the enemy).</summary>
		public static IActorPreview[] Previews(WorldRenderer wr, ActorInfo info, Player owner, WAngle facing, out TypeDictionary inits)
		{
			inits = new TypeDictionary
			{
				new FactionInit(owner.Faction.InternalName),
				new OwnerInit(owner),
			};
			foreach (var api in info.TraitInfos<IActorPreviewInitInfo>())
				foreach (var o in api.ActorPreviewInits(info, ActorPreviewType.PlaceBuilding))
					inits.Add(o);

			// Facing the enemy, as the placed actor will (the traits' own preview facing gives way).
			if (inits.GetOrDefault<FacingInit>() is FacingInit own)
				inits.Remove(own);
			inits.Add(new FacingInit(facing));

			var init = new ActorPreviewInitializer(info, wr, inits);
			return info.TraitInfos<IRenderActorPreviewInfo>().SelectMany(rpi => rpi.RenderPreview(init)).ToArray();
		}

		/// <summary>The brush: the preview at the cursor, and the blocked cursor where a click would place nothing.</summary>
		public sealed class Brush : OrderGenerator
		{
			public readonly ActorInfo Info;
			readonly int count;
			readonly IPlaceBuildingPreview buildingPreview;
			readonly IActorPreview[] actorPreview;
			readonly WVec buildingCenter;
			readonly Sprite validTile, blockedTile;
			readonly float validAlpha, blockedAlpha;
			readonly string tilePalette = TileSet.TerrainPaletteInternalName;
			CPos? cell;
			Plan plan;

			protected override MouseActionType ActionType => MouseActionType.PlaceBuilding;

			public Brush(World world, WorldRenderer wr, ActorInfo info, Player owner, int count, WAngle facing)
				: base(world)
			{
				Info = info;
				this.count = info.HasTraitInfo<BuildingInfo>() ? 1 : System.Math.Clamp(count, 1, 50);
				actorPreview = Previews(wr, info, owner, facing, out var td);
				var building = info.TraitInfoOrDefault<BuildingInfo>();
				if (building != null)
				{
					buildingPreview = info.TraitInfoOrDefault<IPlaceBuildingPreviewGeneratorInfo>()?.CreatePreview(wr, info, td);
					buildingCenter = building.CenterOffset(world);

					// A preview that already draws the building (ActorPreviewPlaceBuildingPreview) needs no second one.
					if (buildingPreview is ActorPreviewPlaceBuildingPreviewPreview)
						actorPreview = [];
				}

				// The match's placement tiles (FootprintPlaceBuildingPreview), for units' cells too.
				var sequences = world.Map.Sequences;
				var tileset = world.Map.Tileset.ToLowerInvariant();
				var valid = sequences.HasSequence("overlay", $"build-valid-{tileset}")
					? sequences.GetSequence("overlay", $"build-valid-{tileset}") : sequences.GetSequence("overlay", "build-valid");
				var blocked = sequences.GetSequence("overlay", "build-invalid");
				validTile = valid.GetSprite(0);
				validAlpha = valid.GetAlpha(0);
				blockedTile = blocked.GetSprite(0);
				blockedAlpha = blocked.GetAlpha(0);
			}

			Plan PlanAt(World world, CPos at)
			{
				if (cell != at || plan == null)
				{
					cell = at;
					plan = Where(world, Info, at, count);
					moved = true;
				}

				return plan;
			}

			protected override string GetCursor(World world, CPos cell, int2 worldPixel, MouseInput mi)
			{
				return PlanAt(world, cell).Blocked == null ? "default" : "generic-blocked";
			}

			/// <summary>After a placement the cells under the cursor are taken: plan them again.</summary>
			public void Invalidate()
			{
				plan = null;
				moved = true;
			}

			protected override IEnumerable<Order> OrderInner(World world, CPos cell, int2 worldPixel, MouseInput mi) { yield break; }

			protected override IEnumerable<IRenderable> Render(WorldRenderer wr, World world) { yield break; }

			protected override IEnumerable<IRenderable> RenderAboveShroud(WorldRenderer wr, World world)
			{
				if (cell is not CPos at)
					yield break;

				var p = PlanAt(world, at);
				if (Info.HasTraitInfo<BuildingInfo>())
				{
					var footprint = p.Spots.ToDictionary(s => s.Cell, s => s.Ok ? PlaceBuildingCellType.Valid : PlaceBuildingCellType.Invalid);
					if (buildingPreview != null)
						foreach (var r in buildingPreview.Render(wr, p.TopLeft, footprint))
							yield return r;

					// The building itself, see-through where it would stand; red where it can't.
					var center = world.Map.CenterOfCell(p.TopLeft) + buildingCenter;
					foreach (var preview in actorPreview)
						foreach (var r in preview.Render(wr, center))
							yield return Ghost(r, p.Blocked == null);

					yield break;
				}

				var palette = wr.Palette(tilePalette);
				foreach (var s in p.Spots)
				{
					var pos = world.Map.CenterOfCell(s.Cell);
					yield return new SpriteRenderable(s.Ok ? validTile : blockedTile, pos, WVec.Zero, -511, palette, 1f,
						s.Ok ? validAlpha : blockedAlpha, Vector3.One, TintModifiers.IgnoreWorldTint, true);
					if (!s.Ok)
						continue;

					foreach (var preview in actorPreview)
						foreach (var r in preview.Render(wr, pos))
							yield return Ghost(r, true);
				}
			}

			/// <summary>See-through, with a green cast where it fits and red where it doesn't.</summary>
			static IRenderable Ghost(IRenderable r, bool fits)
			{
				if (r is not IModifyableRenderable m)
					return r;

				return m.WithTint(fits ? new Vector3(0.85f, 1f, 0.85f) : new Vector3(1f, 0.35f, 0.3f), m.TintModifiers).WithAlpha(fits ? 0.55f : 0.5f);
			}

			protected override IEnumerable<IRenderable> RenderAnnotations(WorldRenderer wr, World world)
			{
				if (buildingPreview == null || cell is not CPos at)
					yield break;

				foreach (var r in buildingPreview.RenderAnnotations(wr, PlanAt(world, at).TopLeft))
					yield return r;
			}
		}
	}
}
