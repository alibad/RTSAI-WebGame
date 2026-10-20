using System;
using System.Collections.Generic;
using System.Linq;
using OpenRA;
using OpenRA.Activities;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Orders;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    public sealed class OriginalRa2GarrisonInfo : TraitInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2Garrison(
            init.Self.World.Players.FirstOrDefault(p => p.InternalName == "Neutral") ?? init.Self.Owner);
    }
    public sealed class OriginalRa2Garrison : INotifyDamage, INotifyPassengerExited
    {
        readonly Player neutral;
        public OriginalRa2Garrison(Player neutral) { this.neutral = neutral; }
        public bool CanEnter(Actor self, Actor infantry) => OriginalRa2Rules.Country(infantry.Owner) &&
            (infantry.Info.Name is "e1" or "e2") && self.Trait<Health>().DamageState < DamageState.Heavy &&
            (self.Owner == neutral || self.Owner == infantry.Owner) && self.Trait<Cargo>().HasSpace(1);
        public void Enter(Actor self, Actor infantry)
        {
            if (!CanEnter(self, infantry)) return;
            self.World.AddFrameEndTask(w =>
            {
                if (!OriginalRa2Rules.Alive(self) || !OriginalRa2Rules.Alive(infantry) || !CanEnter(self, infantry)) return;
                if (self.Owner != infantry.Owner) self.ChangeOwner(infantry.Owner);
                self.Trait<Cargo>().Load(self, infantry);
                w.Remove(infantry);
            });
        }
        void INotifyDamage.Damaged(Actor self, AttackInfo info)
        {
            if (self.IsDead || self.Trait<Health>().DamageState < DamageState.Heavy) return;
            self.World.AddFrameEndTask(w =>
            {
                if (!OriginalRa2Rules.Alive(self)) return;
                var cargo = self.Trait<Cargo>();
                while (!cargo.IsEmpty())
                {
                    var passenger = cargo.Peek();
                    var mobile = passenger.Trait<Mobile>();
                    var cells = w.Map.FindTilesInCircle(self.Location, 8).Where(c => mobile.CanEnterCell(c)).ToArray();
                    if (cells.Length == 0) break;
                    cargo.Unload(self);
                    mobile.SetPosition(passenger, cells[0]);
                    passenger.Trait<Passenger>().OnBeforeAddedToWorld(passenger);
                    w.Add(passenger);
                }
            });
        }
        void INotifyPassengerExited.OnPassengerExited(Actor self, Actor passenger)
        {
            self.World.AddFrameEndTask(w =>
            {
                if (OriginalRa2Rules.Alive(self) && self.Trait<Cargo>().IsEmpty() && self.Owner != neutral)
                    self.ChangeOwner(neutral);
            });
        }
    }
    public sealed class OriginalRa2GarrisonOrderInfo : TraitInfo
    {
        public override object Create(ActorInitializer init) => new OriginalRa2GarrisonOrder();
    }
    public sealed class OriginalRa2GarrisonOrder : IIssueOrder, IResolveOrder
    {
        public IEnumerable<IOrderTargeter> Orders { get { yield return new GarrisonTargeter(); } }
        public Order IssueOrder(Actor self, IOrderTargeter order, in Target target, bool queued) => new(order.OrderID, self, target, queued);
        public void ResolveOrder(Actor self, Order order)
        {
            if (order.OrderString != "OriginalGarrison" || order.Target.Type != TargetType.Actor) return;
            var building = order.Target.Actor;
            self.QueueActivity(order.Queued, self.Trait<IMove>().MoveWithinRange(order.Target, WDist.FromCells(1)));
            self.QueueActivity(new CallFunc(() =>
            {
                if (OriginalRa2Rules.Alive(building) && order.Target.IsInRange(self.CenterPosition, WDist.FromCells(2)))
                    building.TraitOrDefault<OriginalRa2Garrison>()?.Enter(building, self);
            }));
        }
        sealed class GarrisonTargeter : UnitOrderTargeter
        {
            public GarrisonTargeter() : base("OriginalGarrison", 12, "enter", true, true) { }
            public override bool CanTargetActor(Actor self, Actor target, TargetModifiers modifiers, ref string cursor) =>
                target.TraitOrDefault<OriginalRa2Garrison>()?.CanEnter(target, self) == true;
            public override bool CanTargetFrozenActor(Actor self, FrozenActor target, TargetModifiers modifiers, ref string cursor) => false;
        }
    }
}
