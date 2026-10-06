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
using System.IO;
using System.Text;

namespace OpenRA.WebSim
{
	/// <summary>
	/// A flat file bundle ("ORAPACK1", count, then path + bytes per file) unpacked into the virtual file system.
	/// The same bytes are unpacked natively, so both runtimes read identical inputs.
	/// </summary>
	public static class Pack
	{
		static readonly byte[] Magic = "ORAPACK1"u8.ToArray();

		public static int Unpack(ReadOnlySpan<byte> pack, string root)
		{
			if (pack.Length < 12 || !pack[..8].SequenceEqual(Magic))
				throw new InvalidDataException("Not an ORAPACK1 bundle.");

			var count = BinaryPrimitives.ReadInt32LittleEndian(pack[8..]);
			var p = 12;
			for (var i = 0; i < count; i++)
			{
				var nameLength = BinaryPrimitives.ReadUInt16LittleEndian(pack[p..]);
				p += 2;
				var name = Encoding.UTF8.GetString(pack.Slice(p, nameLength));
				p += nameLength;
				var length = BinaryPrimitives.ReadInt32LittleEndian(pack[p..]);
				p += 4;

				var path = Path.Combine(root, name);
				Directory.CreateDirectory(Path.GetDirectoryName(path));
				using (var f = File.Create(path))
					f.Write(pack.Slice(p, length));

				p += length;
			}

			return count;
		}

		public sealed class Writer : IDisposable
		{
			readonly Stream output;
			readonly long countPosition;
			int count;

			public Writer(Stream output)
			{
				this.output = output;
				output.Write(Magic);
				countPosition = output.Position;
				output.Write(new byte[4]);
			}

			public void Add(string name, ReadOnlySpan<byte> data)
			{
				var nameBytes = Encoding.UTF8.GetBytes(name.Replace('\\', '/'));
				Span<byte> header = stackalloc byte[2];
				BinaryPrimitives.WriteUInt16LittleEndian(header, (ushort)nameBytes.Length);
				output.Write(header);
				output.Write(nameBytes);
				Span<byte> len = stackalloc byte[4];
				BinaryPrimitives.WriteInt32LittleEndian(len, data.Length);
				output.Write(len);
				output.Write(data);
				count++;
			}

			public void Dispose()
			{
				var end = output.Position;
				output.Position = countPosition;
				Span<byte> c = stackalloc byte[4];
				BinaryPrimitives.WriteInt32LittleEndian(c, count);
				output.Write(c);
				output.Position = end;
			}
		}
	}
}
