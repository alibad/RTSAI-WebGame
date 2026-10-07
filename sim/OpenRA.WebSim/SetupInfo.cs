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

using System.IO;
using System.Linq;
using System.Text;
using OpenRA.FileSystem;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>What the skirmish setup screen offers: factions, maps and bot types, straight from the mod's rules.</summary>
	public static class SetupInfo
	{
		static string J(string s) => Snapshot.Json(s);

		static string Msg(string key) => string.IsNullOrEmpty(key) ? "" : FluentProvider.GetMessage(key);

		public static string Json()
		{
			var modData = SimHost.ModData;
			var rules = modData.DefaultRules;
			var sb = new StringBuilder("{");

			var factions = rules.Actors[SystemActors.World].TraitInfos<FactionInfo>().Where(f => f.Selectable);
			sb.Append("\"factions\":[");
			sb.Append(string.Join(",", factions.Select(f =>
				$"{{\"id\":{J(f.InternalName)},\"name\":{J(Msg(f.Name))},\"side\":{J(f.Side)},\"description\":{J(Msg(f.Description))}," +
				$"\"random\":{(f.RandomFactionMembers.Count > 0 ? "true" : "false")}}}")));
			sb.Append("],");

			var bots = rules.Actors[SystemActors.Player].TraitInfos<IBotInfo>().Where(b => b.Type != "webidle");
			sb.Append("\"bots\":[");
			sb.Append(string.Join(",", bots.Select(b => $"{{\"type\":{J(b.Type)},\"name\":{J(Msg(b.Name))}}}")));
			sb.Append("],");

			var maps = modData.MapCache
				.Where(p => p.Status == MapStatus.Available && p.Visibility.HasFlag(MapVisibility.Lobby) && p.PlayerCount >= 2)
				.OrderBy(p => p.PlayerCount).ThenBy(p => p.Title).ToList();

			// Lobby options (starting units, cash, fog...) as the lobby offers them, for the first map; the per-map
			// differences in this mod are only the locked ones.
			var first = maps.FirstOrDefault();
			if (first != null)
			{
				var options = rules.Actors[SystemActors.Player].TraitInfos<ILobbyOptions>()
					.Concat(rules.Actors[SystemActors.World].TraitInfos<ILobbyOptions>())
					.SelectMany(t => t.LobbyOptions(first))
					.Where(o => o.IsVisible && !o.IsLocked)
					.OrderBy(o => o.DisplayOrder);
				sb.Append("\"options\":[");
				sb.Append(string.Join(",", options.Select(o =>
					$"{{\"id\":{J(o.Id)},\"name\":{J(Msg(o.Name))},\"default\":{J(o.DefaultValue)}," +
					$"\"values\":[{string.Join(",", o.Values.Select(v => $"{{\"value\":{J(v.Key)},\"label\":{J(Msg(v.Value))}}}"))}]}}")));
				sb.Append("],");
			}
			sb.Append("\"maps\":[");
			sb.Append(string.Join(",", maps.Select(p =>
			{
				var slots = p.Players.Players.Values.Where(r => r.Playable).Select(r => r.Name).OrderBy(n => n);
				return $"{{\"id\":{J(Path.GetFileName(p.Path))},\"uid\":{J(p.Uid)},\"title\":{J(p.Title)},\"players\":{p.PlayerCount}," +
					$"\"tileset\":{J(p.TileSet)},\"author\":{J(p.Author)},\"slots\":[{string.Join(",", slots.Select(J))}]}}";
			})));
			sb.Append("]}");
			return sb.ToString();
		}

		/// <summary>The map's preview image (map.png in its package), or empty.</summary>
		public static byte[] Preview(string mapId)
		{
			IReadOnlyFileSystem preview = SimHost.ModData.MapCache.FirstOrDefault(p => Path.GetFileName(p.Path) == mapId);
			if (preview == null || !preview.TryOpen("map.png", out var s))
				return [];

			using var _ = s;
			using var ms = new MemoryStream();
			s.CopyTo(ms);
			return ms.ToArray();
		}
	}
}
