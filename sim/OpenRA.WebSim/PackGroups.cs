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
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Sprite pack groups for the browser (SpriteCache.PackGroup): the faction whose actors are the only users of a
	/// sprite file; "fx" for files only effects use (explosions, projectiles, smudges: images no actor renders as
	/// itself), which a game needs only once fighting starts; or "" for files any side may show. Each group is packed into sheets of its own, so the page loads
	/// the shared sheets and those of the factions in the match, and the rest only if they ever appear.
	/// Derived from the rules: an actor belongs to a faction when it requires that faction's prerequisite
	/// (e.g. ~faction.china) and its images (including RenderSprites.FactionImages) are that faction's.
	/// Render-side only: grouping changes where sprites sit in the sheets, never the simulation.
	/// </summary>
	public static class PackGroups
	{
		public static Func<string, string> For(Map map)
		{
			var rules = map.Rules;
			var factions = rules.Actors[SystemActors.World].TraitInfos<FactionInfo>()
				.Where(f => f.Selectable && f.RandomFactionMembers.Count == 0)
				.Select(f => f.InternalName).ToHashSet();

			// Image -> factions that show it ("" when an actor of no particular faction does).
			var imageUsers = new Dictionary<string, HashSet<string>>();
			void Use(string image, string faction)
			{
				if (!imageUsers.TryGetValue(image, out var set))
					imageUsers[image] = set = [];
				set.Add(faction ?? "");
			}

			foreach (var actor in rules.Actors.Values)
			{
				if (actor.Name.StartsWith('^'))
					continue;

				var rs = actor.TraitInfoOrDefault<RenderSpritesInfo>();
				if (rs == null)
					continue;

				var owner = ActorFaction(actor, factions);

				// With an image for every faction, the default image only shows for owners of no faction (rare, and
				// fetched on demand then): it does not make that image shared.
				var everyFaction = rs.FactionImages != null && factions.All(rs.FactionImages.ContainsKey);
				if (!everyFaction)
					Use(rs.GetImage(actor, null), owner);
				if (rs.FactionImages != null)
					foreach (var (faction, image) in rs.FactionImages)
						Use(image.ToLowerInvariant(), factions.Contains(faction) ? faction : null);
			}

			// Images named by weapons (projectile and warhead fields): explosions, missiles, trails, debris.
			var sequences = map.Sequences;
			var allImages = sequences.Images.ToHashSet();
			var fxImages = new HashSet<string>();
			foreach (var weapon in rules.Weapons.Values)
			{
				CollectImageNames(weapon.Projectile, allImages, fxImages);
				foreach (var warhead in weapon.Warheads)
					CollectImageNames(warhead, allImages, fxImages);
			}

			// Sequence images -> their files' reservation tokens -> files.
			var tokenFiles = sequences.SpriteCache.ReservedTokens().ToDictionary(r => r.Token, r => r.Filename);
			var fileUsers = new Dictionary<string, HashSet<string>>();
			foreach (var image in sequences.Images)
			{
				// Images only weapons name (projectiles, explosions, trails) are effects; anything else is shared.
				var users = imageUsers.TryGetValue(image, out var u) ? u : fxImages.Contains(image) ? ["fx"] : [""];
				foreach (var name in sequences.Sequences(image))
				{
					// Death animations (die, die1, die-burn...) play only once fighting starts: a file only they use
					// (special deaths such as nukedie or electro) is an effect too.
					var sequenceUsers = name.StartsWith("die", StringComparison.Ordinal) ? DeathUsers : users;
					foreach (var token in Tokens(sequences.GetSequence(image, name)))
					{
						if (!tokenFiles.TryGetValue(token, out var file))
							continue;

						if (!fileUsers.TryGetValue(file, out var set))
							fileUsers[file] = set = [];
						set.UnionWith(sequenceUsers);
					}
				}
			}

			var groups = new Dictionary<string, string>();
			foreach (var (file, users) in fileUsers)
			{
				// One faction (or effects only): that group. Effects and one faction: the faction's (its own weapons).
				var named = users.Where(x => x != "fx").ToList();
				groups[file] = named.Count == 0 ? "fx"
					: named.Count == 1 && named[0] != "" ? named[0]
					: "";
			}

			return file => groups.TryGetValue(file, out var g) ? g : "";
		}

		/// <summary>Every string (or string collection) field of an object that names a sequence image.</summary>
		static void CollectImageNames(object info, HashSet<string> images, HashSet<string> found)
		{
			if (info == null)
				return;

			foreach (var f in info.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public))
			{
				var value = f.GetValue(info);
				if (value is string str)
				{
					if (images.Contains(str.ToLowerInvariant()))
						found.Add(str.ToLowerInvariant());
				}
				else if (value is System.Collections.Immutable.ImmutableArray<string> { IsDefault: true })
					continue;
				else if (value is IEnumerable<string> list)
				{
					foreach (var item in list)
						if (item != null && images.Contains(item.ToLowerInvariant()))
							found.Add(item.ToLowerInvariant());
				}
			}
		}

		/// <summary>The one faction whose prerequisite the actor needs to be built, or null.</summary>
		static string ActorFaction(ActorInfo actor, HashSet<string> factions)
		{
			var bi = actor.TraitInfoOrDefault<Mods.Common.Traits.BuildableInfo>();
			if (bi == null)
				return null;

			string found = null;
			foreach (var p in bi.Prerequisites)
			{
				if (p.StartsWith('!'))
					continue;

				var dot = p.LastIndexOf('.');
				var tail = dot < 0 ? null : p[(dot + 1)..];
				if (tail != null && factions.Contains(tail))
				{
					if (found != null && found != tail)
						return null;
					found = tail;
				}
			}

			return found;
		}

		static readonly HashSet<string> DeathUsers = ["fx"];

		static readonly Dictionary<Type, FieldInfo> ReservationFields = [];

		/// <summary>The reservation tokens of a sprite sequence (DefaultSpriteSequence keeps them in spritesToLoad).</summary>
		static IEnumerable<int> Tokens(ISpriteSequence sequence)
		{
			var type = sequence.GetType();
			if (!ReservationFields.TryGetValue(type, out var field))
			{
				for (var t = type; t != null && field == null; t = t.BaseType)
					field = t.GetField("spritesToLoad", BindingFlags.Instance | BindingFlags.NonPublic);
				ReservationFields[type] = field;
			}

			if (field?.GetValue(sequence) is not System.Collections.IEnumerable list)
				yield break;

			foreach (var r in list)
			{
				var token = r.GetType().GetField("Token")?.GetValue(r);
				if (token is int t)
					yield return t;
			}
		}
	}
}
