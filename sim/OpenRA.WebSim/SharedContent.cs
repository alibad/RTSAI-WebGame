using System.IO;
using System.Linq;
using System.Text.Json;

namespace OpenRA.WebSim
{
	/// <summary>Identity of the same reviewed content revision used by the desktop.
	/// Unit prices still come from the loaded map rules, never from this metadata.
	/// </summary>
	public static class SharedContent
	{
		public static string Revision()
		{
			if (!SimHost.ModData.DefaultFileSystem.TryOpen("ra2|shared-content/manifest.json", out var stream))
				return null;
			using (stream)
			using (var doc = JsonDocument.Parse(stream))
			{
				if (!doc.RootElement.GetProperty("targets").EnumerateObject()
					.Any(t => t.Value.GetProperty("mod").GetString() == SimHost.ModId))
					throw new InvalidDataException("Shared content does not describe this mod");
				return doc.RootElement.GetProperty("revision").GetString();
			}
		}
	}
}
