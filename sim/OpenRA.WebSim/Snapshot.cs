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
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Encodes one tick of the world for the page: actor state (for selection, health bars, interpolation) and the
	/// exact sprites the engine would draw (via each actor's and effect's IRender output), plus incremental tables
	/// of new sprites, strings and changed textures. Little-endian, 4-byte aligned. See web/src/protocol.ts.
	/// </summary>
	public static class Snapshot
	{
		public const uint Magic = 0x314E5357; // "WSN1"
		public const uint ResyncMagic = 0x31525357; // "WSR1": sprite/string tables restart at id 0
		public const int HeaderBytes = 80;
		public const int PlayerBytes = 16;
		public const int SpriteBytes = 60;
		public const int TextureBytes = 20;
		public const int ActorBytes = 52;
		public const int DrawBytes = 48;

		static byte[] buffer = new byte[1 << 20];
		static int pos;

		static readonly Dictionary<Sprite, int> SpriteIds = new(ReferenceEqualityComparer.Instance);
		static readonly List<Sprite> Sprites = [];
		static int spritesSent;

		static readonly Dictionary<string, int> StringIds = [];
		static readonly List<string> Strings = [];
		static int stringsSent;

		static readonly Dictionary<int, int> TextureVersionsSent = [];
		static readonly HashSet<int> TexturesOfInterest = [];
		static byte[] lastPalette;

		static readonly List<(IRenderable R, uint Key)> Renderables = [];
		static readonly List<IRenderable> Others = [];
		static readonly Dictionary<int, int> ModelBufferVersionsSent = [];
		static readonly List<int> TextureQueue = [];
		static int paletteTextureId = -1;

		/// <summary>The host streamed this version to the page already (WebTexture.Stream).</summary>
		public static void TextureStreamed(WebTexture t) => TextureVersionsSent[t.Id] = t.Version;

		/// <summary>The page now has this texture's current version: drop our copy where safe (never the palette).</summary>
		public static void TextureSent(int id)
		{
			if (id != paletteTextureId && id >= 0 && id < WebTexture.All.Count)
				WebTexture.All[id].Sent();
		}
		static long[] sortKeys = new long[1024];
		static readonly List<Actor> ViewActors = [];

		/// <summary>Visible region in world pixels (top-left, bottom-right). Defaults to the whole map.</summary>
		public static int2 ViewTopLeft, ViewBottomRight;
		static bool viewSet;

		public static int UnsupportedRenderables { get; private set; }
		public static double LastBuildMs { get; private set; }
		public static double LastTickMs;

		public static ReadOnlySpan<byte> Bytes => buffer.AsSpan(0, pos);
		public static ArraySegment<byte> Segment => new(buffer, 0, pos);

		public static void Reset()
		{
			SpriteIds.Clear();
			Sprites.Clear();
			spritesSent = 0;
			StringIds.Clear();
			Strings.Clear();
			stringsSent = 0;
			// Textures stay on the page across games (and may have been streamed before this Reset): keep their versions.
			TexturesOfInterest.Clear();
			ModelBufferVersionsSent.Clear();
			Capture.ModelBuffers.Clear();
			lastPalette = null;
			viewSet = false;
		}

		/// <summary>Model vertex buffers the page does not have in their current version (ids).</summary>
		public static List<int> ChangedModelBuffers()
		{
			var ids = new List<int>();
			foreach (var (id, vb) in Capture.ModelBuffers)
				if (!ModelBufferVersionsSent.TryGetValue(id, out var v) || v != vb.Version)
					ids.Add(id);
			return ids;
		}

		public static byte[] ModelBuffer(int id)
		{
			if (!Capture.ModelBuffers.TryGetValue(id, out var vb))
				return [];
			ModelBufferVersionsSent[id] = vb.Version;
			return vb.Bytes();
		}

		/// <summary>The page lost snapshots (e.g. a hidden tab): resend the sprite/string tables from id 0 in the next one.</summary>
		public static void Resync()
		{
			spritesSent = 0;
			stringsSent = 0;
			resync = true;
		}

		static bool resync;

		public static void SetView(int x0, int y0, int x1, int y1)
		{
			ViewTopLeft = new int2(x0, y0);
			ViewBottomRight = new int2(x1, y1);
			viewSet = true;
		}

		public static int StringId(string s)
		{
			if (s == null)
				return -1;

			if (!StringIds.TryGetValue(s, out var id))
			{
				id = Strings.Count;
				Strings.Add(s);
				StringIds.Add(s, id);
			}

			return id;
		}

		public static int SpriteId(Sprite s)
		{
			if (!SpriteIds.TryGetValue(s, out var id))
			{
				id = Sprites.Count;
				Sprites.Add(s);
				SpriteIds.Add(s, id);
				TexturesOfInterest.Add(TextureId(s.Sheet));
				if (s is SpriteWithSecondaryData ss)
					TexturesOfInterest.Add(TextureId(ss.SecondarySheet));
			}

			return id;
		}

		public static int TextureId(Sheet sheet) => sheet == null ? -1 : ((WebTexture)sheet.GetTexture()).Id;

		public static void MarkTexture(int id)
		{
			if (id >= 0)
				TexturesOfInterest.Add(id);
		}

		// ---------------------------------------------------------------- primitive writers

		static void Ensure(int bytes)
		{
			if (pos + bytes <= buffer.Length)
				return;

			var size = buffer.Length;
			while (size < pos + bytes)
				size *= 2;

			Array.Resize(ref buffer, size);
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void I32(int v)
		{
			BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(pos), v);
			pos += 4;
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void U32(uint v)
		{
			BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(pos), v);
			pos += 4;
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void F32(float v)
		{
			BinaryPrimitives.WriteSingleLittleEndian(buffer.AsSpan(pos), v);
			pos += 4;
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void U16(int v)
		{
			BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(pos), (ushort)v);
			pos += 2;
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void I16(int v)
		{
			BinaryPrimitives.WriteInt16LittleEndian(buffer.AsSpan(pos), (short)Math.Clamp(v, short.MinValue, short.MaxValue));
			pos += 2;
		}

		[MethodImpl(MethodImplOptions.AggressiveInlining)]
		static void U8(int v)
		{
			buffer[pos++] = (byte)v;
		}

		static void Pad4()
		{
			while ((pos & 3) != 0)
				buffer[pos++] = 0;
		}

		// ---------------------------------------------------------------- build

		static uint EffectKey(object effect) => 0x80000000u | (uint)RuntimeHelpers.GetHashCode(effect) & 0x7FFFFFFFu;

		static readonly System.Reflection.FieldInfo InfantryAnimationField =
			typeof(OpenRA.Mods.Common.Traits.Render.WithInfantryBody).GetField("DefaultAnimation",
				System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

		static Animation BodyAnimation(Actor a)
		{
			foreach (var body in a.TraitsImplementing<OpenRA.Mods.Common.Traits.Render.WithSpriteBody>())
				if (body.IsTraitEnabled())
					return body.DefaultAnimation;

			// GIs/desolators have separate conditional bodies for deployed and mobile states.
			var infantry = a.TraitsImplementing<OpenRA.Mods.Common.Traits.Render.WithInfantryBody>().FirstOrDefault(body => body.IsTraitEnabled());
			return infantry != null ? (Animation)InfantryAnimationField.GetValue(infantry) : null;
		}

		public static int Build()
		{
			var start = Stopwatch.GetTimestamp();
			var world = SimHost.World;
			var wr = SimHost.WorldRenderer;

			// Same palette refresh as WorldRenderer.PrepareRenderables (palette modifiers: water cycling, flashes...).
			wr.RefreshPalette();

			if (!viewSet)
			{
				var map = world.Map;
				var tl = wr.ScreenPxPosition(map.ProjectedTopLeft);
				var br = wr.ScreenPxPosition(map.ProjectedBottomRight);
				ViewTopLeft = tl - new int2(256, 256);
				ViewBottomRight = br + new int2(256, 512);
			}

			// ---- gather renderables exactly like WorldRenderer.GenerateRenderables (actors, world, player, effects)
			ViewActors.Clear();
			ViewActors.AddRange(world.ScreenMap.RenderableActorsInBox(ViewTopLeft, ViewBottomRight));

			Renderables.Clear();
			UnsupportedRenderables = 0;
			foreach (var a in ViewActors)
				foreach (var r in a.Render(wr))
					Renderables.Add((r, a.ActorID));

			foreach (var r in world.WorldActor.Render(wr))
				Renderables.Add((r, 0));

			if (world.RenderPlayer != null)
				foreach (var r in world.RenderPlayer.PlayerActor.Render(wr))
					Renderables.Add((r, 0));

			foreach (var e in world.UnpartitionedEffects)
			{
				var key = EffectKey(e);
				foreach (var r in e.Render(wr))
					Renderables.Add((r, key));
			}

			foreach (var e in world.ScreenMap.RenderableEffectsInBox(ViewTopLeft, ViewBottomRight))
			{
				var key = EffectKey(e);
				foreach (var r in e.Render(wr))
					Renderables.Add((r, key));
			}

			if (world.OrderGenerator != null)
				foreach (var r in world.OrderGenerator.Render(wr, world))
					Renderables.Add((r, 0));

			// Stable sort by the engine's z key (WorldRenderer.RenderableZPositionComparisonKey).
			var worldCount = Renderables.Count;
			if (sortKeys.Length < worldCount)
				sortKeys = new long[Exts.NextPowerOf2(worldCount)];
			for (var i = 0; i < worldCount; i++)
				sortKeys[i] = ((long)WorldRenderer.RenderableZPositionComparisonKey(Renderables[i].R) << 32) + i;
			sortKeys.AsSpan(0, worldCount).Sort(CollectionsMarshal.AsSpan(Renderables).Slice(0, worldCount));

			// Above the shroud, in generation order (WorldRenderer.GenerateOverlayRenderables): IRenderAboveShroud,
			// selected actors' IRenderAboveShroudWhenSelected, IEffectAboveShroud effects, the order generator
			// (building placement footprint and preview).
			foreach (var t in world.ActorsWithTrait<IRenderAboveShroud>())
			{
				if (!t.Actor.IsInWorld || t.Actor.Disposed)
					continue;
				foreach (var r in t.Trait.RenderAboveShroud(t.Actor, wr))
					Renderables.Add((r, t.Actor.ActorID));
			}

			foreach (var a in world.Selection.Actors)
			{
				if (!a.IsInWorld || a.Disposed)
					continue;
				foreach (var t in a.TraitsImplementing<IRenderAboveShroudWhenSelected>())
					foreach (var r in t.RenderAboveShroud(a, wr))
						Renderables.Add((r, a.ActorID));
			}

			foreach (var e in world.Effects)
				if (e is OpenRA.Effects.IEffectAboveShroud ea)
					foreach (var r in ea.RenderAboveShroud(wr))
						Renderables.Add((r, EffectKey(e)));

			if (world.OrderGenerator != null)
				foreach (var r in world.OrderGenerator.RenderAboveShroud(wr, world))
					Renderables.Add((r, 0));

			var n = Renderables.Count;

			// ---- header placeholder
			pos = 0;
			Ensure(HeaderBytes);
			pos = HeaderBytes;

			// Strings and sprites referenced below are registered while writing; their tables are appended afterwards
			// into a second buffer region, so write actors/draws to a scratch list first.
			var players = world.Players;

			// Actors
			var actorStart = pos;
			var actorCount = 0;
			Ensure(ViewActors.Count * ActorBytes);
			var viewer = world.RenderPlayer;
			foreach (var a in ViewActors)
			{
				// Only what the render player can see (actor.Render already hides the rest; the actor list must too).
				if (!a.IsInWorld || a.Disposed || (viewer != null && !a.CanBeViewedByPlayer(viewer)))
					continue;

				var health = a.TraitOrDefault<IHealth>();
				var facing = a.TraitOrDefault<IFacing>();
				var mouse = a.TraitsImplementing<IMouseBounds>().FirstOrDefault();
				var interactable = a.TraitOrDefault<Interactable>();
				var screen = wr.Screen3DPosition(a.CenterPosition);
				var screenPx = wr.ScreenPxPosition(a.CenterPosition);

				var flags = 0;
				if (a.Info.HasTraitInfo<SelectableInfo>() || a.Info.HasTraitInfo<IsometricSelectableInfo>())
					flags |= 1;
				if (world.Selection.Contains(a))
					flags |= 2;
				if (a.IsIdle)
					flags |= 4;
				if (a.Info.HasTraitInfo<BuildingInfo>())
					flags |= 8;
				if (health != null && health.IsDead)
					flags |= 16;
				if (mouse != null)
					flags |= 32;

				var bounds = Rectangle.Empty;
				if (interactable != null)
					bounds = interactable.DecorationBounds(a, wr);
				else if (mouse != null)
					bounds = mouse.MouseoverBounds(a, wr).BoundingRect;

				U32(a.ActorID);
				I32(StringId(a.Info.Name));
				U8(Array.IndexOf(players, a.Owner));
				U8(flags);
				U16(facing?.Facing.Angle ?? 0);
				F32(screen.X);
				F32(screen.Y);
				F32(screen.Z);
				I32(health?.HP ?? 0);
				I32(health?.MaxHP ?? 0);
				I16(bounds.X - screenPx.X);
				I16(bounds.Y - screenPx.Y);
				I16(bounds.Width);
				I16(bounds.Height);
				I32(a.CenterPosition.Z);

				// The body animation the engine is playing (informational: the draws carry the exact sprites).
				var anim = BodyAnimation(a);
				I32(StringId(anim?.CurrentSequence?.Name));
				U16(anim?.CurrentSequence != null ? anim.CurrentFrame : 0);
				U16(a.TraitOrDefault<GainsExperience>()?.Level ?? 0);
				actorCount++;
			}

			// Draws
			var drawCount = 0;
			Ensure(n * DrawBytes);
			Others.Clear();
			for (var i = 0; i < n; i++)
			{
				var (r, key) = Renderables[i];
				if (r is not SpriteRenderable sr)
				{
					// Beams, contrails, lines, voxel models...: drawn by the engine's renderers and captured below.
					Others.Add(r);
					continue;
				}

				var sprite = sr.Sprite;
				if (sprite == null || sprite.Bounds.Width == 0)
					continue;

				// SpriteRenderable.ScreenPosition + SpriteRenderer.DrawSprite, unrounded so the page can interpolate.
				var scale = sr.Scale;
				var half = 0.5f * scale * sprite.Size;
				var s3 = wr.Screen3DPosition(sr.Origin);
				var off = wr.ScreenPxOffset(sr.Offset);
				var o = new Vector3(s3.X + off.X - (int)half.X, s3.Y + off.Y - (int)half.Y, s3.Z - half.Z) + scale * sprite.Offset;

				var t = sr.Alpha * sr.Tint;
				if (wr.TerrainLighting != null && (sr.TintModifiers & TintModifiers.IgnoreWorldTint) == 0)
					t *= wr.TerrainLighting.TintAt(sr.Origin);

				var a = sr.Alpha;
				if ((sr.TintModifiers & TintModifiers.ReplaceColor) != 0)
					a *= -1;

				var palette = sr.Palette?.TextureIndex ?? 0;
				var dflags = sr.IsDecoration ? 1 : 0;
				if (i >= worldCount)
					dflags |= 4; // above the shroud
				if (sr.Rotation != WAngle.Zero)
					dflags |= 2;

				U32(key);
				I32(SpriteId(sprite));
				F32(o.X);
				F32(o.Y);
				F32(o.Z);
				F32(scale);
				U16(palette);
				U16(dflags);
				F32(t.X);
				F32(t.Y);
				F32(t.Z);
				F32(a);
				F32(sr.Rotation.RendererRadians());
				drawCount++;
			}

			// Everything that is not a plain sprite: let the engine render it into the recording context
			// (WorldRenderer.PrepareRenderables + Draw for these renderables only).
			UnsupportedRenderables = 0;
			Capture.Begin();
			try
			{
				wr.BeginFrame();
				// Terrain overlays (ore, gems and smudges) are separate from actor renderables.
				// Capture the engine layers every frame so harvesting and fog memory stay native.
				Capture.GroundPass = true;
				foreach (var overlay in world.WorldActor.TraitsImplementing<IRenderOverlay>())
					CaptureGroundLayers(overlay, wr);
				Game.Renderer.Flush();
				Capture.GroundPass = false;
				var finalized = new List<IFinalizedRenderable>(Others.Count);
				foreach (var r in Others)
				{
					try { finalized.Add(r.PrepareRender(wr)); }
					catch (Exception) { UnsupportedRenderables++; }
				}

				wr.EndFrame();
				foreach (var f in finalized)
				{
					try { f.Render(wr); }
					catch (Exception) { UnsupportedRenderables++; }
				}

				Game.Renderer.Flush();
			}
			finally
			{
				Capture.End();
			}

			// Players (tiny; sent every tick so ownership/colours/defeat are always current)
			var playerStart = pos;
			Ensure(players.Length * PlayerBytes);
			foreach (var p in players)
			{
				I32(StringId(p.ResolvedPlayerName));
				I32(StringId(p.Faction.InternalName));
				U32((uint)p.Color.ToArgb());
				var pflags = 0;
				if (p == world.LocalPlayer)
					pflags |= 1;
				if (p.IsBot)
					pflags |= 2;
				if (p.Playable)
					pflags |= 4;
				if (p.NonCombatant)
					pflags |= 8;
				U8(pflags);
				U8((int)p.WinState);
				U16(0);
			}

			// New sprites
			var spriteStart = pos;
			var newSprites = Sprites.Count - spritesSent;
			Ensure(newSprites * SpriteBytes);
			for (var i = spritesSent; i < Sprites.Count; i++)
			{
				var s = Sprites[i];
				var ss = s as SpriteWithSecondaryData;
				I32(TextureId(s.Sheet));
				I32(ss != null ? TextureId(ss.SecondarySheet) : -1);
				U8((int)s.Channel);
				U8(ss != null ? (int)ss.SecondaryChannel : 0);
				U8((int)s.BlendMode);
				U8(0);
				F32(s.Left);
				F32(s.Top);
				F32(s.Right);
				F32(s.Bottom);
				F32(ss?.SecondaryLeft ?? 0);
				F32(ss?.SecondaryTop ?? 0);
				F32(ss?.SecondaryRight ?? 0);
				F32(ss?.SecondaryBottom ?? 0);
				F32(s.Size.X);
				F32(s.Size.Y);
				F32(s.Size.Z);
				I16(s.Bounds.Width);
				I16(s.Bounds.Height);
			}

			spritesSent = Sprites.Count;

			// Textures that changed (sheets of sent sprites, terrain sheets, the hardware palette)
			var hp = SimHost.Palette;
			var paletteTexture = (WebTexture)hp.Texture;
			MarkTexture(paletteTexture.Id);
			var textureStart = pos;
			var textureCount = 0;
			paletteTextureId = paletteTexture.Id;

			// Sheets drawn this tick first, then (a few per tick) every other sheet, so each sheet reaches the page
			// once and our CPU copy can be dropped (WebTexture.Sent).
			var extra = 0;
			TextureQueue.Clear();
			TextureQueue.AddRange(TexturesOfInterest);
			foreach (var t in WebTexture.All)
				if (t.Data != null && !t.IsRenderTarget && t.Size.Width > 0 && !TexturesOfInterest.Contains(t.Id))
					TextureQueue.Add(t.Id);

			foreach (var id in TextureQueue)
			{
				var tex = WebTexture.All[id];
				if (TextureVersionsSent.TryGetValue(id, out var v) && v == tex.Version)
					continue;

				if (!TexturesOfInterest.Contains(id) && extra++ >= 3)
					continue;

				// The palette is re-uploaded every frame by RefreshPalette: only resend real changes.
				if (tex == paletteTexture)
				{
					if (lastPalette != null && tex.Data.AsSpan().SequenceEqual(lastPalette))
					{
						TextureVersionsSent[id] = tex.Version;
						continue;
					}

					lastPalette = (byte[])tex.Data.Clone();
				}

				Ensure(TextureBytes);
				I32(id);
				I32(tex.Version);
				I32(tex.Size.Width);
				I32(tex.Size.Height);
				I32(tex == paletteTexture ? 1 : tex.IsRenderTarget ? 2 : 0);
				TextureVersionsSent[id] = tex.Version;
				textureCount++;
			}
			// New strings
			var stringStart = pos;
			var newStrings = Strings.Count - stringsSent;
			for (var i = stringsSent; i < Strings.Count; i++)
			{
				var bytes = Encoding.UTF8.GetBytes(Strings[i]);
				Ensure(bytes.Length + 8);
				U16(bytes.Length);
				bytes.CopyTo(buffer, pos);
				pos += bytes.Length;
			}

			Pad4();
			stringsSent = Strings.Count;

			// Captured renderer output: vertices (OpenRA.Graphics.Vertex), quad batches, model framebuffer commands.
			Ensure(Capture.Vertices.Length + Capture.Batches.Length + Capture.ModelCommands.Length);
			Capture.Vertices.CopyTo(buffer.AsSpan(pos));
			pos += Capture.Vertices.Length;
			Capture.Batches.CopyTo(buffer.AsSpan(pos));
			pos += Capture.Batches.Length;
			Capture.ModelCommands.CopyTo(buffer.AsSpan(pos));
			pos += Capture.ModelCommands.Length;

			// ---- header
			var end = pos;
			pos = 0;
			U32(resync ? ResyncMagic : Magic);
			resync = false;
			I32(world.WorldTick);
			I32(SimHost.OrderManager.NetFrameNumber);
			I32(SimHost.Connection.SyncHashes.Count > 0 ? SimHost.Connection.SyncHashes[^1] : 0);
			F32((float)LastTickMs);
			F32((float)LastBuildMs);
			I32(actorCount);
			I32(drawCount);
			I32(players.Length);
			I32(newSprites);
			I32(textureCount);
			I32(newStrings);
			I32(hp.Height);
			I32(Array.IndexOf(players, world.LocalPlayer));
			I32(UnsupportedRenderables);
			I32(world.Selection.Hash);
			I32(Capture.VertexCount);
			I32(Capture.BatchCount);
			I32(Capture.ModelCmdCount);
			I32(0);
			pos = end;

			// Section order is fixed: actors, draws, players, sprites, textures, strings.
			_ = actorStart + playerStart + spriteStart + textureStart + stringStart;

			LastBuildMs = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
			return pos;
		}

		// The browser camera is independent of the headless viewport. Capture all occupied
		// cells from the engine layers rather than culling them with that viewport.
		static void CaptureGroundLayers(IRenderOverlay overlay, WorldRenderer wr)
		{
			const System.Reflection.BindingFlags fields = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;
			var shader = (WebShader)typeof(SpriteRenderer).GetField("shader", fields).GetValue(Game.Renderer.WorldSpriteRenderer);
			for (var type = overlay.GetType(); type != null; type = type.BaseType)
				foreach (var field in type.GetFields(fields | System.Reflection.BindingFlags.DeclaredOnly))
				{
					if (field.GetValue(overlay) is not TerrainSpriteLayer layer) continue;
					var v = (Vertex[])typeof(TerrainSpriteLayer).GetField("vertices", fields).GetValue(layer);
					var sheets = (Sheet[])typeof(TerrainSpriteLayer).GetField("sheets", fields).GetValue(layer);
					for (var n = 0; n < sheets.Length; n++)
						if (sheets[n] != null) shader.SetTexture("Texture" + n, sheets[n].GetTexture());
					Capture.AddQuads(v, 0, v.Length, layer.BlendMode, shader);
				}
		}

		/// <summary>A JSON string literal (no reflection: the trimmed AOT build has reflection-based serialization off).</summary>
		public static string Json(string s) => "\"" + System.Text.Json.JsonEncodedText.Encode(s ?? "").Value + "\"";

		/// <summary>Static data for the page: map/grid geometry and the terrain layer's vertices (combined.vert layout).</summary>
		public static string StartInfoJson(out byte[] terrainVertices)
		{
			var world = SimHost.World;
			var wr = SimHost.WorldRenderer;
			var map = world.Map;

			var terrain = world.WorldActor.TraitsImplementing<IRenderTerrain>().FirstOrDefault();
			var layerField = terrain?.GetType().GetField("spriteLayer", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
			var layer = layerField?.GetValue(terrain) as TerrainSpriteLayer;
			var sheetIds = new int[8];
			terrainVertices = [];
			if (layer != null)
			{
				var vertices = (Vertex[])typeof(TerrainSpriteLayer).GetField("vertices", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).GetValue(layer);
				var sheets = (Sheet[])typeof(TerrainSpriteLayer).GetField("sheets", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).GetValue(layer);
				terrainVertices = MemoryMarshal.AsBytes(vertices.AsSpan()).ToArray();
				for (var i = 0; i < sheetIds.Length; i++)
				{
					sheetIds[i] = sheets[i] != null ? TextureId(sheets[i]) : -1;
					MarkTexture(sheetIds[i]);
				}
			}

			var tl = wr.ScreenPxPosition(map.ProjectedTopLeft);
			var br = wr.ScreenPxPosition(map.ProjectedBottomRight);
			var players = SimHost.PlayablePlayers();
			var local = world.LocalPlayer;
			var start = local != null ? wr.ScreenPxPosition(map.CenterOfCell(local.HomeLocation)) : (tl + br) / 2;
			var depthMargin = map.Grid.EnableDepthBuffer ? map.Rules.TerrainInfo.TileSize.Height * map.Grid.MaximumTerrainHeight : 0;

			var sb = new StringBuilder();
			sb.Append('{');
			sb.Append($"\"map\":\"{map.Title}\",\"uid\":\"{map.Uid}\",\"tileset\":\"{map.Tileset}\",");
			sb.Append($"\"mapSize\":[{map.MapSize.Width},{map.MapSize.Height}],");
			sb.Append($"\"tileSize\":[{wr.TileSize.Width},{wr.TileSize.Height}],\"tileScale\":{wr.TileScale},");
			sb.Append($"\"bounds\":[{tl.X},{tl.Y},{br.X},{br.Y}],\"start\":[{start.X},{start.Y}],");
			sb.Append($"\"depthBuffer\":{(map.Grid.EnableDepthBuffer ? "true" : "false")},\"depthMargin\":{depthMargin},");
			// World px of projected cell (0, 0) at height 0: the origin of the shroud and minimap grids.
			var c0 = map.CenterOfCell(new MPos(0, 0).ToCPos(map));
			var origin = wr.ScreenPxPosition(new WPos(c0.X, c0.Y, 0));
			sb.Append($"\"cellOrigin\":[{origin.X},{origin.Y}],\"gridType\":\"{map.Grid.Type}\",");
			sb.Append($"\"mapBounds\":[{map.Bounds.Left},{map.Bounds.Top},{map.Bounds.Right},{map.Bounds.Bottom}],");
			sb.Append($"\"terrainSheets\":[{string.Join(",", sheetIds)}],");
			sb.Append($"\"terrainVertexCount\":{terrainVertices.Length / 48},\"vertexRowStride\":{4 * map.MapSize.Width},");
			sb.Append($"\"localPlayer\":\"{local?.InternalName}\",");
			sb.Append($"\"players\":[{string.Join(",", players.Select(p => $"{{\"name\":\"{p.InternalName}\",\"label\":{Json(p.ResolvedPlayerName)},\"faction\":\"{p.Faction.InternalName}\",\"color\":\"{p.Color.R:X2}{p.Color.G:X2}{p.Color.B:X2}\",\"bot\":{(p.IsBot ? "true" : "false")}}}"))}],");
			sb.Append($"\"timings\":{{{string.Join(",", SimHost.Timings.Select(kv => $"\"{kv.Key}\":{kv.Value:F1}"))}}}");
			sb.Append('}');
			return sb.ToString();
		}
	}
}
