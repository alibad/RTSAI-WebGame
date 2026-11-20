using System;
using System.Collections.Generic;
using System.Numerics;
using OpenRA;
using OpenRA.GameRules;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
	/// <summary>
	/// Red Alert 2's house-coloured laser (IsLaser, IsHouseColor, LaserDuration 15) for the Prism Tank, the Prism Tower,
	/// the tank's split beams and the towers' support beams: a near-white core inside a wide glow of the owner's colour,
	/// drawn additively so it lights what it crosses, a lens flash at the emitter and a flare where it lands, all fading
	/// over the beam's life. It replaced a 2-3 px flat line (owner, 20 Nov 2026: "like a line that needs to feel like some
	/// sick effect, light effect").
	///
	/// The simulation is LaserZap's, field for field: one impact on the first tick at the (tracked) target, the same two
	/// synced positions and the same lifetime, so a battle plays out and hashes exactly as before; only the drawing
	/// changed. Where the light is drawn may differ from those positions (a support beam runs crystal to crystal, as
	/// RA2's PrismSupportHeight aims it, while its synced end stays the tower's centre).
	/// </summary>
	public sealed class OriginalRa2Laser : IProjectile, ISync
	{
		public enum Style { Tank, Tower, Fragment, Support }

		/// <summary>Screen sizes at 1x, in pixels: core and glow half-widths, flash and flare radii.</summary>
		sealed record Look(float Core, float Glow, float Flash, float Flare, int FlashTicks);
		static readonly Look Tank = new(1.6f, 7.5f, 9f, 13f, 6);
		static readonly Look Tower = new(2.2f, 10f, 13f, 17f, 7);
		static readonly Look Fragment = new(1.1f, 5f, 0f, 9f, 0);
		static readonly Look Support = new(1.2f, 5.5f, 7f, 8f, 5);

		readonly ProjectileArgs args;
		readonly Look look;
		readonly Color color;
		readonly int duration;
		readonly WVec drawFrom, drawTo;
		int ticks;
		int interval;

		[VerifySync]
		WPos target;

		[VerifySync]
		WPos source;

		/// <param name="drawFrom">Added to the source where the light starts (not synced).</param>
		/// <param name="drawTo">Added to the target where the light lands (not synced).</param>
		public OriginalRa2Laser(ProjectileArgs args, Style style, int duration, WVec drawFrom = default, WVec drawTo = default)
		{
			this.args = args;
			this.duration = duration;
			this.drawFrom = drawFrom;
			this.drawTo = drawTo;
			look = style switch { Style.Tower => Tower, Style.Fragment => Fragment, Style.Support => Support, _ => Tank };
			color = args.SourceActor.OwnerColor();
			target = args.PassiveTarget;
			source = args.Source;
		}

		public void Tick(World world)
		{
			// LaserZap with TrackTarget, DamageDuration 1, DamageInterval 1, no inaccuracy, not blockable.
			source = args.CurrentSource();
			if (args.GuidedTarget.IsValidFor(args.SourceActor))
				target = args.Weapon.TargetActorCenter ? args.GuidedTarget.CenterPosition : args.GuidedTarget.Positions.ClosestToIgnoringPath(source);

			if (ticks < 1 && --interval <= 0)
			{
				var warheadArgs = new WarheadArgs(args)
				{
					ImpactOrientation = new WRot(WAngle.Zero, OpenRA.Mods.Common.Util.GetVerticalAngle(source, target), args.CurrentMuzzleFacing()),
					ImpactPosition = target,
				};
				args.Weapon.Impact(Target.FromPos(target), warheadArgs);
				interval = 1;
			}

			if (++ticks >= duration)
				world.AddFrameEndTask(w => w.Remove(this));
		}

		public IEnumerable<IRenderable> Render(WorldRenderer wr)
		{
			if (ticks >= duration || (wr.World.FogObscures(target) && wr.World.FogObscures(source)))
				yield break;

			// Full strength for the first frames, then an ease-out to nothing by the end of its life.
			var life = (float)ticks / duration;
			var strength = ticks < 3 ? 1f : MathF.Pow(1f - (ticks - 3f) / (duration - 3f), 1.6f);
			var flash = look.FlashTicks > 0 && ticks < look.FlashTicks ? 1f - (float)ticks / look.FlashTicks : 0f;
			yield return new LaserLight(source + drawFrom, target + drawTo, color, look, strength, flash, life);
		}

		/// <summary>The whole laser as one renderable, so it sorts above the units it passes (ZOffset as LaserZap's 2047).</summary>
		sealed class LaserLight : IRenderable, IFinalizedRenderable
		{
			readonly WPos from, to;
			readonly Color color;
			readonly Look look;
			readonly float strength, flash, life;

			public LaserLight(WPos from, WPos to, Color color, Look look, float strength, float flash, float life)
			{
				this.from = from;
				this.to = to;
				this.color = color;
				this.look = look;
				this.strength = strength;
				this.flash = flash;
				this.life = life;
			}

			public WPos Pos => from;
			public int ZOffset => 2047;
			public bool IsDecoration => true;
			public IRenderable WithZOffset(int newOffset) => this;
			public IRenderable OffsetBy(in WVec vec) => new LaserLight(from + vec, to + vec, color, look, strength, flash, life);
			public IRenderable AsDecoration() => this;
			public IFinalizedRenderable PrepareRender(WorldRenderer wr) => this;
			public void RenderDebugGeometry(WorldRenderer wr) { }

			public Rectangle ScreenBounds(WorldRenderer wr)
			{
				var a = wr.Screen3DPosition(from);
				var b = wr.Screen3DPosition(to);
				var pad = (int)MathF.Ceiling(Math.Max(look.Glow, Math.Max(look.Flash, look.Flare)) * 2.2f);
				var x = (int)MathF.Min(a.X, b.X) - pad;
				var y = (int)MathF.Min(a.Y, b.Y) - pad;
				return new Rectangle(x, y, (int)MathF.Abs(a.X - b.X) + 2 * pad, (int)MathF.Abs(a.Y - b.Y) + 2 * pad);
			}

			/// <summary>The owner's colour lifted towards white, at an alpha.</summary>
			Color Tint(float toWhite, float alpha)
			{
				int Mix(int c) => (int)Math.Clamp(c + (255 - c) * toWhite, 0, 255);
				return Color.FromArgb((int)Math.Clamp(alpha * 255, 0, 255), Mix(color.R), Mix(color.G), Mix(color.B));
			}

			public void Render(WorldRenderer wr)
			{
				// A batch of its own, before and after: colour quads otherwise share the sprite batch they fall into, and
				// the page skips a whole captured batch when one of that batch's sprite sheets has not reached it yet
				// (a tower's beam vanished while its support beams and hit flare drew, 20 Nov 2026).
				Game.Renderer.Flush();
				var cr = Game.Renderer.WorldRgbaColorRenderer;
				var a = wr.Screen3DPosition(from);
				var b = wr.Screen3DPosition(to);
				var d = new Vector2(b.X - a.X, b.Y - a.Y);
				var length = d.Length();
				if (length > 0.5f)
				{
					d /= length;
					var n = new Vector3(-d.Y, d.X, 0);
					var thin = 0.55f + 0.45f * strength;

					// Wide soft glow, a brighter inner glow, then the white-hot core: each a pair of strips that fade
					// from the beam's centre line to nothing at their edge, added onto what is below.
					Strip(cr, a, b, n, look.Glow * thin, Tint(0.15f, 0.55f * strength), Tint(0.15f, 0f));
					Strip(cr, a, b, n, look.Glow * 0.45f * thin, Tint(0.35f, 0.75f * strength), Tint(0.2f, 0f));
					Strip(cr, a, b, n, look.Core * (0.6f + 0.4f * strength), Tint(0.85f, strength), Tint(0.6f, 0.35f * strength));
				}

				// Lens flash at the emitter: a burst of light with a horizontal streak, gone in a few frames.
				if (flash > 0 && look.Flash > 0)
				{
					Glow(cr, a, look.Flash * (0.7f + 0.3f * flash), Tint(0.7f, 0.9f * flash), Tint(0.2f, 0f));
					Glow(cr, a, look.Flash * 0.35f, Tint(1f, flash), Tint(0.8f, 0f));
					Streak(cr, a, new Vector3(look.Flash * 2.4f * flash, 0, 0), look.Flash * 0.18f, Tint(0.9f, 0.8f * flash), Tint(0.4f, 0f));
					Streak(cr, a, new Vector3(0, look.Flash * 1.1f * flash, 0), look.Flash * 0.14f, Tint(0.9f, 0.6f * flash), Tint(0.4f, 0f));
				}

				// Flare where it lands: brightest on the first frames, shrinking with the beam.
				if (look.Flare > 0)
				{
					var burst = MathF.Max(strength, 0f);
					var r = look.Flare * (0.6f + 0.4f * burst) * (1f + 0.25f * life);
					Glow(cr, b, r, Tint(0.3f, 0.7f * burst), Tint(0.1f, 0f));
					Glow(cr, b, r * 0.38f, Tint(1f, burst), Tint(0.7f, 0f));
					Streak(cr, b, new Vector3(r * 1.5f * burst, 0, 0), r * 0.12f, Tint(0.9f, 0.6f * burst), Tint(0.4f, 0f));
				}

				Game.Renderer.Flush();
			}

			static void Strip(RgbaColorRenderer cr, Vector3 a, Vector3 b, Vector3 n, float half, Color centre, Color edge)
			{
				if (half <= 0.05f || centre.A == 0) return;
				var o = n * half;
				cr.FillRect(a, b, b + o, a + o, centre, centre, edge, edge, BlendMode.Additive);
				cr.FillRect(a, b, b - o, a - o, centre, centre, edge, edge, BlendMode.Additive);
			}

			/// <summary>A round glow: a fan of triangles (quads with two corners at the centre), bright in the middle.</summary>
			static void Glow(RgbaColorRenderer cr, Vector3 c, float radius, Color centre, Color edge)
			{
				if (radius <= 0.1f || centre.A == 0) return;
				const int Segments = 16;
				var prev = c + new Vector3(radius, 0, 0);
				for (var i = 1; i <= Segments; i++)
				{
					var t = i * MathF.Tau / Segments;
					var next = c + new Vector3(MathF.Cos(t) * radius, MathF.Sin(t) * radius * 0.8f, 0);
					cr.FillRect(c, c, next, prev, centre, centre, edge, edge, BlendMode.Additive);
					prev = next;
				}
			}

			static void Streak(RgbaColorRenderer cr, Vector3 c, Vector3 halfLength, float halfWidth, Color centre, Color edge)
			{
				var len = halfLength.Length();
				if (len <= 0.1f || centre.A == 0) return;
				var dir = halfLength / len;
				var n = new Vector3(-dir.Y, dir.X, 0) * halfWidth;
				// Two tapered halves: bright at the centre, nothing at the tips.
				cr.FillRect(c - n, c + n, c + halfLength, c + halfLength, centre, centre, edge, edge, BlendMode.Additive);
				cr.FillRect(c + n, c - n, c - halfLength, c - halfLength, centre, centre, edge, edge, BlendMode.Additive);
			}
		}
	}
}
