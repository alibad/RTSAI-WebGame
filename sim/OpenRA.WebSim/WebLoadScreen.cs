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

using OpenRA.FileSystem;

namespace OpenRA.WebSim
{
	/// <summary>The page shows its own loading UI, so the engine's load screen hooks are no-ops.</summary>
	public sealed class WebLoadScreen : ILoadScreen
	{
		public void Init(Manifest manifest, IReadOnlyFileSystem fileSystem) { }
		public void Display() { }
		public bool BeforeLoad(ModData modData) => true;
		public void StartGame(Arguments args) { }
		public void Dispose() { }
	}
}
