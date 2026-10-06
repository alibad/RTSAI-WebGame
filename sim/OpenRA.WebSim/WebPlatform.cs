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
using OpenRA.Graphics;
using OpenRA.Primitives;

namespace OpenRA.WebSim
{
	/// <summary>
	/// A headless IPlatform (no SDL, OpenGL, OpenAL or FreeType) for the embedded host.
	/// It behaves like OpenRA.Platforms.Null except that textures keep the pixel data the engine gives them,
	/// so the page can draw the engine's own sprite sheets and hardware palette with WebGL.
	/// </summary>
	public sealed class WebPlatform : IPlatform
	{
		public IPlatformWindow CreateWindow(Size size, WindowMode windowMode, float scaleModifier,
			int vertexBatchSize, int indexBatchSize, int videoDisplay, GLProfile profile)
		{
			return new WebPlatformWindow(size);
		}

		public ISoundEngine CreateSound(string device) => new WebSoundEngine();
		public IFont CreateFont(byte[] data) => new WebFont();
	}

	public sealed class WebTexture : ITexture
	{
		static readonly List<WebTexture> AllTextures = [];
		public static IReadOnlyList<WebTexture> All => AllTextures;

		public readonly int Id;

		/// <summary>BGRA bytes (or null). The array is shared with the engine's Sheet, not copied.</summary>
		public byte[] Data { get; private set; }
		public float[] FloatData { get; private set; }

		/// <summary>Bumped on every upload so the page can re-fetch only changed textures.</summary>
		public int Version { get; private set; }

		public WebTexture()
		{
			lock (AllTextures)
			{
				Id = AllTextures.Count;
				AllTextures.Add(this);
			}
		}

		public void SetData(byte[] colors, int width, int height)
		{
			Data = colors;
			Size = new Size(width, height);
			Version++;
		}

		public void SetSubData(byte[] colors, int xoffset, int yoffset, int width, int height)
		{
			// Sheets pass their whole backing array along with the dirty region.
			if (Data == null || Data.Length == colors.Length)
				Data = colors;

			Version++;
		}

		public void SetFloatData(float[] data, int width, int height)
		{
			FloatData = data;
			Size = new Size(width, height);
			Version++;
		}

		public void SetDataFromReadBuffer(Rectangle rect) { }

		public byte[] GetData()
		{
			if (Data != null)
				return Data;

			return new byte[4 * Size.Width * Size.Height];
		}

		public Size Size { get; private set; }
		public TextureScaleFilter ScaleFilter { get; set; }

		public void Dispose()
		{
			Data = null;
			FloatData = null;
		}
	}

	sealed class WebPlatformWindow : IPlatformWindow
	{
		readonly Size size;

		public WebPlatformWindow(Size size)
		{
			this.size = size;
			Context = new WebGraphicsContext();
		}

		public IGraphicsContext Context { get; }
		public Size NativeWindowSize => size;
		public Size EffectiveWindowSize => size;
		public float NativeWindowScale => 1f;
		public float EffectiveWindowScale => 1f;
		public Size SurfaceSize => size;
		public int DisplayCount => 1;
		public int CurrentDisplay => 0;
		public bool HasInputFocus => false;
		public bool IsSuspended => false;
		public GLProfile GLProfile => GLProfile.Modern;
		public GLProfile[] SupportedGLProfiles => [GLProfile.Modern];

		public event Action<float, float, float, float> OnWindowScaleChanged
		{
			add { }
			remove { }
		}

		public void PumpInput(IInputHandler inputHandler) { }
		public string GetClipboardText() => "";
		public bool SetClipboardText(string text) => false;
		public bool TryOpenUrl(string url) => false;
		public void GrabWindowMouseFocus() { }
		public void ReleaseWindowMouseFocus() { }
		public IHardwareCursor CreateHardwareCursor(string name, Size size, byte[] data, int2 hotspot, bool pixelDouble) => new WebHardwareCursor();
		public void SetHardwareCursor(IHardwareCursor cursor) { }
		public void SetWindowTitle(string title) { }
		public void SetRelativeMouseMode(bool mode) { }
		public void SetScaleModifier(float scale) { }
		public void Dispose() { }
	}

	sealed class WebGraphicsContext : IGraphicsContext
	{
		public string GLVersion => "Web";

