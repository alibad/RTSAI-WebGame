using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using OpenRA;
using OpenRA.WebSim;

// Exercise the same playlist commands and PCM stream used by the browser, including the native completion clock.
static class MusicPlayerTest
{
	sealed class Sink : WebSoundEngine.IAudioSink
	{
		public int Chunks;
		public readonly List<bool> Pauses = [];
		public void Source(int id, int channels, int bits, int rate, ReadOnlySpan<byte> pcm) { }
		public void Play(int sound, int source, bool loop, bool relative, float x, float y, float volume, bool attenuate) { }
		public void Stream(int sound, int channels, int bits, int rate, ReadOnlySpan<byte> pcm, bool end, float volume) { Chunks++; }
		public void Stop(int sound) { }
		public void Volume(int sound, float volume) { }
		public void Pause(int sound, bool paused) { Pauses.Add(paused); }
	}

	public static int Run(Dictionary<string, string> opts)
	{
		SimHost.Boot(opts["root"]);
		SimHost.GateAudio(_ => true);
		var sink = new Sink();
		WebSoundEngine.Sink = sink;
		SimHost.Start(ScenarioSpec.Parse(File.ReadAllText(opts["scenario"])));
		SimHost.Tick();
		Game.Settings.Sound.Shuffle = false;
		using var list = JsonDocument.Parse(Ui.Command("{\"cmd\":\"music-list\"}"));
		var tracks = list.RootElement.GetProperty("tracks").EnumerateArray().Select(t => t.GetProperty("id").GetString()).ToArray();
		if (tracks.Length < 2) throw new Exception("Missing soundtrack library");
		Ui.Command(JsonSerializer.Serialize(new { cmd = "music-play", id = tracks[0] }));
		if (Game.Sound.CurrentMusic?.Filename != tracks[0]) throw new Exception("Track selection failed");
		Ui.Command("{\"cmd\":\"music-pause\"}");
		var before = Game.Sound.MusicSeekPosition;
		var chunks = sink.Chunks;
		Thread.Sleep(150);
		WebSoundEngine.Pump();
		if (Game.Sound.MusicPlaying || Game.Sound.MusicSeekPosition != before || sink.Chunks != chunks)
			throw new Exception("Music pause must freeze the clock and PCM pump");
		Ui.Command("{\"cmd\":\"music-play\"}");
		Thread.Sleep(80);
		if (!Game.Sound.MusicPlaying || Game.Sound.MusicSeekPosition < before + .04f) throw new Exception("Resume failed");
		WebSoundEngine.PauseAll(true);
		before = Game.Sound.MusicSeekPosition;
		Thread.Sleep(80);
		if (Game.Sound.MusicSeekPosition != before) throw new Exception("Match pause must freeze music completion");
		WebSoundEngine.PauseAll(false);
		Ui.Command("{\"cmd\":\"music-next\"}");
		if (Game.Sound.CurrentMusic?.Filename != tracks[1]) throw new Exception("Next track failed");
		Ui.Command("{\"cmd\":\"music-previous\"}");
		if (Game.Sound.CurrentMusic?.Filename != tracks[0]) throw new Exception("Previous track failed");
		Ui.Command(JsonSerializer.Serialize(new { cmd = "music-play", id = tracks[^1] }));
		Ui.Command("{\"cmd\":\"music-next\"}");
		if (Game.Sound.CurrentMusic?.Filename != tracks[0]) throw new Exception("Playlist must wrap");
		Console.WriteLine(JsonSerializer.Serialize(new { passed = true, tracks = tracks.Length, chunks = sink.Chunks, pauses = sink.Pauses }));
		return 0;
	}
}
