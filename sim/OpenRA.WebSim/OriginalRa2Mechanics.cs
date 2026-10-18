using System;
using System.Collections.Generic;
using System.Collections.Frozen;
using System.Linq;
using OpenRA;
using OpenRA.GameRules;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Orders;
using OpenRA.Mods.Common.Projectiles;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Cnc.Activities;
using OpenRA.Mods.RA2.Projectiles;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    public static class OriginalRa2Rules
    {
        public static bool Country(Player p) => p.PlayerActor.Info.TraitInfoOrDefault<OriginalCountryLabelsInfo>()?.Factions.Contains(p.Faction.InternalName) == true;
        public static bool Alive(Actor a) => a != null && !a.Disposed && !a.IsDead && a.IsInWorld;
        // A separate immutable trait-info instance per actor preserves shared modern actors.
        public static T Set<T>(T info, string field, object value)
        {
            typeof(T).GetField(field).SetValue(info, value);
            return info;
        }
    }

    public sealed class OriginalRa2ExperienceInfo : GainsExperienceInfo
    {
        public readonly bool OriginalTrainable = true;
        public override object Create(ActorInitializer init)
        {
            var copy = (GainsExperienceInfo)MemberwiseClone();
            if (OriginalRa2Rules.Country(init.Self.Owner))
                OriginalRa2Rules.Set(copy, nameof(Conditions), OriginalTrainable
                    ? new Dictionary<int, string> { [300] = "rank-veteran", [600] = "rank-elite" }.ToFrozenDictionary()
                    : FrozenDictionary<int, string>.Empty);
            return new GainsExperience(init, copy);
        }
    }
    public sealed class OriginalRa2BuildingRepairInfo : RepairableBuildingInfo
    {
        public readonly int OriginalPercent = 15;
        public readonly int OriginalStep = 8;
        public override object Create(ActorInitializer init)
        {
            var copy = (RepairableBuildingInfo)MemberwiseClone();
            if (OriginalRa2Rules.Country(init.Self.Owner))
            {
                OriginalRa2Rules.Set(copy, nameof(RepairPercent), OriginalPercent);
                OriginalRa2Rules.Set(copy, nameof(RepairStep), OriginalStep);
            }
            return new RepairableBuilding(init.Self, copy);
        }
    }
    public sealed class OriginalRa2UnitRepairInfo : RepairsUnitsInfo
    {
        public readonly int OriginalPercent = 15;
        public override object Create(ActorInitializer init)
        {
            var copy = (RepairsUnitsInfo)MemberwiseClone();
            if (OriginalRa2Rules.Country(init.Self.Owner))
                OriginalRa2Rules.Set(copy, nameof(ValuePercentage), OriginalPercent);
            return new RepairsUnits(copy);
        }
    }

    public sealed class OriginalRa2TargetInfo : TraitInfo
    {
        public readonly bool Organic = false;
        public override object Create(ActorInitializer init) => new OriginalRa2Target(this);
    }

    // State stays with the victim: damage follows a moving bomb carrier, and parasites
    // remain inside it rather than dealing a disguised infantry-only melee attack.
    public sealed class OriginalRa2Target : ITick, IResolveOrder, INotifyKilled, INotifyAttack, INotifyDamage
    {
        readonly OriginalRa2TargetInfo info;
        public readonly List<(Actor Source, int Remaining, string Weapon)> Bombs = [];
        public Actor TemporalTarget;
        public Actor TemporalSource { get; private set; }
        public Actor Parasite { get; private set; }
        public bool Squid { get; private set; }
        public bool Organic => info.Organic;
        public bool HasBomb => Bombs.Count > 0;
        public int TemporalProgress { get; private set; }
        public int PrismCooldown;
        int temporalRate, temporalToken = Actor.InvalidConditionToken;
        int temporalRemainder, temporalTicks;
        int parasiteDamage, parasiteInterval, parasiteTicks, squidToken = Actor.InvalidConditionToken;
        int squidDirectionToken = Actor.InvalidConditionToken;
        int prismToken = Actor.InvalidConditionToken;
        public OriginalRa2Target(OriginalRa2TargetInfo info) { this.info = info; }

        public void BeginTemporal(Actor self, Actor source, int rate)
        {
            source.Trait<OriginalRa2Target>().TemporalTarget = self;
            if (TemporalSource != null && TemporalSource != source) return;
            TemporalSource = source;
            temporalRate = rate;
            if (temporalToken == Actor.InvalidConditionToken) temporalToken = self.GrantCondition("retail-temporal");
        }
        void CancelTemporal(Actor self)
        {
            if (temporalToken != Actor.InvalidConditionToken) temporalToken = self.RevokeCondition(temporalToken);
            TemporalSource = null;
            TemporalProgress = 0;
            temporalRemainder = temporalTicks = 0;
        }
        public bool Attach(Actor self, Actor source, bool squid, int damage, int interval)
        {
            if (Parasite != null || !OriginalRa2Rules.Alive(source) || TemporalSource != null) return false;
            Parasite = source; Squid = squid; parasiteDamage = damage;
            parasiteInterval = interval; parasiteTicks = interval;
            if (squid)
            {
                squidToken = self.GrantCondition("retail-squid");
                var direction = ((source.TraitOrDefault<IFacing>()?.Facing.Angle ?? 0) + 64) / 128 % 8;
                squidDirectionToken = self.GrantCondition("retail-squid-" + new[] { "n", "ne", "e", "se", "s", "sw", "w", "nw" }[direction]);
            }
            source.CancelActivity();
            self.World.AddFrameEndTask(w => { if (source.IsInWorld && !source.IsDead) w.Remove(source); });
            return true;
        }
        public void Release(Actor self, bool kill)
        {
            var parasite = Parasite; Parasite = null;
            if (squidToken != Actor.InvalidConditionToken) squidToken = self.RevokeCondition(squidToken);
            if (squidDirectionToken != Actor.InvalidConditionToken) squidDirectionToken = self.RevokeCondition(squidDirectionToken);
            Squid = false;
            if (parasite == null || parasite.Disposed) return;
            self.World.AddFrameEndTask(w =>
            {
                if (parasite.Disposed) return;
                if (kill || parasite.IsDead) { if (!parasite.IsDead) parasite.Kill(self); parasite.Dispose(); return; }
                var mobile = parasite.TraitOrDefault<Mobile>();
                var loc = self.Location;
                if (mobile == null) { parasite.Dispose(); return; }
                var exit = w.Map.FindTilesInCircle(loc, 3).FirstOrDefault(c => mobile.CanEnterCell(c));
                mobile.SetPosition(parasite, exit);
                if (!parasite.IsInWorld) w.Add(parasite);
            });
        }
        public void Defuse() => Bombs.Clear();
        public void AddBomb(Actor source, int delay, string weapon) => Bombs.Add((source, delay, weapon));
        public void Support(Actor self, int duration)
        {
            PrismCooldown = duration;
            if (prismToken == Actor.InvalidConditionToken) prismToken = self.GrantCondition("retail-prism-support");
        }
        void ITick.Tick(Actor self)
        {
            if (PrismCooldown > 0 && --PrismCooldown == 0 && prismToken != Actor.InvalidConditionToken)
                prismToken = self.RevokeCondition(prismToken);
            if (TemporalSource != null)
            {
                var source = TemporalSource;
                var state = source.TraitOrDefault<OriginalRa2Target>();
                if (!OriginalRa2Rules.Alive(source) || state?.TemporalTarget != self || source.CurrentActivity == null ||
                    (source.CenterPosition - self.CenterPosition).HorizontalLength > 6 * 1024)
                    CancelTemporal(self);
                else
                {
                    // Damage is the retail temporal progress per 15 Hz rules frame.
                    // Accumulate fractions to preserve it on the host's 25 Hz clock.
                    temporalRemainder += temporalRate * 15;
                    TemporalProgress += temporalRemainder / 25;
                    temporalRemainder %= 25;
                    if (++temporalTicks % 10 == 0)
                    {
                        var arm = source.TraitsImplementing<Armament>().FirstOrDefault(a => !a.IsTraitDisabled && a.Weapon.Projectile is OriginalRa2ActionInfo action && action.Mode == "Temporal");
                        if (arm != null) OriginalRa2ActionInfo.Beam(source, arm.Weapon, source.CenterPosition, self, []);
                    }
                    if (TemporalProgress >= self.Trait<Health>().MaxHP)
                        self.Kill(source, new BitSet<DamageType>("TemporalDeath"));
                }
            }
            if (Parasite != null)
            {
                if (Parasite.Disposed || Parasite.IsDead) Release(self, true);
                else if (--parasiteTicks <= 0)
                {
                    parasiteTicks = parasiteInterval;
                    self.InflictDamage(Parasite, new Damage(parasiteDamage));
                }
            }
            for (var i = Bombs.Count - 1; i >= 0; i--)
            {
                var bomb = Bombs[i];
                if (bomb.Remaining > 1) { Bombs[i] = (bomb.Source, bomb.Remaining - 1, bomb.Weapon); continue; }
                Bombs.RemoveAt(i);
                self.World.Map.Rules.Weapons[bomb.Weapon].Impact(Target.FromPos(self.CenterPosition), bomb.Source);
            }
        }
        void IResolveOrder.ResolveOrder(Actor self, Order order)
        {
            if (order.OrderString is "Stop" or "Move" or "Scatter" or "Guard" or "AttackMove") TemporalTarget = null;
        }
        void INotifyAttack.Attacking(Actor self, in Target target, Armament armament, Barrel barrel)
        {
            if (TemporalTarget != null && (target.Type != TargetType.Actor || target.Actor != TemporalTarget)) TemporalTarget = null;
        }
        void INotifyAttack.PreparingAttack(Actor self, in Target target, Armament armament, Barrel barrel) { }
        void INotifyKilled.Killed(Actor self, AttackInfo e) { Release(self, false); Bombs.Clear(); }
        void INotifyDamage.Damaged(Actor self, AttackInfo e)
        {
            if (Squid && e.Attacker?.Info.Name == "dlph") Release(self, false);
        }
    }

    public sealed class OriginalRa2ActionInfo : IProjectileInfo
    {
        static readonly RadBeamInfo TemporalBeam = MakeTemporalBeam();
        static RadBeamInfo MakeTemporalBeam()
        {
            var beam = new RadBeamInfo();
            OriginalRa2Rules.Set(beam, nameof(beam.Amplitude), new WDist(476));
            OriginalRa2Rules.Set(beam, nameof(beam.WaveLength), new WDist(384));
            OriginalRa2Rules.Set(beam, nameof(beam.Color), Color.FromArgb(128, 200, 255));
            OriginalRa2Rules.Set(beam, nameof(beam.ZOffset), 2047);
            return beam;
        }
        public readonly string Mode = "Temporal";
        public readonly int Damage = 8;
        public readonly int Interval = 100;
        public readonly int Delay = 750;
        public readonly string Fragment = null;
        public readonly int Count = 5;
        public IProjectile Create(ProjectileArgs args)
        {
            var source = args.SourceActor;
            var target = args.GuidedTarget.Type == TargetType.Actor ? args.GuidedTarget.Actor : null;
            var state = target?.TraitOrDefault<OriginalRa2Target>();
            if (Mode == "Temporal") state?.BeginTemporal(target, source, Damage);
            if (Mode == "Drone" && state?.Organic == true) target.Kill(source);
            else if (Mode == "Drone" || Mode == "Squid") state?.Attach(target, source, Mode == "Squid", Damage, Interval);
            if (Mode == "IvanBomb") state?.AddBomb(source, Delay, "retailivanexplosion");
            if (Mode == "Comet" && target != null)
            {
                var fragment = source.World.Map.Rules.Weapons[Fragment.ToLowerInvariant()];
                var candidates = source.World.FindActorsInCircle(target.CenterPosition, fragment.Range)
                    .Where(a => a != target && a != source && OriginalRa2Rules.Alive(a) && source.Owner.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && fragment.IsValidAgainst(a, source))
                    .OrderBy(a => (a.CenterPosition - target.CenterPosition).HorizontalLengthSquared).ThenBy(a => a.ActorID).Take(Count).ToArray();
                foreach (var victim in candidates)
                    Beam(source, fragment, target.CenterPosition, victim, args.DamageModifiers);
            }
            if (Mode == "PrismTower")
            {
                var support = source.TraitOrDefault<OriginalRa2PrismSupport>();
                var n = support?.Gather(source) ?? 0;
                args.DamageModifiers = args.DamageModifiers.Append(100 + n * (support?.Info.Modifier ?? 150)).ToArray();
            }
            if (Mode is "Drone" or "Squid" or "IvanBomb") return null;
            if (Mode == "Temporal") return TemporalBeam.Create(args);
            var laser = new LaserZapInfo();
            OriginalRa2Rules.Set(laser, nameof(laser.UsePlayerColor), Mode is "PrismTower" or "Comet");
            OriginalRa2Rules.Set(laser, nameof(laser.Width), new WDist(Mode == "PrismTower" ? 70 : 50));
            OriginalRa2Rules.Set(laser, nameof(laser.Duration), 15);
            OriginalRa2Rules.Set(laser, nameof(laser.ZOffset), 2047);
            return laser.Create(args);
        }
        internal static void Beam(Actor source, WeaponInfo weapon, WPos start, Actor target, int[] modifiers)
        {
            var args = new ProjectileArgs { SourceActor = source, Source = start, CurrentSource = () => start,
                GuidedTarget = Target.FromActor(target), PassiveTarget = target.CenterPosition,
                CurrentMuzzleFacing = () => WAngle.Zero, Facing = WAngle.Zero, Weapon = weapon,
                DamageModifiers = modifiers ?? [], InaccuracyModifiers = [], RangeModifiers = [] };
            var laser = OriginalRa2Rules.Set(new LaserZapInfo(), nameof(LaserZapInfo.UsePlayerColor), true);
            var beam = weapon.Projectile?.Create(args) ?? laser.Create(args);
            source.World.AddFrameEndTask(w => w.Add(beam));
        }
    }

    public sealed class OriginalRa2PrismSupportInfo : TraitInfo
    {
        public readonly WDist Range = WDist.FromCells(8);
        public readonly int MaxSupporters = 8;
        public readonly int Modifier = 150;
        public readonly int Cooldown = 100;
        public override object Create(ActorInitializer init) => new OriginalRa2PrismSupport(this);
    }
    public sealed class OriginalRa2PrismSupport
    {
        public readonly OriginalRa2PrismSupportInfo Info;
        public OriginalRa2PrismSupport(OriginalRa2PrismSupportInfo info) { Info = info; }
        public int Gather(Actor source)
        {
            var seen = new HashSet<Actor> { source }; var network = new Queue<Actor>(); network.Enqueue(source);
            var weapon = source.World.Map.Rules.Weapons["ea-retail-prismsupport"];
            while (network.Count > 0 && seen.Count <= Info.MaxSupporters)
            {
                var node = network.Dequeue();
                foreach (var donor in source.World.FindActorsInCircle(node.CenterPosition, Info.Range)
                    .Where(a => a.Owner == source.Owner && a.Info.Name == "atesla" && !seen.Contains(a) && OriginalRa2Rules.Alive(a))
                    .OrderBy(a => a.ActorID))
                {
                    if (seen.Count > Info.MaxSupporters) break;
                    var state = donor.Trait<OriginalRa2Target>();
                    if (state.PrismCooldown > 0 || donor.Owner.PlayerActor.Trait<PowerManager>().PowerState != PowerState.Normal) continue;
                    if (!donor.TraitsImplementing<AttackBase>().Any(a => !a.IsTraitDisabled && !a.IsTraitPaused) ||
                        donor.TraitsImplementing<Armament>().Any(a => !a.IsTraitDisabled && a.IsReloading)) continue;
                    state.Support(donor, Info.Cooldown); seen.Add(donor); network.Enqueue(donor);
                    OriginalRa2ActionInfo.Beam(donor, weapon, donor.CenterPosition, node, []);
                }
            }
            return seen.Count - 1;
        }
    }

    public sealed class OriginalRa2IronCurtainPowerInfo : GrantExternalConditionPowerInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2IronCurtainPower(init.Self, this);
    }
    public sealed class OriginalRa2IronCurtainPower : GrantExternalConditionPower
    {
        public OriginalRa2IronCurtainPower(Actor self, OriginalRa2IronCurtainPowerInfo info) : base(self, info) { }
        public override void Activate(Actor self, Order order, SupportPowerManager manager)
        {
            var organic = UnitsInRange(self.World.Map.CellContaining(order.Target.CenterPosition))
                .Where(a => a.TraitOrDefault<OriginalRa2Target>()?.Organic == true).ToArray();
            base.Activate(self, order, manager);
            foreach (var victim in organic) victim.Kill(self);
        }
    }

    public sealed class OriginalRa2ParasiteRemovalInfo : TraitInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2ParasiteRemoval();
    }
    public sealed class OriginalRa2ParasiteRemoval : INotifyResupply
    {
        void INotifyResupply.BeforeResupply(Actor host, Actor target, ResupplyType types) { }
        void INotifyResupply.ResupplyTick(Actor host, Actor target, ResupplyType types)
        {
            if ((types & ResupplyType.Repair) != 0) target.TraitOrDefault<OriginalRa2Target>()?.Release(target, true);
        }
    }

    public sealed class OriginalRa2DefuseInfo : TraitInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2Defuse();
    }
    public sealed class OriginalRa2Defuse : IIssueOrder, IResolveOrder
    {
        public IEnumerable<IOrderTargeter> Orders { get { yield return new BombTargeter(); } }
        public Order IssueOrder(Actor self, IOrderTargeter order, in Target target, bool queued) => new(order.OrderID, self, target, queued);
        public void ResolveOrder(Actor self, Order order)
        {
            if (order.OrderString != "OriginalDefuse" || order.Target.Type != TargetType.Actor) return;
            var victim = order.Target.Actor;
            var move = self.Trait<IMove>();
            self.QueueActivity(order.Queued, move.MoveWithinRange(order.Target, WDist.FromCells(1)));
            self.QueueActivity(new OpenRA.Activities.CallFunc(() =>
            {
                if (OriginalRa2Rules.Alive(victim) && (self.CenterPosition - victim.CenterPosition).HorizontalLength <= 1536)
                    victim.TraitOrDefault<OriginalRa2Target>()?.Defuse();
            }));
        }
        sealed class BombTargeter : UnitOrderTargeter
        {
            public BombTargeter() : base("OriginalDefuse", 10, "goldwrench", true, true) { }
            public override bool CanTargetActor(Actor self, Actor target, TargetModifiers modifiers, ref string cursor) => target.TraitOrDefault<OriginalRa2Target>()?.HasBomb == true;
            public override bool CanTargetFrozenActor(Actor self, FrozenActor target, TargetModifiers modifiers, ref string cursor) => false;
        }
    }

    public sealed class OriginalRa2ChronoMovementInfo : ConditionalTraitInfo
    {
        public readonly int MinimumDelay = 27;
        public readonly int DistanceFactor = 48;
        public override object Create(ActorInitializer init) => new OriginalRa2ChronoMovement(this);
    }
    public sealed class OriginalRa2ChronoMovement : ConditionalTrait<OriginalRa2ChronoMovementInfo>, IResolveOrder, ITick
    {
        int phaseTicks, phaseToken = Actor.InvalidConditionToken;
        public OriginalRa2ChronoMovement(OriginalRa2ChronoMovementInfo info) : base(info) { }
        public void ResolveOrder(Actor self, Order order)
        {
            if (IsTraitDisabled || order.OrderString != "Move" || phaseTicks > 0 || order.Target.Type == TargetType.Invalid) return;
            var to = self.World.Map.CellContaining(order.Target.CenterPosition);
            var mobile = self.Trait<Mobile>();
            if (!self.Owner.Shroud.IsExplored(to) || !mobile.CanEnterCell(to)) return;
            var distance = (self.CenterPosition - self.World.Map.CenterOfCell(to)).HorizontalLength;
            phaseTicks = Math.Max(Info.MinimumDelay, (int)(distance * 256L * 25 / (1024L * Info.DistanceFactor * 15)));
            phaseToken = self.GrantCondition("retail-phase");
            self.World.AddFrameEndTask(w =>
            {
                if (!OriginalRa2Rules.Alive(self)) return;
                self.CancelActivity(); mobile.SetPosition(self, to);
                w.Add(new SpriteEffect(self.CenterPosition, w, "ea-chrono", "warpin", "eaeffect"));
            });
        }
        void ITick.Tick(Actor self)
        {
            if (phaseTicks > 0 && --phaseTicks == 0 && phaseToken != Actor.InvalidConditionToken)
                phaseToken = self.RevokeCondition(phaseToken);
        }
    }
}
