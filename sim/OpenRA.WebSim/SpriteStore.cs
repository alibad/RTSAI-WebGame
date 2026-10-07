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
using System.IO;
using System.Linq;
using System.Numerics;
using OpenRA.Graphics;
using OpenRA.Primitives;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Prebaked sprite sheets for the browser: after a map's sprites are packed, the sprite table (which sheet and
	/// rectangle every reserved frame landed in) goes to the page's cache with the sheets' pixels; next time the
	/// same reservation set loads, the table is restored and the pixels go straight from the cache to the GPU, so
	/// no sprite file is decoded or packed (no decode-time memory peak). Render-side only.
	/// </summary>
	public sealed class SpriteStore : ISpriteCacheStore
	{
		/// <summary>The cached table for a reservation key, or null/empty.</summary>
		public static Func<string, byte[]> Load;

		/// <summary>A fresh packing: key, table, and each sheet's texture id (in table order).</summary>
		public static Action<string, byte[], int[]> Saved;

		/// <summary>A restored packing: the texture ids (table order) whose pixels the page must take from its cache.</summary>
		public static Action<string, int[]> Restored;

		static readonly byte[] Magic = "ORASPR01"u8.ToArray();

		public IReadOnlyDictionary<int, Sprite[]> TryRestore(SpriteCache cache, string key)
		{
			var table = Load?.Invoke(key);
			if (table == null || table.Length < Magic.Length || !table.AsSpan(0, Magic.Length).SequenceEqual(Magic))
				return null;

			using var r = new BinaryReader(new MemoryStream(table));
			r.ReadBytes(Magic.Length);
			var sheetCount = r.ReadInt32();
			var sheets = new Sheet[sheetCount];
			var ids = new int[sheetCount];
			for (var i = 0; i < sheetCount; i++)
			{
				var type = (SheetType)r.ReadByte();
				var w = r.ReadInt32();
				var h = r.ReadInt32();
				var texture = (WebTexture)Game.Renderer.Context.CreateTexture();
				texture.SetData(null, w, h);
				texture.MarkExternal();
				Snapshot.TextureStreamed(texture);
				sheets[i] = new Sheet(type, texture);
				ids[i] = texture.Id;
			}

			var result = new Dictionary<int, Sprite[]>();
			var tokens = r.ReadInt32();
			for (var t = 0; t < tokens; t++)
			{
				var token = r.ReadInt32();
				var count = r.ReadInt32();
				if (count < 0)
				{
					result[token] = null;
					continue;
				}

				var sprites = new Sprite[count];
				for (var i = 0; i < count; i++)
				{
					var kind = r.ReadByte();
					if (kind == 0)
						continue;

					var sheet = sheets[r.ReadInt32()];
					var bounds = new Rectangle(r.ReadInt32(), r.ReadInt32(), r.ReadInt32(), r.ReadInt32());
					var zRamp = r.ReadSingle();
					var offset = new Vector3(r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
					var channel = (TextureChannel)r.ReadByte();
					var blend = (BlendMode)r.ReadByte();
					var scale = r.ReadSingle();
					var sprite = new Sprite(sheet, bounds, zRamp, offset, channel, blend, scale);
					if (kind == 2)
					{
						var secondary = sheets[r.ReadInt32()];
						var sb = new Rectangle(r.ReadInt32(), r.ReadInt32(), r.ReadInt32(), r.ReadInt32());
						sprite = new SpriteWithSecondaryData(sprite, secondary, sb, (TextureChannel)r.ReadByte());
					}

					sprites[i] = sprite;
				}

				result[token] = sprites;
			}

			Restored?.Invoke(key, ids);
			return result;
		}

		/// <summary>Each saved sheet's group (SpriteCache.PackGroup of its sprites' files; "" for shared), in table order.</summary>
		public static string[] LastSheetGroups = [];

		/// <summary>The file of every packed token, from the last save (for reports).</summary>
		public static IReadOnlyDictionary<int, string> LastFiles;

		/// <summary>The sprites of every packed token, from the last save (for reports).</summary>
		public static IReadOnlyDictionary<int, Sprite[]> LastTokens;

		public void Save(SpriteCache cache, string key, IReadOnlyDictionary<int, Sprite[]> sprites, IReadOnlyDictionary<int, string> files)
		{
			LastFiles = files;
			LastTokens = sprites;
			if (Saved == null)
				return;

			var sheetIndex = new Dictionary<Sheet, int>();
			var sheetList = new List<Sheet>();
			int Index(Sheet s)
			{
				if (!sheetIndex.TryGetValue(s, out var i))
				{
					i = sheetList.Count;
					sheetList.Add(s);
					sheetIndex[s] = i;
				}

				return i;
			}

			// Sprites can only be baked if their sheets went to the page (streamed); otherwise skip baking.
			foreach (var s in sprites.Values.Where(v => v != null).SelectMany(v => v).Where(s => s != null))
			{
				Index(s.Sheet);
				if (s is SpriteWithSecondaryData ss)
					Index(ss.SecondarySheet);
			}

			var body = new MemoryStream();
			using (var w = new BinaryWriter(body, System.Text.Encoding.UTF8, true))
			{
				w.Write(Magic);
				w.Write(sheetList.Count);
				foreach (var s in sheetList)
				{
					w.Write((byte)s.Type);
					w.Write(s.Size.Width);
					w.Write(s.Size.Height);
				}

				w.Write(sprites.Count);
				foreach (var (token, list) in sprites)
				{
					w.Write(token);
					if (list == null)
					{
						w.Write(-1);
						continue;
					}

					w.Write(list.Length);
					foreach (var s in list)
					{
						if (s == null)
						{
							w.Write((byte)0);
							continue;
						}

						var ss = s as SpriteWithSecondaryData;
						w.Write((byte)(ss != null ? 2 : 1));
						w.Write(sheetIndex[s.Sheet]);
						w.Write(s.Bounds.X);
						w.Write(s.Bounds.Y);
						w.Write(s.Bounds.Width);
						w.Write(s.Bounds.Height);
						w.Write(s.ZRamp);
						w.Write(s.Offset.X);
						w.Write(s.Offset.Y);
						w.Write(s.Offset.Z);
						w.Write((byte)s.Channel);
						w.Write((byte)s.BlendMode);
						var scale = s.Bounds.Width != 0 ? s.Size.X / s.Bounds.Width : s.Bounds.Height != 0 ? s.Size.Y / s.Bounds.Height : 1f;
						w.Write(ss != null ? 1f : scale);
						if (ss != null)
						{
							w.Write(sheetIndex[ss.SecondarySheet]);
							w.Write(ss.SecondaryBounds.X);
							w.Write(ss.SecondaryBounds.Y);
							w.Write(ss.SecondaryBounds.Width);
							w.Write(ss.SecondaryBounds.Height);
							w.Write((byte)ss.SecondaryChannel);
						}
					}
				}
			}

			// The group of each sheet (all its sprites share one, as SpriteCache packs groups into sheets of their own).
			var groups = new string[sheetList.Count];
			foreach (var (token, list) in sprites)
			{
				if (list == null || !files.TryGetValue(token, out var file))
					continue;

				var group = SpriteCache.PackGroup?.Invoke(file) ?? "";
				foreach (var s in list)
					if (s != null)
						groups[sheetIndex[s.Sheet]] ??= group;
			}

			LastSheetGroups = groups.Select(g => g ?? "").ToArray();

			// Every sheet must be committed (sent to the page) before its pixels can be stored.
			var ids = sheetList.Select(s => ((WebTexture)s.GetTexture()).Id).ToArray();
			Saved(key, body.ToArray(), ids);
		}
	}
}
