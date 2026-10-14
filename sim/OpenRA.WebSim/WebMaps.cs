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
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Reflection;
using OpenRA.FileSystem;
using OpenRA.Primitives;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The mod's maps, without loading every one at boot. MapCache.LoadMaps opens each map package, hashes it, parses its
	/// map.yaml and merges a map's custom rules with the whole ruleset (20 of the 22 bundled maps have custom rules, the
	/// missions): about 2.3 s of the boot in Chrome and 12 to 13 s in Firefox. Here the boot loads only the maps the setup
	/// screen lists (Lobby visibility, the skirmish maps) and registers every other one by name; a map joins the MapCache
	/// the first time it is prepared or played (SimHost.MapPath, Prepare), exactly as LoadMaps would have added it. Map
	/// pictures are read straight from their packages. EnsureAll gives the boot's old state (the native baker).
	/// </summary>
	public static class WebMaps
	{
		/// <summary>Maps not loaded yet, by folder name (one name can sit in several map folders), in MapFolders order.</summary>
		static readonly Dictionary<string, List<(IReadOnlyPackage Parent, MapClassification Class)>> Pending = [];

		static ModData modData;

		/// <summary>Maps loaded at boot and maps waiting, for the boot's timings.</summary>
		public static int LoadedAtBoot { get; private set; }
		public static int Deferred => Pending.Values.Sum(l => l.Count);

		/// <summary>MapCache.LoadMaps without its loop over every map: its set-up, then only the setup screen's maps.</summary>
		[DynamicDependency(DynamicallyAccessedMemberTypes.NonPublicFields | DynamicallyAccessedMemberTypes.NonPublicMethods |
			DynamicallyAccessedMemberTypes.PublicProperties | DynamicallyAccessedMemberTypes.NonPublicProperties, typeof(MapCache))]
		public static void Load(ModData data)
		{
			modData = data;
			Pending.Clear();
			LoadedAtBoot = 0;
			var cache = data.MapCache;
			var manifest = data.Manifest;
			if (manifest.MapFolders.Count == 0)
				return;

			// The cache's own state, as LoadMaps creates it (MapCache keeps both private).
			var gridType = data.GetOrCreate<MapGrid>().Type;
			var type = typeof(MapCache);
			const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
			(type.GetField("previews", Private) ?? throw new MissingFieldException(nameof(MapCache), "previews"))
				.SetValue(cache, new Cache<string, MapPreview>(uid => new MapPreview(data, uid, gridType, cache)));
			var locations = (Dictionary<IReadOnlyPackage, MapClassification>)(type.GetField("mapLocations", Private)
				?? throw new MissingFieldException(nameof(MapCache), "mapLocations")).GetValue(cache);

			foreach (var kv in manifest.MapFolders)
			{
				var name = kv.Key;
				var classification = string.IsNullOrEmpty(kv.Value) ? MapClassification.Unknown : Enum.Parse<MapClassification>(kv.Value);
				var optional = name.StartsWith('~');
				if (optional)
					name = name[1..];

				IReadOnlyPackage package;
				try
				{
					// As LoadMaps: a folder inside the support directory may need creating first.
					var resolved = Platform.ResolvePath(name);
					if (resolved.StartsWith(Platform.SupportDir, StringComparison.Ordinal) && !File.Exists(resolved))
						Directory.CreateDirectory(resolved);

					package = data.ModFiles.OpenPackage(name);
				}
				catch
				{
					if (optional)
						continue;

					throw;
				}

				locations.Add(package, classification);
			}

			var t0 = Stopwatch.GetTimestamp();
			var atBoot = new List<(IReadOnlyPackage Parent, string Map, MapClassification Class)>();
			var customRules = false;
			foreach (var (package, classification) in locations)
			{
				foreach (var map in package.Contents)
				{
					var (inSetup, rules) = Scan(package, map);
					if (inSetup)
					{
						atBoot.Add((package, map, classification));
						customRules |= rules;
					}
					else
					{
						if (!Pending.TryGetValue(map, out var list))
							Pending[map] = list = [];

						list.Add((package, classification));
					}
				}
			}

			SimHost.Timings["boot.maps.scan"] = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;

			// The setup screen's maps, as LoadMaps loads them: the mod's rules YAML read once for every map with custom rules
			// (MapCache's own LoadMapInternal; the public LoadMap would read them again for each such map).
			t0 = Stopwatch.GetTimestamp();
			var loadInternal = type.GetMethod("LoadMapInternal", Private);
			var modDataRules = customRules && loadInternal != null ? data.GetRulesYaml() : null;
			foreach (var (parent, map, classification) in atBoot)
			{
				if (loadInternal != null)
					loadInternal.Invoke(cache, [map, parent, classification, null, gridType, modDataRules]);
				else
					cache.LoadMap(map, parent, classification, null);

				LoadedAtBoot++;
			}

			SimHost.Timings["boot.maps.load"] = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
			// As LoadMaps: no map counts as modified by the boot itself.
			type.GetProperty(nameof(MapCache.LastModifiedMap))?.SetValue(cache, null);
		}

		/// <summary>
		/// From the map.yaml's top-level keys: whether the setup screen may list the map (Visibility includes Lobby, the
		/// default) and whether it has custom rules.
		/// </summary>
		static (bool InSetup, bool Rules) Scan(IReadOnlyPackage parent, string map)
		{
			try
			{
				using var package = parent.OpenPackage(map, modData.ModFiles);
				if (package == null)
					return (false, false);

				using var stream = package.GetStream("map.yaml");
				if (stream == null)
					return (true, false); // LoadMap reports it, as before

				var inSetup = true;
				var rules = false;
				using var reader = new StreamReader(stream);
				for (var line = reader.ReadLine(); line != null; line = reader.ReadLine())
				{
					if (line.StartsWith("Visibility:", StringComparison.Ordinal))
						inSetup = FieldLoader.GetValue<MapVisibility>("Visibility", line["Visibility:".Length..].Trim()).HasFlag(MapVisibility.Lobby);
					else if (line.StartsWith("Rules:", StringComparison.Ordinal))
						rules = true;
				}

				return (inSetup, rules);
			}
			catch (Exception e) when (e is IOException || e is InvalidDataException || e is YamlException)
			{
				return (true, true); // LoadMap decides, as LoadMaps did
			}
		}

		/// <summary>Loads the maps with this folder name into the MapCache if they are still waiting.</summary>
		public static void Ensure(string mapName)
		{
			if (modData == null || mapName == null || !Pending.Remove(mapName, out var list))
				return;

			foreach (var (parent, classification) in list)
				modData.MapCache.LoadMap(mapName, parent, classification, null);

			typeof(MapCache).GetProperty(nameof(MapCache.LastModifiedMap))?.SetValue(modData.MapCache, null);
		}

		/// <summary>Every waiting map: the MapCache as LoadMaps leaves it.</summary>
		public static void EnsureAll()
		{
			foreach (var name in Pending.Keys.ToList())
				Ensure(name);
		}

		/// <summary>A file of a map package by folder name (map.png for the setup screens), loaded or not; null if absent.</summary>
		public static byte[] ReadFile(string mapName, string file)
		{
			var preview = modData.MapCache.FirstOrDefault(p => Path.GetFileName(p.Path) == mapName);
			if (preview != null)
			{
				if (!((IReadOnlyFileSystem)preview).TryOpen(file, out var s))
					return null;

				using (s)
					return ReadAll(s);
			}

			if (!Pending.TryGetValue(mapName, out var list))
				return null;

			foreach (var (parent, _) in list)
			{
				using var package = parent.OpenPackage(mapName, modData.ModFiles);
				using var s = package?.GetStream(file);
				if (s != null)
					return ReadAll(s);

				// The first folder holding the map decides, as MapCache.FirstOrDefault did.
				if (package != null)
					return null;
			}

			return null;
		}

		static byte[] ReadAll(Stream s)
		{
			using var ms = new MemoryStream();
			s.CopyTo(ms);
			return ms.ToArray();
		}
	}
}
