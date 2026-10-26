using OpenRA.Mods.Cnc.Traits;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    public sealed class OriginalRa2ResourcePurifierInfo : ResourcePurifierInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2ResourcePurifier(this);
    }

    // Keep the existing resource callback and display behavior, but require
    // electrical power for original-country owners. Reevaluate the current
    // owner on every delivery so capture cannot retain the prior power policy.
    public sealed class OriginalRa2ResourcePurifier : ConditionalTrait<ResourcePurifierInfo>,
        INotifyResourceAccepted, ITick, INotifyOwnerChanged
    {
        readonly int[] modifier;
        PlayerResources resources;
        int displayTicks, displayValue;

        public OriginalRa2ResourcePurifier(ResourcePurifierInfo info) : base(info)
        {
            modifier = [info.Modifier];
            displayTicks = info.TickRate;
        }

        protected override void Created(Actor self)
        {
            resources = self.Owner.PlayerActor.Trait<PlayerResources>();
            base.Created(self);
        }

        void INotifyResourceAccepted.OnResourceAccepted(Actor self, Actor refinery, string resourceType, int count, int value)
        {
            if (IsTraitDisabled || (OriginalRa2Rules.Country(self.Owner) &&
                self.Owner.PlayerActor.Trait<PowerManager>().PowerState != PowerState.Normal))
                return;

            var cash = OpenRA.Mods.Common.Util.ApplyPercentageModifiers(value, modifier);
            resources.GiveCash(cash);
            if (Info.ShowTicks && self.Info.HasTraitInfo<IOccupySpaceInfo>())
                displayValue += cash;
        }

        void ITick.Tick(Actor self)
        {
            if (displayValue <= 0 || --displayTicks > 0)
                return;
            var value = displayValue;
            if (self.Owner.IsAlliedWith(self.World.RenderPlayer))
                self.World.AddFrameEndTask(w => w.Add(new FloatingText(self.CenterPosition,
                    self.OwnerColor(), FloatingText.FormatCashTick(value), Info.TickLifetime)));
            displayTicks = Info.TickRate;
            displayValue = 0;
        }

        void INotifyOwnerChanged.OnOwnerChanged(Actor self, Player oldOwner, Player newOwner)
        {
            resources = newOwner.PlayerActor.Trait<PlayerResources>();
            displayTicks = Info.TickRate;
            displayValue = 0;
        }
    }
}
