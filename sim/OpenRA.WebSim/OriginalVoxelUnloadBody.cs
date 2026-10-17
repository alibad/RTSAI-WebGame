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
using System.Collections.Frozen;
using System.Collections.Generic;
using OpenRA.Graphics;
using OpenRA.Mods.Cnc.Traits.Render;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	// The stock voxel dock body has no condition. Keep its immediate dock callbacks,
	// but condition the two models so modern factions can retain their sprite body.
	public sealed class WithOriginalVoxelUnloadBodyInfo : ConditionalTraitInfo,
		IRenderActorPreviewVoxelsInfo, Requires<RenderVoxelsInfo>
	{
		public readonly string IdleSequence = "idle";
		public readonly string UnloadSequence = "unload";
		public readonly bool ShowShadow = true;

		public override object Create(ActorInitializer init) => new WithOriginalVoxelUnloadBody(init.Self, this);

		public IEnumerable<ModelAnimation> RenderPreviewVoxels(IModelCache cache,
			ActorPreviewInitializer init, RenderVoxelsInfo rv, string image, Func<WRot> orientation,
			int facings, PaletteReference palette)
		{
			var body = init.Actor.TraitInfo<BodyOrientationInfo>();
			yield return new ModelAnimation(cache.GetModelSequence(image, IdleSequence), () => WVec.Zero,
				() => body.QuantizeOrientation(orientation(), facings), () => false, () => 0, ShowShadow);
		}
	}

	public sealed class WithOriginalVoxelUnloadBody : ConditionalTrait<WithOriginalVoxelUnloadBodyInfo>,
		IAutoMouseBounds, IDockClientBody
	{
		readonly ModelAnimation idle;
		readonly RenderVoxels voxels;
		public bool Docked { get; private set; }
		public string VisibleSequence => IsTraitDisabled ? null : Docked ? Info.UnloadSequence : Info.IdleSequence;

		public WithOriginalVoxelUnloadBody(Actor self, WithOriginalVoxelUnloadBodyInfo info) : base(info)
		{
			var body = self.Trait<BodyOrientation>();
			voxels = self.Trait<RenderVoxels>();
			idle = new ModelAnimation(voxels.Renderer.ModelCache.GetModelSequence(voxels.Image, info.IdleSequence),
				() => WVec.Zero, () => body.QuantizeOrientation(self.Orientation),
				() => IsTraitDisabled || Docked, () => 0, info.ShowShadow);
			voxels.Add(idle);
			voxels.Add(new ModelAnimation(voxels.Renderer.ModelCache.GetModelSequence(voxels.Image, info.UnloadSequence),
				() => WVec.Zero, () => body.QuantizeOrientation(self.Orientation),
				() => IsTraitDisabled || !Docked, () => 0, info.ShowShadow));
		}

		void IDockClientBody.PlayDockAnimation(Actor self, Action after)
		{
			Docked = true;
			after();
		}

		void IDockClientBody.PlayReverseDockAnimation(Actor self, Action after)
		{
			Docked = false;
			after();
		}

		Rectangle IAutoMouseBounds.AutoMouseoverBounds(Actor self, WorldRenderer renderer) =>
			idle.ScreenBounds(self.CenterPosition, renderer, voxels.Info.Scale);
	}

	// UI-only mapping, generated alongside the original sequences. The absence of this
	// trait leaves Classic and project-only bundles on their existing icons.
	public sealed class FactionSupportPowerIconsInfo : TraitInfo
	{
		public readonly FrozenSet<string> Factions = FrozenSet<string>.Empty;
		public readonly string SourceImage = "icon";
		public readonly string Image = "ea-icon";
		public readonly string Palette = "eacameo";
		public override object Create(ActorInitializer init) => new FactionSupportPowerIcons();
	}

	public sealed class FactionSupportPowerIcons { }
}
