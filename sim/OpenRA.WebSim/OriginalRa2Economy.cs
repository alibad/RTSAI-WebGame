using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    public sealed class OriginalRa2EconomyInfo : TraitInfo
    {
        public readonly int QueueTimeModifier = 175;
        public readonly int MultipleFactoryPercent = 80;
        public readonly int MinLowPowerPercent = 50;
        public readonly int MaxLowPowerPercent = 80;
        public readonly int LowPowerPenaltyPercent = 100;
        public readonly int WallTimePercent = 300;
        public readonly string[] Walls = ["gawall", "nawall"];
        public override object Create(ActorInitializer init) => new object();
    }

    // Queue infos belong to the ruleset. Clone before changing them: another player
    // in the same match may use the modern balance or a retained Classic profile.
    public sealed class OriginalRa2ProductionQueueInfo : ClassicProductionQueueInfo
    {
        public override object Create(ActorInitializer init)
        {
            var labels = init.Self.Info.TraitInfoOrDefault<OriginalCountryLabelsInfo>();
            var economy = init.Self.Info.TraitInfoOrDefault<OriginalRa2EconomyInfo>();
            if (economy == null || labels?.Factions.Contains(init.Self.Owner.Faction.InternalName) != true)
                return new ClassicProductionQueue(init, this);

            var copy = (ClassicProductionQueueInfo)MemberwiseClone();
            OriginalRa2Rules.Set(copy, nameof(BuildDurationModifier), economy.QueueTimeModifier);
            OriginalRa2Rules.Set(copy, nameof(SpeedUp), false);
            OriginalRa2Rules.Set(copy, nameof(LowPowerModifier), 100);
            return new OriginalRa2ProductionQueue(init, copy, economy);
        }
    }

    public sealed class OriginalRa2ProductionQueue : ClassicProductionQueue
    {
        const int Scale = 1000000;
        readonly OriginalRa2EconomyInfo economy;
        [VerifySync] int productionCredit;

        public OriginalRa2ProductionQueue(ActorInitializer init, ClassicProductionQueueInfo info, OriginalRa2EconomyInfo economy)
            : base(init, info) { this.economy = economy; }

        public int ProductionRate
        {
            get
            {
                if (playerPower == null || playerPower.PowerState == PowerState.Normal)
                    return Scale;
                var drain = Math.Max(1, playerPower.PowerDrained);
                var shortage = Math.Max(0, drain - playerPower.PowerProvided);
                var rate = Scale - (long)shortage * Scale * economy.LowPowerPenaltyPercent / (100L * drain);
                return (int)Math.Clamp(rate, economy.MinLowPowerPercent * (Scale / 100), economy.MaxLowPowerPercent * (Scale / 100));
            }
        }

        protected override void TickInner(Actor self, bool allProductionPaused)
        {
            // Keep cancellation, availability, payment and pauses in the engine's
            // queue. Only throttle its progress ticks, with deterministic credit.
            if (allProductionPaused || Queue.Count == 0 || Queue[0].Paused || Queue[0].Done)
            {
                productionCredit = 0;
                base.TickInner(self, allProductionPaused);
                return;
            }
            productionCredit += ProductionRate;
            var advance = productionCredit >= Scale;
            if (advance) productionCredit -= Scale;
            base.TickInner(self, !advance);
        }

        public override int GetBuildTime(ActorInfo unit, BuildableInfo bi)
        {
            var time = base.GetBuildTime(unit, bi);
            if (developerMode.FastBuild) return time;
            if (economy.Walls.Contains(unit.Name)) time = time * economy.WallTimePercent / 100;
            var type = bi.BuildAtProductionType ?? Info.Type;
            var count = Actor.World.ActorsWithTrait<Production>().Count(p => p.Actor.Owner == Actor.Owner
                && !p.Trait.IsTraitDisabled && !p.Trait.IsTraitPaused && p.Trait.Info.Produces.Contains(type));
            // Apply the cumulative multiplier before rounding once. There is no
            // seven-factory table/cap in the original rule.
            decimal scaled = time;
            for (var i = 1; i < count; i++) scaled = scaled * economy.MultipleFactoryPercent / 100;
            return Math.Max(1, (int)scaled);
        }

        public override int RemainingTimeActual(ProductionItem item) =>
            (int)(((long)item.RemainingTime * Scale + ProductionRate - 1) / ProductionRate);
    }

    public sealed class OriginalRa2CashTricklerInfo : CashTricklerInfo
    {
        public readonly int RetailIntervalFrames = 100;
        public override object Create(ActorInitializer init) => init.Self.Info.Name == "caoild"
            ? new OriginalRa2OilIncome(init, this) : base.Create(init);
    }

    public sealed class OriginalRa2OilIncome : CashTrickler, ITick
    {
        readonly OriginalRa2CashTricklerInfo info;
        Player previousOwner;
        [VerifySync] int retailCredit;
        [VerifySync] int modernTicks;

        public OriginalRa2OilIncome(ActorInitializer init, OriginalRa2CashTricklerInfo info) : base(info)
        { this.info = info; previousOwner = init.Self.Owner; modernTicks = info.InitialDelay; }

        void ITick.Tick(Actor self)
        {
            if (previousOwner != self.Owner) { previousOwner = self.Owner; retailCredit = 0; }
            if (IsTraitDisabled) { retailCredit = 0; modernTicks = info.Interval; }
            if (IsTraitPaused || IsTraitDisabled) return;
            if (OriginalRa2Rules.Country(self.Owner))
            {
                retailCredit += 15;
                if (retailCredit < info.RetailIntervalFrames * 25) return;
                retailCredit -= info.RetailIntervalFrames * 25;
            }
            else
            {
                if (--modernTicks >= 0) return;
                modernTicks = info.Interval;
            }
            ModifyCash(self, Util.ApplyPercentageModifiers(info.Amount,
                self.TraitsImplementing<ICashTricklerModifier>().Select(m => m.GetCashTricklerModifier())));
        }
    }

    // The engine's infiltration infos are internal/sealed. The factory maps their
    // YAML names to these compatible infos; the attacking spy's owner selects the
    // retail effect even when the infiltrated building belongs to a modern side.
    public sealed class OriginalRa2CashInfiltrationInfo : TraitInfo
    {
        public readonly BitSet<TargetableType> Types = default;
        public readonly int Percentage = 50;
        public readonly int Minimum = 0;
        public readonly int Maximum = int.MaxValue;
        public readonly int PlayerExperience = 0;
        public readonly int PlayerExperiencePercentage = 0;
        [NotificationReference("Speech")] public readonly string InfiltratedNotification = null;
        [NotificationReference("Speech")] public readonly string InfiltrationNotification = null;
        [FluentReference(optional: true)] public readonly string InfiltratedTextNotification = null;
        [FluentReference(optional: true)] public readonly string InfiltrationTextNotification = null;
        public readonly bool ShowTicks = true;
        public override object Create(ActorInitializer init) => new OriginalRa2CashInfiltration(this);
    }

    public sealed class OriginalRa2CashInfiltration : INotifyInfiltrated
    {
        readonly OriginalRa2CashInfiltrationInfo info;
        public OriginalRa2CashInfiltration(OriginalRa2CashInfiltrationInfo info) { this.info = info; }
        void INotifyInfiltrated.Infiltrated(Actor self, Actor infiltrator, BitSet<TargetableType> types)
        {
            if (!info.Types.Overlaps(types)) return;
            var victim = self.Owner.PlayerActor.Trait<PlayerResources>();
            var spy = infiltrator.Owner.PlayerActor.Trait<PlayerResources>();
            var retail = OriginalRa2Rules.Country(infiltrator.Owner);
            var amount = Math.Min(info.Maximum, (victim.Cash + victim.Resources) * info.Percentage / 100);
            var minimum = info.Minimum >= 0 ? info.Minimum : infiltrator.Info.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0;
            var payout = retail ? amount : Math.Max(amount, minimum);
            victim.TakeCash(amount);
            spy.GiveCash(payout);
            infiltrator.Owner.PlayerActor.TraitOrDefault<PlayerExperience>()?.GiveExperience(info.PlayerExperience + amount * info.PlayerExperiencePercentage / 100);
            Game.Sound.PlayNotification(self.World.Map.Rules, self.Owner, "Speech", info.InfiltratedNotification, self.Owner.Faction.InternalName);
            Game.Sound.PlayNotification(self.World.Map.Rules, infiltrator.Owner, "Speech", info.InfiltrationNotification, infiltrator.Owner.Faction.InternalName);
            TextNotificationsManager.AddTransientLine(self.Owner, info.InfiltratedTextNotification);
            TextNotificationsManager.AddTransientLine(infiltrator.Owner, info.InfiltrationTextNotification);
            if (info.ShowTicks && payout != 0)
                self.World.AddFrameEndTask(w => w.Add(new FloatingText(self.CenterPosition, infiltrator.OwnerColor(), FloatingText.FormatCashTick(payout), 30)));
        }
    }

    public sealed class OriginalRa2PowerInfiltrationInfo : TraitInfo
    {
        public readonly BitSet<TargetableType> Types = default;
        public readonly int Duration = 500;
        public readonly int RetailDurationFrames = 1000;
        public readonly int PlayerExperience = 0;
        [NotificationReference("Speech")] public readonly string InfiltratedNotification = null;
        [NotificationReference("Speech")] public readonly string InfiltrationNotification = null;
        [FluentReference(optional: true)] public readonly string InfiltratedTextNotification = null;
        [FluentReference(optional: true)] public readonly string InfiltrationTextNotification = null;
        public override object Create(ActorInitializer init) => new OriginalRa2PowerInfiltration(this);
    }

    public sealed class OriginalRa2PowerInfiltration : INotifyInfiltrated
    {
        readonly OriginalRa2PowerInfiltrationInfo info;
        public OriginalRa2PowerInfiltration(OriginalRa2PowerInfiltrationInfo info) { this.info = info; }
        void INotifyInfiltrated.Infiltrated(Actor self, Actor infiltrator, BitSet<TargetableType> types)
        {
            if (!info.Types.Overlaps(types)) return;
            self.Owner.PlayerActor.Trait<PowerManager>().TriggerPowerOutage(OriginalRa2Rules.Country(infiltrator.Owner)
                ? (info.RetailDurationFrames * 25 + 14) / 15 : info.Duration);
            infiltrator.Owner.PlayerActor.TraitOrDefault<PlayerExperience>()?.GiveExperience(info.PlayerExperience);
            Game.Sound.PlayNotification(self.World.Map.Rules, self.Owner, "Speech", info.InfiltratedNotification, self.Owner.Faction.InternalName);
            Game.Sound.PlayNotification(self.World.Map.Rules, infiltrator.Owner, "Speech", info.InfiltrationNotification, infiltrator.Owner.Faction.InternalName);
            TextNotificationsManager.AddTransientLine(self.Owner, info.InfiltratedTextNotification);
            TextNotificationsManager.AddTransientLine(infiltrator.Owner, info.InfiltrationTextNotification);
        }
    }
}