		public IVertexBuffer<T> CreateEmptyVertexBuffer<T>(int size) where T : struct => new WebVertexBuffer<T>();
		public IVertexBuffer<T> CreateVertexBuffer<T>(T[] data, bool dynamic = true) where T : struct => new WebVertexBuffer<T>();
		public T[] CreateVertices<T>(int size) where T : struct => new T[size];
		public IIndexBuffer CreateIndexBuffer(uint[] indices) => new WebIndexBuffer();
		public ITexture CreateTexture() => new WebTexture();
		public IFrameBuffer CreateFrameBuffer(Size s) => new WebFrameBuffer(s);
		public IFrameBuffer CreateFrameBuffer(Size s, Color clearColor) => new WebFrameBuffer(s);
		public IShader CreateShader(IShaderBindings shaderBindings) => new WebShader();
		public void EnableScissor(int x, int y, int width, int height) { }
		public void DisableScissor() { }
		public void Present() { }
		public void DrawPrimitives(PrimitiveType pt, int firstVertex, int numVertices) { }
		public void DrawElements(int numIndices, int offset) { }
		public void Clear() { }
		public void EnableDepthBuffer() { }
		public void DisableDepthBuffer() { }
		public void ClearDepthBuffer() { }
		public void SetBlendMode(BlendMode mode) { }
		public void SetVSyncEnabled(bool enabled) { }
		public void Dispose() { }
	}

	sealed class WebFrameBuffer : IFrameBuffer
	{
		public WebFrameBuffer(Size s)
		{
			Texture = new WebTexture();
			Texture.SetData(null, s.Width, s.Height);
		}

		public ITexture Texture { get; }
		public void Bind() { }
		public void Unbind() { }
		public void EnableScissor(Rectangle rect) { }
		public void DisableScissor() { }
		public void Dispose() { }
	}

	sealed class WebVertexBuffer<T> : IVertexBuffer<T> where T : struct
	{
		public void Bind() { }
		public void SetData(T[] vertices, int length) { }
		public void SetData(ref T[] vertices, int length) { }
		public void SetData(T[] vertices, int offset, int start, int length) { }
		public void Dispose() { }
	}

	sealed class WebIndexBuffer : IIndexBuffer
	{
		public void Bind() { }
		public void Dispose() { }
	}

	sealed class WebShader : IShader
	{
		public void SetBool(string name, bool value) { }
		public void SetVec(string name, float x) { }
		public void SetVec(string name, float x, float y) { }
		public void SetVec(string name, float x, float y, float z) { }
		public void SetVec(string name, ReadOnlyMemory<float> vec, int length) { }
		public void SetTexture(string param, ITexture texture) { }
		public void SetMatrix(string param, float[] mtx) { }
		public void PrepareRender() { }
		public void Bind() { }
	}

	sealed class WebHardwareCursor : IHardwareCursor
	{
		public void Dispose() { }
	}

	sealed class WebFont : IFont
	{
		public FontGlyph CreateGlyph(char c, int size, float deviceScale)
		{
			return new FontGlyph
			{
				Offset = int2.Zero,
				Size = new Size(1, 1),
				Advance = size * 0.5f,
				Data = new byte[4],
			};
		}

		public void Dispose() { }
	}

	/// <summary>Silent sound engine. Phase 2 forwards Play2D calls to WebAudio on the page.</summary>
	sealed class WebSoundEngine : ISoundEngine
	{
		public bool Dummy => true;
		public SoundDevice[] AvailableDevices() => [new SoundDevice(null, "Web")];
		public ISoundSource AddSoundSourceFromMemory(byte[] data, int channels, int sampleBits, int sampleRate) => new WebSoundSource();
		public ISound Play2D(ISoundSource soundSource, bool loop, bool relative, WPos pos, float volume, bool attenuateVolume) => new WebSound();
		public ISound Play2DStream(Stream stream, int channels, int sampleBits, int sampleRate, bool loop, bool relative, WPos pos, float volume) => null;
		public float Volume { get; set; }
		public void PauseSound(ISound sound, bool paused) { }
		public void SetAllSoundsPaused(bool paused) { }
		public void SetSoundVolume(float volume, ISound music, ISound video) { }
		public void StopSound(ISound sound) { }
		public void StopAllSounds() { }
		public void SetListenerPosition(WPos position) { }
		public void SetSoundLooping(bool looping, ISound sound) { }
		public void SetSoundPosition(ISound sound, WPos position) { }
		public void Dispose() { }
	}

	sealed class WebSoundSource : ISoundSource
	{
		public void Dispose() { }
	}

	sealed class WebSound : ISound
	{
		public float Volume { get; set; }
		public float SeekPosition => 0;
		public bool Complete => true;
		public void SetPosition(WPos position) { }
	}
}
