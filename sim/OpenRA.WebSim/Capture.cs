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
using System.Runtime.InteropServices;
using OpenRA.Graphics;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Records what the engine's own renderers send to the (headless) graphics context while the snapshot renders
	/// the renderables that are not plain sprites: beams, contrails, lines, and voxel models (ModelRenderer draws them
	/// into a framebuffer sheet, then a sprite of that sheet is drawn). The page replays the recording in WebGL with
	/// ports of the engine's shaders, so these look exactly as the desktop game draws them.
	/// </summary>
	public static class Capture
	{
		public const int VertexBytes = 48; // OpenRA.Graphics.Vertex
		public const int BatchBytes = 44;
		public const int ModelCmdBytes = 136;

		public static bool Active { get; private set; }

		public static bool GroundPass { get; set; }

		static byte[] vertices = new byte[64 * 1024];
		static int vertexCount;
		static byte[] batches = new byte[16 * 1024];
		static int batchCount;
		static byte[] modelCmds = new byte[32 * 1024];
		static int modelCmdCount;

		/// <summary>Model vertex buffers referenced by this capture (id -> buffer), so the page can fetch new versions.</summary>
		public static readonly Dictionary<int, IModelVertexSource> ModelBuffers = [];

		/// <summary>Converts UI-space (viewport) positions back to world px for renderables drawn by the UI renderer.</summary>
		public static Func<float, float, (float X, float Y)> ViewToWorld = (x, y) => (x, y);

		public static int VertexCount => vertexCount;
		public static int BatchCount => batchCount;
		public static int ModelCmdCount => modelCmdCount;
		public static ReadOnlySpan<byte> Vertices => vertices.AsSpan(0, vertexCount * VertexBytes);
		public static ReadOnlySpan<byte> Batches => batches.AsSpan(0, batchCount * BatchBytes);
		public static ReadOnlySpan<byte> ModelCommands => modelCmds.AsSpan(0, modelCmdCount * ModelCmdBytes);

		public static void Begin()
		{
			Active = true;
			GroundPass = false;
			vertexCount = 0;
			batchCount = 0;
			modelCmdCount = 0;
		}

		public static void End() => Active = false;

		static void Ensure(ref byte[] buffer, int needed)
		{
			if (buffer.Length >= needed)
				return;
			var size = buffer.Length;
			while (size < needed)
				size *= 2;
			Array.Resize(ref buffer, size);
		}

		/// <summary>A quad batch from SpriteRenderer.Flush (DrawElements over the temp vertex buffer).</summary>
		public static void AddQuads(Vertex[] source, int first, int count, BlendMode blend, WebShader shader)
		{
			if (source == null || count <= 0 || first + count > source.Length)
				return;

			if (GroundPass)
			{
				// Terrain layers submit complete rows, including thousands of empty cells.
				// Send only non-degenerate quads through the shared snapshot ring.
				var visible = new List<Vertex>();
				for (var q = first; q + 3 < first + count; q += 4)
				{
					if (source[q].X == source[q + 2].X && source[q].Y == source[q + 2].Y)
						continue;
					for (var k = 0; k < 4; k++) visible.Add(source[q + k]);
				}
				if (visible.Count == 0) return;
				source = visible.ToArray();
				first = 0;
				count = source.Length;
			}

			Ensure(ref vertices, (vertexCount + count) * VertexBytes);
			var span = MemoryMarshal.AsBytes(source.AsSpan(first, count));
			span.CopyTo(vertices.AsSpan(vertexCount * VertexBytes));
			if (shader.UiSpace)
			{
				for (var i = 0; i < count; i++)
				{
					var o = (vertexCount + i) * VertexBytes;
					var x = BinaryPrimitives.ReadSingleLittleEndian(vertices.AsSpan(o));
					var y = BinaryPrimitives.ReadSingleLittleEndian(vertices.AsSpan(o + 4));
					var (wx, wy) = ViewToWorld(x, y);
					BinaryPrimitives.WriteSingleLittleEndian(vertices.AsSpan(o), wx);
					BinaryPrimitives.WriteSingleLittleEndian(vertices.AsSpan(o + 4), wy);
				}
			}

			Ensure(ref batches, (batchCount + 1) * BatchBytes);
			var b = batches.AsSpan(batchCount * BatchBytes, BatchBytes);
			BinaryPrimitives.WriteInt32LittleEndian(b, vertexCount);
			BinaryPrimitives.WriteInt32LittleEndian(b[4..], count);
			b[8] = (byte)blend;
			b[9] = (byte)(shader.UiSpace ? 1 : 0);
			b[10] = (byte)(GroundPass ? 1 : 0);
			b[11] = 0;
			for (var i = 0; i < 8; i++)
			{
				var id = shader.TextureId("Texture" + i);
				Snapshot.MarkTexture(id);
				BinaryPrimitives.WriteInt32LittleEndian(b[(12 + 4 * i)..], id);
			}

			vertexCount += count;
			batchCount++;
		}

		const int CmdBeginTarget = 1, CmdDraw = 2, CmdEndTarget = 3;

		// Model draw uniforms after the 24-byte command head (28 floats = 112 bytes): see web/src/render/models.ts.
		static readonly (string Name, int Count)[] UniformLayout =
			[("Palettes", 2), ("LightDirection", 4), ("AmbientLight", 3), ("DiffuseLight", 3), ("TransformMatrix", 16)];

		static Span<byte> NextCmd(int kind)
		{
			Ensure(ref modelCmds, (modelCmdCount + 1) * ModelCmdBytes);
			var c = modelCmds.AsSpan(modelCmdCount * ModelCmdBytes, ModelCmdBytes);
			c.Clear();
			BinaryPrimitives.WriteInt32LittleEndian(c, kind);
			modelCmdCount++;
			return c;
		}

		public static void BeginTarget(WebTexture target)
		{
			var c = NextCmd(CmdBeginTarget);
			BinaryPrimitives.WriteInt32LittleEndian(c[4..], target.Id);
			BinaryPrimitives.WriteInt32LittleEndian(c[8..], target.Size.Width);
			BinaryPrimitives.WriteInt32LittleEndian(c[12..], target.Size.Height);
		}

		public static void EndTarget() => NextCmd(CmdEndTarget);

		/// <summary>A ModelRenderer draw (DrawPrimitives, TriangleList) with the model shader's uniforms.</summary>
		public static void AddModelDraw(IModelVertexSource vb, int first, int count, WebShader shader, WebTexture target)
		{
			ModelBuffers[vb.Id] = vb;
			var diffuse = shader.TextureId("DiffuseTexture");
			Snapshot.MarkTexture(diffuse);
			var c = NextCmd(CmdDraw);
			BinaryPrimitives.WriteInt32LittleEndian(c[4..], target?.Id ?? -1);
			BinaryPrimitives.WriteInt32LittleEndian(c[8..], vb.Id);
			BinaryPrimitives.WriteInt32LittleEndian(c[12..], first);
			BinaryPrimitives.WriteInt32LittleEndian(c[16..], count);
			BinaryPrimitives.WriteInt32LittleEndian(c[20..], diffuse);
			var o = 24;
			foreach (var (name, n) in UniformLayout)
			{
				var v = name == "TransformMatrix" ? shader.Matrix(name) : shader.Vec(name);
				for (var i = 0; i < n; i++, o += 4)
					BinaryPrimitives.WriteSingleLittleEndian(c[o..], v != null && i < v.Length ? v[i] : 0f);
			}
		}
	}

	/// <summary>A model vertex buffer the page mirrors (id, version, raw ModelVertex bytes).</summary>
	public interface IModelVertexSource
	{
		int Id { get; }
		int Version { get; }
		byte[] Bytes();
	}
}
