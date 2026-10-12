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

using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Linq;
using OpenRA.Graphics;
using System.Reflection;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Render-only: an actor of the listed factions draws its renderables with other palettes. The public isometric game
	/// gives the nine original countries the original Westwood art (RenderSprites.FactionImages), which needs the
	/// original palettes, while every other owner keeps the project art and palettes ("original palette iff original
	/// image"). The faction is the actor's FactionInit, exactly as RenderSprites picks the faction's image. Not a
	/// conditional trait and no simulation state: it changes only the palette references of what Actor.Render returns.
	/// </summary>
	[Desc("Draws actors of the listed factions with replacement palettes (render-only).")]
	public sealed class WithFactionPalettesInfo : TraitInfo, NotBefore<CloakInfo>
	{
		[Desc("Factions (FactionInit) whose actors use the replacement palettes.")]
		public readonly FrozenSet<string> Factions = FrozenSet<string>.Empty;

		[Desc("Player palette base names and their replacements (each is suffixed with the player's internal name).")]
		public readonly FrozenDictionary<string, string> PlayerPalettes = FrozenDictionary<string, string>.Empty;

		[Desc("Palette names and their replacements.")]
		public readonly FrozenDictionary<string, string> Palettes = FrozenDictionary<string, string>.Empty;

		public override object Create(ActorInitializer init) { return new WithFactionPalettes(init, this); }
	}

	public sealed class WithFactionPalettes : IRenderModifier, INotifyCreated
	{
		/// <summary>The image prefix of the original art: a disguise shows original palettes only on an original image.</summary>
		public const string OriginalImagePrefix = "ea-";

		readonly WithFactionPalettesInfo info;
		readonly bool factionMatches;
		readonly Dictionary<string, string> replacements = [];
		IEffectiveOwner[] effectiveOwners = [];

		public WithFactionPalettes(ActorInitializer init, WithFactionPalettesInfo info)
		{
			this.info = info;
			var faction = init.GetValue<FactionInit, string>(init.Self.Owner.Faction.InternalName);
			factionMatches = info.Factions.Contains(faction);
		}

		void INotifyCreated.Created(Actor self)
		{
			effectiveOwners = self.TraitsImplementing<IEffectiveOwner>().ToArray();
		}

		/// <summary>
		/// Whether the replacement palettes apply now: the actor's faction is listed, unless it is disguised. A spy shows
		/// the disguise target's image (for the disguise owner's faction): original palettes iff that image is original
		/// art. Other disguises (a mirage tank's scenery) show project art.
		/// </summary>
		public bool Active
		{
			get
			{
				foreach (var e in effectiveOwners)
				{
					if (!e.Disguised)
						continue;

					// OpenRA.Mods.Cnc's Disguise (internal): the disguise target and its owner, as WithDisguisingInfantryBody uses them.
					var asActor = DisguiseTarget(e);
					if (asActor != null && e.Owner != null)
					{
						var rs = asActor.TraitInfoOrDefault<RenderSpritesInfo>();
						return rs != null && rs.GetImage(asActor, e.Owner.Faction.InternalName).StartsWith(OriginalImagePrefix, StringComparison.Ordinal);
					}

					return false;
				}

				return factionMatches;
			}
		}

		static readonly Dictionary<Type, PropertyInfo> DisguiseTargets = [];

		static ActorInfo DisguiseTarget(IEffectiveOwner e)
		{
			var type = e.GetType();
			if (!DisguiseTargets.TryGetValue(type, out var property))
			{
				property = type.Name == "Disguise" ? type.GetProperty("AsActor", BindingFlags.Instance | BindingFlags.Public) : null;
				DisguiseTargets[type] = property;
			}

			return property?.GetValue(e) as ActorInfo;
		}

		IEnumerable<IRenderable> IRenderModifier.ModifyRender(Actor self, WorldRenderer wr, IEnumerable<IRenderable> r)
		{
			return Active ? Replace(wr, r) : r;
		}

		IEnumerable<IRenderable> Replace(WorldRenderer wr, IEnumerable<IRenderable> renderables)
		{
			foreach (var r in renderables)
			{
				if (r is IPalettedRenderable p && p.Palette != null)
				{
					var name = Replacement(wr.World, p.Palette.Name);
					if (name != null)
					{
						yield return p.WithPalette(wr.Palette(name));
						continue;
					}
				}

				yield return r;
			}
		}

		/// <summary>The replacement of a palette name, or null to keep it (cached per actor).</summary>
		public string Replacement(World world, string palette)
		{
			if (replacements.TryGetValue(palette, out var to))
				return to;

			if (!info.Palettes.TryGetValue(palette, out to))
			{
				to = null;
				foreach (var (from, into) in info.PlayerPalettes)
				{
					if (!palette.StartsWith(from, StringComparison.Ordinal))
						continue;

					var player = palette[from.Length..];
					if (world.Players.Any(p => p.InternalName == player))
					{
						to = into + player;
						break;
					}
				}
			}

			replacements[palette] = to;
			return to;
		}

		IEnumerable<Rectangle> IRenderModifier.ModifyScreenBounds(Actor self, WorldRenderer wr, IEnumerable<Rectangle> r)
		{
			return r;
		}
	}
}
