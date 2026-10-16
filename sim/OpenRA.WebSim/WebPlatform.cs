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
using System.Runtime.InteropServices;
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

		/// <summary>
		/// BGRA bytes (or null): our own copy. The engine recycles a released sheet's buffer for the next sheet
		/// (Sheet.ReleaseBufferAndTryTransferTo), so keeping a reference would show another sheet's pixels.
		/// </summary>
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

		/// <summary>
		/// Set by the browser host: hands a texture's new pixels to the page as soon as the engine commits them.
		/// Returns true when the page took them, so no copy needs to be kept (unless the sheet may reopen).
		/// </summary>
		public static Func<WebTexture, byte[], bool> Stream;

		public void SetData(byte[] colors, int width, int height)
		{
			Released = false;
			Size = new Size(width, height);
			Version++;
			if (colors == null)
			{
				Data = null;
				return;
			}

			if (!IsRenderTarget && Stream != null && Stream(this, colors) && !MayReopen(this))
			{
				Data = null;
				Released = true;
				return;
			}

			if (Data == null || Data.Length != colors.Length)
				Data = new byte[colors.Length];

			Buffer.BlockCopy(colors, 0, Data, 0, colors.Length);
		}

		public void SetSubData(byte[] colors, int xoffset, int yoffset, int width, int height)
		{
			// Sheets pass their whole backing array along with the dirty region: copy that region's rows.
			Released = false;
			if (Data == null || Data.Length != colors.Length)
			{
				Version++;
				if (Stream != null && Stream(this, colors) && !MayReopen(this))
				{
					Data = null;
					Released = true;
					return;
				}

				Data = (byte[])colors.Clone();
				return;
			}

			var stride = 4 * Size.Width;
			for (var y = yoffset; y < yoffset + height; y++)
				Buffer.BlockCopy(colors, y * stride + 4 * xoffset, Data, y * stride + 4 * xoffset, 4 * width);

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
			// The engine writes into what it gets back (Sheet.CreateBuffer), so hand out a copy.
			if (Data != null)
				return (byte[])Data.Clone();

			if (Released)
				DroppedReads++;

			return new byte[4 * Size.Width * Size.Height];
		}

		/// <summary>Our copy was dropped after the page received it (the page keeps the pixels on the GPU).</summary>
		public bool Released { get; private set; }

		/// <summary>A restored prebaked sheet: the page fills it from its cache; there are never pixels here.</summary>
		public bool External { get; private set; }

		public void MarkExternal()
		{
			External = true;
			Released = true;
			Data = null;
		}

		/// <summary>Reads of a dropped copy (would lose pixels; must stay 0 — watched in the stats).</summary>
		public static int DroppedReads;

		/// <summary>True for sheets the engine may still write to (a sheet builder's current sheet): never dropped.</summary>
		public static Func<WebTexture, bool> MayReopen = _ => true;

		/// <summary>Called after the page has this version: drops our copy unless the engine may reopen the sheet.</summary>
		public void Sent()
		{
			if (Data == null || IsRenderTarget || MayReopen(this))
				return;

			Data = null;
			Released = true;
		}

		public Size Size { get; private set; }
		public TextureScaleFilter ScaleFilter { get; set; }

		/// <summary>A framebuffer's colour texture: the page renders into it (no pixel data here).</summary>
		public bool IsRenderTarget { get; init; }

		/// <summary>Set by the browser host: the page frees its GPU copy when the engine disposes a texture.</summary>
		public static Action<int> Freed;

		public bool Disposed { get; private set; }

		public void Dispose()
		{
			if (Disposed)
				return;

			Disposed = true;
			Data = null;
			FloatData = null;
			Freed?.Invoke(Id);
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

	/// <summary>
	/// Draws nothing, but while <see cref="Capture"/> is active it records the draw calls (with the bound vertex
	/// buffer, shader state, blend mode and render target) so the page can replay them.
	/// </summary>
	sealed class WebGraphicsContext : IGraphicsContext
	{
		public static object CurrentVertexBuffer;
		public static WebShader CurrentShader;
		public static WebTexture CurrentTarget;
		static BlendMode blend;

		public string GLVersion => "Web";

		public IVertexBuffer<T> CreateEmptyVertexBuffer<T>(int size) where T : struct => new WebVertexBuffer<T>(null, size);
		public IVertexBuffer<T> CreateVertexBuffer<T>(T[] data, bool dynamic = true) where T : struct => new WebVertexBuffer<T>(data, data.Length);
		public T[] CreateVertices<T>(int size) where T : struct => new T[size];
		public IIndexBuffer CreateIndexBuffer(uint[] indices) => new WebIndexBuffer();
		public ITexture CreateTexture() => new WebTexture();
		public IFrameBuffer CreateFrameBuffer(Size s) => new WebFrameBuffer(s);
		public IFrameBuffer CreateFrameBuffer(Size s, Color clearColor) => new WebFrameBuffer(s);
		public IShader CreateShader(IShaderBindings shaderBindings) => new WebShader(shaderBindings.VertexShaderName);
		public void EnableScissor(int x, int y, int width, int height) { }
		public void DisableScissor() { }
		public void Present() { }

		public void DrawPrimitives(PrimitiveType pt, int firstVertex, int numVertices)
		{
			if (Capture.Active && pt == PrimitiveType.TriangleList && CurrentShader?.Name == "model" && CurrentVertexBuffer is IModelVertexSource vb)
				Capture.AddModelDraw(vb, firstVertex, numVertices, CurrentShader, CurrentTarget);
		}

		public void DrawElements(int numIndices, int offset)
		{
			// SpriteRenderer.Flush: quads (6 indices each) over the temp vertex buffer.
			if (Capture.Active && CurrentShader != null && CurrentTarget == null && CurrentVertexBuffer is WebVertexBuffer<Vertex> vb)
				Capture.AddQuads(vb.Data, offset / 6 * 4, numIndices / 6 * 4, blend, CurrentShader);
		}

		public void Clear() { }
		public void EnableDepthBuffer() { }
		public void DisableDepthBuffer() { }
		public void ClearDepthBuffer() { }
		public void SetBlendMode(BlendMode mode) => blend = mode;
		public void SetVSyncEnabled(bool enabled) { }
		public void Dispose() { }
	}

	sealed class WebFrameBuffer : IFrameBuffer
	{
		readonly WebTexture texture;

		public WebFrameBuffer(Size s)
		{
			texture = new WebTexture { IsRenderTarget = true };
			texture.SetData(null, s.Width, s.Height);
		}

		public ITexture Texture => texture;

		public void Bind()
		{
			WebGraphicsContext.CurrentTarget = texture;
			if (Capture.Active)
				Capture.BeginTarget(texture);
		}

		public void Unbind()
		{
			if (Capture.Active)
				Capture.EndTarget();
			WebGraphicsContext.CurrentTarget = null;
		}

		public void EnableScissor(Rectangle rect) { }
		public void DisableScissor() { }
		public void Dispose() { }
	}

	sealed class WebVertexBuffer<T> : IVertexBuffer<T>, IModelVertexSource where T : struct
	{
		static int nextId;

		public int Id { get; } = System.Threading.Interlocked.Increment(ref nextId);
		public int Version { get; private set; }

		/// <summary>The latest data (the caller's array: temp buffers are drawn right after SetData).</summary>
		public T[] Data { get; private set; }
		public int Length { get; private set; }

		public WebVertexBuffer(T[] data, int length)
		{
			Data = data;
			Length = length;
		}

		public void Bind() => WebGraphicsContext.CurrentVertexBuffer = this;

		public void SetData(T[] vertices, int length) => Set(vertices, 0, 0, length);
		public void SetData(ref T[] vertices, int length) => Set(vertices, 0, 0, length);
		public void SetData(T[] vertices, int offset, int start, int length) => Set(vertices, offset, start, length);

		void Set(T[] vertices, int offset, int start, int length)
		{
			if (typeof(T) == typeof(ModelVertex))
			{
				// Model buffers are static and drawn later: keep our own copy.
				Data ??= new T[Math.Max(Length, start + length)];
				if (Data.Length < start + length)
				{
					var grown = Data;
					Array.Resize(ref grown, start + length);
					Data = grown;
				}

				Array.Copy(vertices, offset, Data, start, length);
				Length = Math.Max(Length, start + length);
			}
			else if (offset == 0 && start == 0)
			{
				Data = vertices;
				Length = length;
			}

			Version++;
		}

		public byte[] Bytes() => Data == null ? [] : MemoryMarshal.AsBytes(Data.AsSpan(0, Math.Min(Length, Data.Length))).ToArray();

		public void Dispose() { }
	}

	sealed class WebIndexBuffer : IIndexBuffer
	{
		public void Bind() { }
		public void Dispose() { }
	}

	/// <summary>Remembers its uniforms so captured draws carry the state the real shader would have.</summary>
	public sealed class WebShader : IShader
	{
		public readonly string Name;

		/// <summary>True for the UI sprite renderer's shader (positions in viewport px).</summary>
		public bool UiSpace;

		readonly Dictionary<string, ITexture> textures = [];
		readonly Dictionary<string, float[]> vecs = [];
		readonly Dictionary<string, float[]> matrices = [];

		public WebShader(string name) => Name = name;

		/// <summary>
		/// A sampler's texture id, or -1. The engine only rebinds the samplers a batch uses, so the others keep whatever
		/// an earlier batch (even an earlier world) bound: a disposed texture is reported as unbound.
		/// </summary>
		public int TextureId(string name) => textures.TryGetValue(name, out var t) && t is WebTexture { Disposed: false } w ? w.Id : -1;
		public float[] Vec(string name) => vecs.TryGetValue(name, out var v) ? v : null;
		public float[] Matrix(string name) => matrices.TryGetValue(name, out var m) ? m : null;

		// Uniforms are copied into one reused array per name: Capture.AddModelDraw copies the values at draw time.
		static float[] Slot(Dictionary<string, float[]> d, string name, int length)
		{
			if (!d.TryGetValue(name, out var a) || a.Length != length)
				d[name] = a = new float[length];
			return a;
		}

		public void SetBool(string name, bool value) => Slot(vecs, name, 1)[0] = value ? 1 : 0;
		public void SetVec(string name, float x) => Slot(vecs, name, 1)[0] = x;
		public void SetVec(string name, float x, float y) { var a = Slot(vecs, name, 2); a[0] = x; a[1] = y; }
		public void SetVec(string name, float x, float y, float z) { var a = Slot(vecs, name, 3); a[0] = x; a[1] = y; a[2] = z; }
		public void SetVec(string name, ReadOnlyMemory<float> vec, int length)
		{
			var src = vec.Span[..Math.Min(length, vec.Length)];
			src.CopyTo(Slot(vecs, name, src.Length));
		}

		public void SetTexture(string param, ITexture texture) => textures[param] = texture;
		public void SetMatrix(string param, float[] mtx) => mtx.AsSpan().CopyTo(Slot(matrices, param, mtx.Length));
		public void PrepareRender() { }
		public void Bind() => WebGraphicsContext.CurrentShader = this;
	}

	sealed class WebHardwareCursor : IHardwareCursor
	{
		public void Dispose() { }
	}

	sealed class WebFont : IFont
	{
		// Text is rendered by the page; the simulation font only supplies placeholder metrics.
		public bool HasGlyph(char c) => true;

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

	/// <summary>
	/// Hands sounds to the page (WebAudio): decoded PCM once per source, then play/stop/volume events. Music
	/// streams are pumped in chunks from the tick loop (the engine's OpenAL backend does that on a thread).
	/// Without a page (native runner) the callbacks are unset and it behaves like the silent null engine.
	/// </summary>
	public sealed class WebSoundEngine : ISoundEngine
	{
		public interface IAudioSink
		{
			void Source(int id, int channels, int bits, int rate, ReadOnlySpan<byte> pcm);
			void Play(int sound, int source, bool loop, bool relative, float x, float y, float volume, bool attenuate);
			void Stream(int sound, int channels, int bits, int rate, ReadOnlySpan<byte> pcm, bool end, float volume);
			void Stop(int sound);
			void Volume(int sound, float volume);
			void Pause(int sound, bool paused);
			void SeekStart(int sound, double seconds);
		}

		public static IAudioSink Sink;

		/// <summary>World px of a position (set by the host once a world renderer exists).</summary>
		public static Func<WPos, (float X, float Y)> ToScreen = p => (p.X, p.Y);

		static int nextId;
		static readonly List<WebSound> Streams = [];
		static double musicStart;
		static bool allPaused;

		// Ogg's decoder is forward-only. Reopen through the playlist and discard PCM in bounded chunks,
		// rather than retaining minutes of decoded audio or changing the desktop engine's sound contract.
		public static void SeekMusic(double seconds, Action restart)
		{
			musicStart = Math.Max(0, seconds);
			try { restart(); }
			finally { musicStart = 0; }
		}

		public bool Dummy => Sink == null;
		public float Volume { get; set; } = 1f;
		public SoundDevice[] AvailableDevices() => [new SoundDevice(null, "Web")];

		public ISoundSource AddSoundSourceFromMemory(byte[] data, int channels, int sampleBits, int sampleRate)
		{
			var s = new WebSoundSource(++nextId, data.Length / Math.Max(1, channels * sampleBits / 8 * sampleRate));
			Sink?.Source(s.Id, channels, sampleBits, sampleRate, data);
			return s;
		}

		public ISound Play2D(ISoundSource soundSource, bool loop, bool relative, WPos pos, float volume, bool attenuateVolume)
		{
			if (soundSource is not WebSoundSource src)
				return null;

			var sound = new WebSound(++nextId, loop ? double.MaxValue : src.Seconds) { Volume = volume };
			var (x, y) = ToScreen(pos);
			Sink?.Play(sound.Id, src.Id, loop, relative, x, y, volume, attenuateVolume);
			return sound;
		}

		public ISound Play2DStream(Stream stream, int channels, int sampleBits, int sampleRate, bool loop, bool relative, WPos pos, float volume)
		{
			if (Sink == null)
				return null;

			var frameBytes = channels * sampleBits / 8;
			var wanted = (long)(musicStart * sampleRate) * frameBytes;
			long skipped = 0;
			if (wanted > 0)
			{
				var scratch = new byte[64 * 1024 / frameBytes * frameBytes];
				while (skipped < wanted)
				{
					var n = stream.Read(scratch, 0, (int)Math.Min(scratch.Length, wanted - skipped));
					if (n == 0) break;
					skipped += n;
				}
			}
			var offset = skipped / (double)(sampleRate * frameBytes);
			var sound = new WebSound(++nextId, double.MaxValue) { Volume = volume, Stream = stream, Channels = channels, Bits = sampleBits, Rate = sampleRate, Offset = offset, SentSeconds = offset, AllPaused = allPaused };
			Streams.Add(sound);
			Sink.SeekStart(sound.Id, offset);
			Pump();
			return sound;
		}

		/// <summary>Sends each music stream''s next ~1.5 s of PCM (called every tick; the page queues the chunks).</summary>
		public static void Pump()
		{
			for (var i = Streams.Count - 1; i >= 0; i--)
			{
				var s = Streams[i];
				if (s.Stopped || s.Complete)
				{
					s.Stream?.Dispose();
					Streams.RemoveAt(i);
					continue;
				}
				if (s.Stream == null || s.Paused || s.AllPaused)
					continue;

				var bytesPerSecond = s.Channels * s.Bits / 8 * s.Rate;
				if (s.SentSeconds - s.Elapsed > 3.0)
					continue;

				// One chunk buffer per stream (1.5 s of PCM, about 264 KB): the page copies the view (worker.ts soundStream).
				var size = bytesPerSecond * 3 / 2 / 4 * 4;
				if (s.Chunk == null || s.Chunk.Length != size)
					s.Chunk = new byte[size];
				var buffer = s.Chunk;
				var n = 0;
				for (int r; n < buffer.Length && (r = s.Stream.Read(buffer, n, buffer.Length - n)) > 0;)
					n += r;
				var end = n < buffer.Length;
				s.SentSeconds += n / (double)bytesPerSecond;
				Sink?.Stream(s.Id, s.Channels, s.Bits, s.Rate, buffer.AsSpan(0, n), end, s.Volume);
				if (end)
				{
					s.Duration = s.SentSeconds;
					s.Stream.Dispose();
					s.Stream = null;
				}
			}
		}

		public void PauseSound(ISound sound, bool paused)
		{
			if (sound is WebSound s)
			{
				s.Paused = paused;
				Sink?.Pause(s.Id, paused);
			}
		}

		public void SetAllSoundsPaused(bool paused) => PauseAll(paused);

		public static void PauseAll(bool paused)
		{
			allPaused = paused;
			foreach (var s in Streams)
				s.AllPaused = paused;
			Sink?.Pause(-1, paused);
		}

		public void SetSoundVolume(float volume, ISound music, ISound video)
		{
			Volume = volume;
			Sink?.Volume(-1, volume);
		}

		public void StopSound(ISound sound)
		{
			if (sound is WebSound s)
			{
				s.Stopped = true;
				Sink?.Stop(s.Id);
			}
		}

		public void StopAllSounds()
		{
			foreach (var s in Streams)
				s.Stopped = true;
			Sink?.Stop(-1);
		}

		public void SetListenerPosition(WPos position) { }
		public void SetSoundLooping(bool looping, ISound sound) { }
		public void SetSoundPosition(ISound sound, WPos position) { }
		public void Dispose() { }
	}

	sealed class WebSoundSource : ISoundSource
	{
		public readonly int Id;
		public readonly double Seconds;

		public WebSoundSource(int id, double seconds)
		{
			Id = id;
			Seconds = seconds;
		}

		public void Dispose() { }
	}

	sealed class WebSound : ISound
	{
		public readonly int Id;
		readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
		public double Duration;
		public bool Stopped;
		public Stream Stream;
		public int Channels, Bits, Rate;
		public double SentSeconds;
		public double Offset;
		public byte[] Chunk;

		public WebSound(int id, double duration)
		{
			Id = id;
			Duration = duration;
		}

		public double Elapsed => Offset + clock.Elapsed.TotalSeconds;
		bool paused, allPaused;
		public bool Paused { get => paused; set { paused = value; UpdateClock(); } }
		public bool AllPaused { get => allPaused; set { allPaused = value; UpdateClock(); } }
		void UpdateClock()
		{
			if (paused || allPaused) clock.Stop();
			else clock.Start();
		}

		float volume;
		public float Volume
		{
			get => volume;
			set
			{
				volume = value;
				WebSoundEngine.Sink?.Volume(Id, value);
			}
		}

		public float SeekPosition => (float)Elapsed;
		public bool Complete => Stopped || (Stream == null && Elapsed >= Duration);
		public void SetPosition(WPos position) { }
	}
}
