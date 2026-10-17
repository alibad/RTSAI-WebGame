using System;
using System.Collections.Generic;
using System.Collections.Frozen;
using OpenRA.GameRules;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Cnc.Traits.Render;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	// Original-country labels are restored by the content rules. Modern factions retain
	// their standalone names for the same shared superweapon actors and powers.
	public sealed class OriginalCountryLabelsInfo : TraitInfo
	{
		public readonly FrozenSet<string> Factions = FrozenSet<string>.Empty;
		public readonly FrozenDictionary<string, string> ModernActors = FrozenDictionary<string, string>.Empty;
		public readonly FrozenDictionary<string, string> ModernPowers = FrozenDictionary<string, string>.Empty;
		public override object Create(ActorInitializer init) => new OriginalCountryLabels();
	}
	public sealed class OriginalCountryLabels { }

	// RA2's missile-spawn weapons create real aircraft: AA can destroy them before impact.
	// Never represent these as an instant damage warhead or an invulnerable decorative sprite.
	public sealed class OriginalRa2RocketInfo : IProjectileInfo
	{
		public readonly string Actor = "v3rocket";
		public IProjectile Create(ProjectileArgs args)
		{
			args.SourceActor.World.AddFrameEndTask(world =>
			{
				var rocket = world.CreateActor(Actor, new TypeDictionary {
					new OwnerInit(args.SourceActor.Owner), new CenterPositionInit(args.Source), new FacingInit(args.Facing)
				});
				rocket.Trait<OriginalRa2RocketFlight>().Launch(rocket, args);
			});
			return null;
		}
	}

	public sealed class OriginalRa2RocketFlightInfo : TraitInfo, Requires<AircraftInfo>
	{
		public readonly int PauseFrames = 0;
		public readonly int TiltFrames = 60;
		public readonly int InitialPitch = 54;
		public readonly int FinalPitch = 128;
		public readonly int TurnRate = 13;
		public readonly int Acceleration = 6;
		public readonly int MaximumSpeed = 225;
		public readonly int Altitude = 3072;
		public readonly bool LazyCurve = true;
		public override object Create(ActorInitializer init) => new OriginalRa2RocketFlight(this);
	}

	public sealed class OriginalRa2RocketFlight : ITick, ISync
	{
		readonly OriginalRa2RocketFlightInfo info;
		ProjectileArgs args;
		Aircraft aircraft;
		WPos start;
		WPos destination;
		[VerifySync] int age;
		[VerifySync] int speed;
		[VerifySync] int pitch;
		[VerifySync] bool cruising;
		public int FlightAge => age;
		public bool Launched => args != null;
		public OriginalRa2RocketFlight(OriginalRa2RocketFlightInfo info) { this.info = info; }

		public void Launch(Actor self, ProjectileArgs launch)
		{
			args = launch;
			aircraft = self.Trait<Aircraft>();
			start = launch.Source;
			destination = launch.PassiveTarget; // Ballistic, fixed aim point, like the original missile-spawn weapons.
			pitch = info.InitialPitch;
			aircraft.Pitch = new WAngle(pitch);
			self.CancelActivity();
		}

		void ITick.Tick(Actor self)
		{
			if (args == null || self.IsDead) return;
			age++;
			if (age <= info.PauseFrames + info.TiltFrames && (args.SourceActor.IsDead || !args.SourceActor.IsInWorld))
			{
				self.Dispose();
				return;
			}
			if (age <= info.PauseFrames) return;
			if (age <= info.PauseFrames + info.TiltFrames)
			{
				pitch = info.InitialPitch + (info.FinalPitch - info.InitialPitch) * (age - info.PauseFrames) / info.TiltFrames;
				aircraft.Pitch = new WAngle(pitch);
				return;
			}

			speed = Math.Min(info.MaximumSpeed, speed + info.Acceleration);
			var pos = self.CenterPosition;
			var remaining = destination - pos;
			var horizontal = remaining.HorizontalLength;
			var traveled = (pos - start).HorizontalLength;
			// V3 climbs in a broad curve; the faster naval missile turns more tightly.
			var cruiseAltitude = Math.Min(info.Altitude, (destination - start).HorizontalLength / 3);
			cruising |= pos.Z - start.Z >= cruiseAltitude;
			var descending = cruising && horizontal < (info.LazyCurve ? cruiseAltitude * 2 : cruiseAltitude);
			var desiredPitch = descending ? OpenRA.Mods.Common.Util.GetVerticalAngle(pos, destination).Angle :
				!cruising ? info.FinalPitch : 0;
			if (desiredPitch > 512) desiredPitch -= 1024;
			pitch += Math.Clamp(desiredPitch - pitch, -info.TurnRate, info.TurnRate);
			aircraft.Facing = remaining.Yaw;
			aircraft.Pitch = new WAngle(pitch);
			var direction = new WVec(0, -speed, 0)
				.Rotate(new WRot(new WAngle(pitch), WAngle.Zero, WAngle.Zero))
				.Rotate(WRot.FromYaw(aircraft.Facing));
			// Keep the rise/turn deterministic and prevent overshooting the fixed aim point.
			var next = pos + direction;
			if ((horizontal <= Math.Max(speed, 128) && Math.Abs(remaining.Z) <= Math.Max(speed, 128)) ||
				(traveled > 1024 && self.World.Map.DistanceAboveTerrain(next).Length <= 0) || age > 2500)
			{
				var impact = horizontal <= Math.Max(speed, 128) ? destination : next;
				args.Weapon.Impact(Target.FromPos(impact), new WarheadArgs(args) {
					ImpactPosition = impact, ImpactOrientation = self.Orientation
				});
				self.Dispose();
				return;
			}
			aircraft.SetPosition(self, next);
		}
	}

	public sealed class WithOriginalLauncherBodyInfo : WithVoxelBodyInfo
	{
		public readonly string EmptySequence = "empty";
		public readonly int RegenerationTicks = 400;
		public readonly string ReloadingCondition = "rocket-reloading";
		public override object Create(ActorInitializer init) => new WithOriginalLauncherBody(init.Self, this);
	}

	public sealed class WithOriginalLauncherBody : ConditionalTrait<WithOriginalLauncherBodyInfo>, INotifyAttack, ITick, IAutoMouseBounds
	{
		readonly ModelAnimation loadedModel;
		readonly RenderVoxels voxels;
		int remaining;
		int token = Actor.InvalidConditionToken;
		public bool Loaded => remaining == 0;
		public WithOriginalLauncherBody(Actor self, WithOriginalLauncherBodyInfo info) : base(info)
		{
			var body = self.Trait<BodyOrientation>();
			voxels = self.Trait<RenderVoxels>();
			foreach (var empty in new[] { false, true })
			{
				var model = voxels.Renderer.ModelCache.GetModelSequence(voxels.Image, empty ? info.EmptySequence : info.Sequence);
				var animation = new ModelAnimation(model, () => WVec.Zero, () => body.QuantizeOrientation(self.Orientation),
					() => IsTraitDisabled || (empty ? Loaded : !Loaded), () => 0, info.ShowShadow);
				if (!empty) loadedModel = animation;
				voxels.Add(animation);
			}
		}
		Rectangle IAutoMouseBounds.AutoMouseoverBounds(Actor self, WorldRenderer renderer) =>
			loadedModel.ScreenBounds(self.CenterPosition, renderer, voxels.Info.Scale);
		void INotifyAttack.Attacking(Actor self, in Target target, Armament armament, Barrel barrel)
		{
			if (IsTraitDisabled) return;
			remaining = Info.RegenerationTicks;
			if (token == Actor.InvalidConditionToken && !string.IsNullOrEmpty(Info.ReloadingCondition))
				token = self.GrantCondition(Info.ReloadingCondition);
		}
		void INotifyAttack.PreparingAttack(Actor self, in Target target, Armament armament, Barrel barrel) { }
		void ITick.Tick(Actor self)
		{
			if (remaining > 0 && --remaining == 0 && token != Actor.InvalidConditionToken)
				token = self.RevokeCondition(token);
		}
	}
}
