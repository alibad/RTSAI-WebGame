using System.Collections.Generic;
using System.Linq;
using OpenRA;
using OpenRA.Graphics;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    public sealed class OriginalRa2PsychicSensorInfo : ConditionalTraitInfo
    {
        public readonly WDist Range = WDist.FromCells(15);
        public override object Create(ActorInitializer init) => new OriginalRa2PsychicSensor(this);
    }
    public sealed class OriginalRa2PsychicSensor : ConditionalTrait<OriginalRa2PsychicSensorInfo>, ITick, IRenderAnnotations
    {
        public OriginalRa2PsychicSensor(OriginalRa2PsychicSensorInfo info) : base(info) { }
        void ITick.Tick(Actor self)
        {
            if (IsTraitDisabled) return;
            foreach (var actor in self.World.FindActorsInCircle(self.CenterPosition, Info.Range))
                if (actor.EffectiveOwner?.Disguised == true && self.Owner.RelationshipWith(actor.Owner) == PlayerRelationship.Enemy &&
                    actor.Info.TraitInfos<TraitInfo>().Any(t => t.GetType().Name == "DisguiseInfo"))
                    foreach (var resolver in actor.TraitsImplementing<IResolveOrder>())
                        resolver.ResolveOrder(actor, new Order("Disguise", actor, Target.FromActor(actor), false));
        }
        public IEnumerable<IRenderable> RenderAnnotations(Actor self, WorldRenderer renderer)
        {
            if (IsTraitDisabled || self.World.RenderPlayer == null || !self.Owner.IsAlliedWith(self.World.RenderPlayer)) yield break;
            foreach (var actor in self.World.Actors)
            {
                if (!OriginalRa2Rules.Alive(actor) || self.Owner.RelationshipWith(actor.Owner) != PlayerRelationship.Enemy || actor.CurrentActivity == null) continue;
                var target = actor.TraitsImplementing<AttackFollow>().Select(a => a.RequestedTarget.Type != TargetType.Invalid ? a.RequestedTarget : a.OpportunityTarget)
                    .FirstOrDefault(t => t.Type != TargetType.Invalid);
                if (target.Type == TargetType.Invalid) target = actor.TraitOrDefault<OriginalRa2Target>()?.AttackIntent ?? Target.Invalid;
                if (!target.IsValidFor(actor) || !target.IsInRange(self.CenterPosition, Info.Range)) continue;
                yield return new LineAnnotationRenderable(actor.CenterPosition, target.CenterPosition, 1, Color.Red);
            }
        }
        public bool SpatiallyPartitionable => false;
    }
}
