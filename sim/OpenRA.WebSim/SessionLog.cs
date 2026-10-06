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
using System.Linq;
using System.Text;
using System.Text.Json;

namespace OpenRA.WebSim
{
	/// <summary>
	/// A match record: every frame's order packet (OpenRA's own serialized orders) plus the engine's SyncHash
	/// for every net frame. Recorded in the browser, replayed natively, compared hash by hash.
	/// </summary>
	public static class SessionLog
	{
		public static string Write(ScenarioSpec s, WebConnection c)
		{
			var sb = new StringBuilder();
			sb.Append("{\"runtime\":\"").Append(System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription)
				.Append(' ').Append(System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture).Append("\",");
			sb.Append("\"seed\":").Append(s.Seed).Append(",\"map\":\"").Append(s.Map).Append("\",");
			sb.Append("\"hashes\":[").Append(string.Join(",", c.SyncHashes)).Append("],");
			sb.Append("\"packets\":{");
			sb.Append(string.Join(",", c.RecordedPackets.OrderBy(kv => kv.Key).Select(kv => $"\"{kv.Key}\":\"{Convert.ToBase64String(kv.Value)}\"")));
			sb.Append("}}");
			return sb.ToString();
		}

		public static Dictionary<int, byte[]> ReadPackets(string json)
		{
			using var doc = JsonDocument.Parse(json);
			var result = new Dictionary<int, byte[]>();
			foreach (var p in doc.RootElement.GetProperty("packets").EnumerateObject())
				result[int.Parse(p.Name)] = Convert.FromBase64String(p.Value.GetString());

			return result;
		}

		public static List<int> ReadHashes(string json)
		{
			using var doc = JsonDocument.Parse(json);
			return doc.RootElement.GetProperty("hashes").EnumerateArray().Select(e => e.GetInt32()).ToList();
		}
	}
}
