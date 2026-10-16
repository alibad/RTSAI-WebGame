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
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using OpenRA.FileSystem;
using OpenRA.Graphics;
using OpenRA.Mods.Common.EditorBrushes;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Widgets;
using OpenRA.Primitives;
using OpenRA.Support;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// The browser's map editor, run by the desktop map editor itself: the engine's editor world (SimHost.StartEditor),
	/// a headless EditorViewportControllerWidget, and the editor's own brushes (tiles, actors, ore, selection), actions
	/// (undo and redo) and save path. The page sends pointer input in world pixels; edits change the map exactly as the
	/// desktop editor does, so a map saved here opens in it unchanged.
	/// </summary>
	public static class EditorHost
	{
		/// <summary>Where maps made or opened by the editor live (SimHost.MapPath looks here before the map cache).</summary>
		const string MapsDir = "mods/rtsai/web/content/maps";

		static EditorViewportControllerWidget controller;
		static int dirtyMin = int.MaxValue, dirtyMax = -1;
		static string brushName = "select";
		static readonly HashSet<CPos> resourceStroke = [];
		static string resourceBlocked;
		static int2? resourcePrevious;

		public static bool Active => controller != null && SimHost.World?.Type == WorldType.Editor;

		/// <summary>{"map": id} opens a map; {"new": {"width", "height", "title"}} makes a blank one first. Returns the map id.</summary>
		public static string Open(string json)
		{
			using var doc = JsonDocument.Parse(json);
			var r = doc.RootElement;
			var id = r.TryGetProperty("new", out var blank)
				? NewMap(Int(blank, "width", 64), Int(blank, "height", 64), Str(blank, "title") ?? "New map")
				: Str(r, "map") ?? throw new InvalidDataException("No map to open.");

			controller = null;
			SimHost.StartEditor(id);
			// The controller unlocks the editor's extra zoom-out, which recomputes the viewport's zoom from the window: the
			// engine has no real window here, so that zoom is restored. The page draws with its own camera; the engine's
			// viewport only converts the page's world pixels for the brushes.
			var viewport = SimHost.WorldRenderer.Viewport;
			var zoom = viewport.Zoom;
			controller = new EditorViewportControllerWidget(SimHost.WorldRenderer);
			if (!(viewport.Zoom > 0.01f) || float.IsInfinity(viewport.Zoom))
				typeof(Viewport).GetField("zoom", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)?.SetValue(viewport, zoom > 0.01f ? zoom : 1f);
			brushName = "select";
			EditorWaterBrush.Reset();
			var map = SimHost.World.Map;
			map.Tiles.CellEntryChanged += Dirty;
			map.Height.CellEntryChanged += Dirty;
			map.Ramp.CellEntryChanged += Dirty;
			dirtyMin = int.MaxValue;
			dirtyMax = -1;
			return id;
		}

		public static void Close()
		{
			controller = null;
		}

		/// <summary>Drops everything that points into the editor's world (SimHost.EndGame), so it can be collected.</summary>
		public static void Forget()
		{
			controller = null;
			brushName = "select";
			dirtyMin = int.MaxValue;
			dirtyMax = -1;
			EditorWaterBrush.Reset();
		}

		static void Dirty(CPos cell)
		{
			var v = cell.ToMPos(SimHost.World.Map).V;
			dirtyMin = Math.Min(dirtyMin, v);
			dirtyMax = Math.Max(dirtyMax, v);
		}

		/// <summary>
		/// The terrain layer's vertices for the map rows changed since the last call (a cliff or ramp also redraws the
		/// rows next to it), as [first row (int32)][vertices]; empty when nothing changed.
		/// </summary>
		public static byte[] TerrainChanges()
		{
			if (!Active || dirtyMax < 0)
				return [];

			var map = SimHost.World.Map;
			var vertices = TerrainVertices();
			var first = Math.Max(0, dirtyMin - 2);
			var last = Math.Min(map.MapSize.Height - 1, dirtyMax + 2);
			dirtyMin = int.MaxValue;
			dirtyMax = -1;
			if (vertices == null)
				return [];

			var rowStride = 4 * map.MapSize.Width;
			var span = MemoryMarshal.AsBytes(vertices.AsSpan(first * rowStride, Math.Min(vertices.Length - first * rowStride, (last - first + 1) * rowStride)));
			var result = new byte[4 + span.Length];
			BitConverter.TryWriteBytes(result.AsSpan(0, 4), first);
			span.CopyTo(result.AsSpan(4));
			return result;
		}

		static Vertex[] TerrainVertices()
		{
			var terrain = SimHost.World.WorldActor.TraitsImplementing<IRenderTerrain>().FirstOrDefault();
			var layer = terrain?.GetType().GetField("spriteLayer", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)?.GetValue(terrain) as TerrainSpriteLayer;
			return layer == null ? null
				: (Vertex[])typeof(TerrainSpriteLayer).GetField("vertices", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).GetValue(layer);
		}

		/// <summary>A blank map in the editor's maps folder, like the desktop editor's New map (NewMapLogic).</summary>
		static string NewMap(int width, int height, string title)
		{
			var modData = SimHost.ModData;
			width = Math.Clamp(width, 16, 256);
			height = Math.Clamp(height, 16, 256);
			var terrain = modData.DefaultTerrainInfo["TEMPERATE"];
			var grid = modData.GetOrCreate<MapGrid>();
			var maxHeight = grid.MaximumTerrainHeight;
			var map = new Map(modData, terrain, new Size(width + 2, height + maxHeight + 2));
			map.SetBounds(new PPos(1, 1 + maxHeight), new PPos(width, height + maxHeight));
			map.PlayerDefinitions = new MapPlayers(map.Rules, 0).ToMiniYaml();
			if (map.Rules.TerrainInfo is ITerrainInfoNotifyMapCreated notify)
				notify.MapCreated(map);
			map.Title = title;
			map.Author = "RTS AI map editor";
			map.RequiresMod = modData.Manifest.Id;
			var id = "new-" + Guid.NewGuid().ToString("N")[..12];
			var dir = Path.Combine(SimHost.Root, MapsDir, id);
			Directory.CreateDirectory(dir);
			map.Save(new Folder(dir));
			return id;
		}

		/// <summary>One editor request (JSON {"op": ...}); returns a JSON reply.</summary>
		public static string Call(string json)
		{
			if (!Active)
				return "{\"error\":\"The editor is not open.\"}";

			var world = SimHost.World;
			using var doc = JsonDocument.Parse(json);
			var r = doc.RootElement;
			return Sync.RunUnsynced(world, () =>
			{
				switch (Str(r, "op"))
				{
					case "catalog": return Catalog(world);
					case "brush": return SetBrush(world, r);
					case "pointer": return Pointer(r);
					case "undo": world.WorldActor.Trait<EditorActionManager>().Undo(); return History(world);
					case "redo": world.WorldActor.Trait<EditorActionManager>().Redo(); return History(world);
					case "history": return History(world);
					case "delete":
					{
						if (controller.CurrentBrush is EditorDefaultBrush brush && brush.Selection.HasSelection)
							brush.DeleteSelection(MapBlitFilters.All);
						return History(world);
					}

					case "save": return Save(world, r);
					default: return "{\"error\":\"unknown op\"}";
				}
			});
		}

		static string History(World world, string placement = null)
		{
			var actions = world.WorldActor.Trait<EditorActionManager>();
			var error = EditorWaterBrush.LastError;
			EditorWaterBrush.LastError = null;
			return $"{{\"undo\":{(actions.HasUndos() ? "true" : "false")},\"redo\":{(actions.HasRedos() ? "true" : "false")},\"brush\":{Snapshot.Json(brushName)}"
				+ (placement != null ? $",\"placement\":{placement}" : "")
				+ (error != null ? $",\"error\":{Snapshot.Json(error)}" : "") + "}";
		}

		/// <summary>
		/// The desktop editor's own brushes: "tile" (a terrain template), "actor" (any editor actor for an owner),
		/// "resource" (ore or gems), "select" (pick, drag, area-select, delete); and "water" (EditorWaterBrush: lakes and rivers
		/// with shores, as the random map generator paints coasts).
		/// </summary>
		static string SetBrush(World world, JsonElement r)
		{
			resourceStroke.Clear(); resourceBlocked = null; resourcePrevious = null;
			var wr = SimHost.WorldRenderer;
			var kind = Str(r, "brush") ?? "select";
			switch (kind)
			{
				case "tile":
					controller.SetBrush(new EditorTileBrush(controller, (ushort)Int(r, "id", 0), wr));
					brushName = $"tile:{Int(r, "id", 0)}";
					break;

				case "actor":
				{
					var type = Str(r, "type");
					if (type == null || !world.Map.Rules.Actors.TryGetValue(type, out var info))
						return "{\"error\":\"unknown actor\"}";
					var players = world.WorldActor.Trait<EditorActorLayer>().Players.Players;
					var owner = players.TryGetValue(Str(r, "owner") ?? "Neutral", out var o) ? o : players.Values.First();
					controller.SetBrush(new EditorActorBrush(controller, info, owner, wr));
					brushName = $"actor:{type}";
					break;
				}

				case "water":
					if (!EditorWaterBrush.Supported(world.Map))
						return "{\"error\":\"This map's terrain has no shore pieces.\"}";
					controller.SetBrush(new EditorWaterBrush(controller, wr, Int(r, "radius", 3)));
					brushName = $"water:{Int(r, "radius", 3)}";
					break;

				case "resource":
					controller.SetBrush(new EditorResourceBrush(controller, Str(r, "type") ?? "Ore", wr));
					brushName = $"resource:{Str(r, "type") ?? "Ore"}";
					break;

				default:
					controller.ClearBrush();
					brushName = "select";
					break;
			}

			return History(world);
		}

		/// <summary>Mouse input at a world pixel ("down", "up", "move"; button 1 left, 2 right; engine Modifiers).</summary>
		static string Pointer(JsonElement r)
		{
			var wr = SimHost.WorldRenderer;
			var point = new int2(Int(r, "x", 0), Int(r, "y", 0));
			var view = wr.Viewport.WorldToViewPx(point);
			Viewport.LastMousePos = view;
			var ev = Str(r, "event") switch { "down" => MouseInputEvent.Down, "up" => MouseInputEvent.Up, _ => MouseInputEvent.Move };
			var button = (MouseButton)Int(r, "button", 0);
			var mi = new MouseInput(ev, button, view, int2.Zero, (Modifiers)Int(r, "mods", 0), 1);
			var resource = controller.CurrentBrush as EditorResourceBrush;
			var layer = resource != null ? SimHost.World.WorldActor.Trait<IResourceLayer>() : null;
			var map = SimHost.World.Map;
			void Apply(MouseInput input)
			{
				var c = wr.Viewport.ViewToWorld(input.Location);
				var before = map.Resources.Contains(c) ? map.Resources[c] : default;
				controller.HandleMouseInput(input);
				var after = map.Resources.Contains(c) ? map.Resources[c] : default;
				if (before.Type != after.Type || before.Index != after.Index) resourceStroke.Add(c);
				else resourceBlocked = !map.Contains(c) ? "Paint inside the battlefield."
					: map.Ramp[c] != 0 ? "This is a slope. Choose flat ground for resources."
					: layer.GetResource(c).Type == resource.ResourceType && before.Index >= layer.GetMaxDensity(resource.ResourceType) ? "This tile already has a full resource deposit."
					: "This ground cannot hold resources. Choose flat, open ground.";
			}
			if (resource != null && button == MouseButton.Left && ev == MouseInputEvent.Down)
			{
				resourceStroke.Clear(); resourceBlocked = null;
				resourcePrevious = point;
			}
			if (resource != null && button == MouseButton.Left && ev != MouseInputEvent.Up)
			{
				// Browser moves may be coalesced. Sample the segment so a quick drag paints a continuous field.
				var start = resourcePrevious ?? point;
				var size = map.Rules.TerrainInfo.TileSize;
				var steps = Math.Clamp((int)Math.Ceiling(Math.Max(Math.Abs(point.X - start.X) / (size.Width / 4.0), Math.Abs(point.Y - start.Y) / (size.Height / 4.0))), 1, 1024);
				for (var i = 1; i <= steps; i++)
				{
					var sample = new int2(start.X + (point.X - start.X) * i / steps, start.Y + (point.Y - start.Y) * i / steps);
					Apply(new MouseInput(ev, button, wr.Viewport.WorldToViewPx(sample), int2.Zero, mi.Modifiers, 1));
				}
				resourcePrevious = point;
			}
			else controller.HandleMouseInput(mi);
			controller.Tick();
			if (controller.CurrentBrush == controller.DefaultBrush) brushName = "select";
			string placement = null;
			if (resource != null && button == MouseButton.Left)
			{
				if (ev == MouseInputEvent.Up)
				{
					placement = $"{{\"added\":{resourceStroke.Count},\"blocked\":{Snapshot.Json(resourceBlocked)}}}";
					resourcePrevious = null;
				}
			}
			return History(SimHost.World, placement);
		}

		// ---------------------------------------------------------------- catalog

		/// <summary>
		/// What the editor can place: the tileset's templates by category (each tile's sprite, for thumbnails), the
		/// editor's actors by category (ActorSelectorLogic's rules), resource types and the map's owners.
		/// </summary>
		static string Catalog(World world)
		{
			var map = world.Map;
			var wr = SimHost.WorldRenderer;
			var terrainInfo = (DefaultTerrain)map.Rules.TerrainInfo;
			var tiles = world.WorldActor.TraitsImplementing<ITiledTerrainRenderer>().First();
			var ts = map.Rules.TerrainInfo.TileSize;
			var inv = CultureInfo.InvariantCulture;
			var sb = new StringBuilder("{\"categories\":[");
			var order = terrainInfo.EditorTemplateOrder;
			sb.Append(string.Join(",", order.Select(Snapshot.Json)));
			sb.Append("],\"templates\":[");
			var firstTemplate = true;
			foreach (var t in terrainInfo.Templates.Values.OfType<DefaultTerrainTemplateInfo>())
			{
				if (!firstTemplate)
					sb.Append(',');
				firstTemplate = false;
				var palette = wr.Palette(t.Palette ?? terrainInfo.Palette).TextureIndex;
				sb.Append($"{{\"id\":{t.Id},\"size\":[{t.Size.X},{t.Size.Y}],\"categories\":[{string.Join(",", t.Categories.Select(Snapshot.Json))}],\"tiles\":[");
				var i = 0;
				var firstTile = true;
				for (var y = 0; y < t.Size.Y; y++)
					for (var x = 0; x < t.Size.X; x++)
					{
						var tile = new TerrainTile(t.Id, (byte)i++);
						if (!terrainInfo.TryGetTileInfo(tile, out var tileInfo))
							continue;
						var sprite = tiles.TileSprite(tile, 0);
						var u = map.Grid.Type == MapGridType.Rectangular ? x : (x - y) / 2f;
						var v = map.Grid.Type == MapGridType.Rectangular ? y : (x + y) / 2f;
						var px = u * ts.Width - 0.5f * sprite.Size.X + sprite.Offset.X;
						var py = (v - 0.5f * tileInfo.Height) * ts.Height - 0.5f * sprite.Size.Y + sprite.Offset.Y;
						var tex = Snapshot.TextureId(sprite.Sheet);
						Snapshot.MarkTexture(tex);
						if (!firstTile)
							sb.Append(',');
						firstTile = false;
						sb.Append($"{{\"x\":{px.ToString("0.#", inv)},\"y\":{py.ToString("0.#", inv)},\"tex\":{tex},\"channel\":{(int)sprite.Channel},");
						sb.Append($"\"uv\":[{sprite.Left.ToString(inv)},{sprite.Top.ToString(inv)},{sprite.Right.ToString(inv)},{sprite.Bottom.ToString(inv)}],\"w\":{sprite.Bounds.Width},\"h\":{sprite.Bounds.Height},\"pal\":{palette}}}");
					}

				sb.Append("]}");
			}

			sb.Append("],\"actors\":[");
			var firstActor = true;
			foreach (var a in map.Rules.Actors.Values.OrderBy(a => a.Name))
			{
				if (a.Name.Contains('^') || !a.HasTraitInfo<IRenderActorPreviewInfo>())
					continue;
				var editorData = a.TraitInfoOrDefault<MapEditorDataInfo>();
				if (editorData?.Categories == null)
					continue;
				if (editorData.ExcludeTilesets != null && editorData.ExcludeTilesets.Contains(map.Tileset))
					continue;
				if (editorData.RequireTilesets != null && !editorData.RequireTilesets.Contains(map.Tileset))
					continue;
				var tooltip = a.TraitInfos<EditorOnlyTooltipInfo>().FirstOrDefault(t => t.EnabledByDefault) as TooltipInfoBase
					?? a.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
				if (!firstActor)
					sb.Append(',');
				firstActor = false;
				sb.Append($"{{\"name\":{Snapshot.Json(a.Name)},\"label\":{Snapshot.Json(tooltip != null ? FluentProvider.GetMessage(tooltip.Name) : a.Name)},\"categories\":[{string.Join(",", editorData.Categories.Select(Snapshot.Json))}]}}");
			}

			sb.Append("],\"resources\":[");
			var resources = world.WorldActor.Info.TraitInfoOrDefault<EditorResourceLayerInfo>()?.ResourceTypes.Keys
				?? world.WorldActor.Info.TraitInfoOrDefault<ResourceLayerInfo>()?.ResourceTypes.Keys ?? Enumerable.Empty<string>();
			sb.Append(string.Join(",", resources.Select(Snapshot.Json)));
			sb.Append("],\"owners\":[");
			var players = world.WorldActor.Trait<EditorActorLayer>().Players.Players.Values;
			sb.Append(string.Join(",", players.Select(p => $"{{\"name\":{Snapshot.Json(p.Name)},\"color\":\"{p.Color.R:X2}{p.Color.G:X2}{p.Color.B:X2}\",\"playable\":{(p.Playable ? "true" : "false")}}}")));
			sb.Append($"],\"zoom\":{SimHost.WorldRenderer.Viewport.Zoom.ToString(inv)},\"title\":{Snapshot.Json(map.Title)},\"author\":{Snapshot.Json(map.Author)},\"size\":[{map.Bounds.Width},{map.Bounds.Height}]}}");
			return sb.ToString();
		}

		// ---------------------------------------------------------------- save

		/// <summary>
		/// Saves the map the desktop editor's way (SaveMapLogic): players and actors from the editor's actor layer, its
		/// title and author; returns the files (base64) for the page to keep and mount, and the map's id in the library.
		/// The preview's colours are seeded so the same map always gets the same uid.
		/// </summary>
		static string Save(World world, JsonElement r)
		{
			var map = world.Map;
			var layer = world.WorldActor.Trait<EditorActorLayer>();
			map.Title = Str(r, "title") ?? map.Title;
			map.Author = Str(r, "author") ?? map.Author;
			map.PlayerDefinitions = layer.Players.ToMiniYaml();
			map.ActorDefinitions = layer.Save();
			map.RequiresMod = SimHost.ModData.Manifest.Id;
			if (!map.Visibility.HasFlag(MapVisibility.Lobby))
				map.Visibility |= MapVisibility.Lobby;

			// Not disposed: Map.Save makes it the map's package, which the next save reads from (an in-memory zip).
			var package = new ZipFileLoader.ReadWriteZipFile();
			var cosmetic = Game.CosmeticRandom;
			Game.CosmeticRandom = new MersenneTwister(map.Title.GetHashCode(StringComparison.Ordinal) & 0x7FFFFFFF);
			try
			{
				map.Save(package);
			}
			finally
			{
				Game.CosmeticRandom = cosmetic;
			}

			world.WorldActor.Trait<EditorActionManager>().Modified = false;
			var id = "map-" + map.Uid[..16].ToLowerInvariant();
			var files = new StringBuilder();
			foreach (var name in package.Contents)
			{
				using var s = package.GetStream(name);
				files.Append(files.Length == 0 ? "" : ",").Append(Snapshot.Json(name)).Append(':').Append(Snapshot.Json(Convert.ToBase64String(s.ReadAllBytes())));
			}

			var spawns = layer.Players.Players.Values.Count(p => p.Playable);
			return $"{{\"id\":{Snapshot.Json(id)},\"uid\":{Snapshot.Json(map.Uid)},\"title\":{Snapshot.Json(map.Title)},\"players\":{spawns},\"files\":{{{files}}}}}";
		}

		static string Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
		static int Int(JsonElement e, string name, int def) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;
	}
}
