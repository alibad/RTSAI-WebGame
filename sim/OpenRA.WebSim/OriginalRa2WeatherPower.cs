using System.Linq;
using OpenRA;
using OpenRA.GameRules;
using OpenRA.Mods.Common;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.RA2.Traits;
using OpenRA.Mods.RA2.Traits.SupportPowers;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.WebSim
{
    // Keep the original 15-frame rules clock as a rational accumulator. Rounding each
    // five-frame scatter interval to eight host ticks would make a whole storm run fast.
    public sealed class OriginalRa2WeatherPowerInfo : WeatherControlSupportPowerInfo
    {
        public readonly int Deferment = 250;
        public override object Create(ActorInitializer init) => new OriginalRa2WeatherPower(init.Self,this);
    }
    public sealed class OriginalRa2WeatherPower : SupportPower, ITick
    {
        readonly OriginalRa2WeatherPowerInfo info;
        WPos target;
        bool launched;
        int fraction, deferment, remaining, hit, scatter;
        public bool StormActive => launched && deferment == 0;
        public int DirectHits { get; private set; }
        public int ScatterHits { get; private set; }
        public OriginalRa2WeatherPower(Actor self,OriginalRa2WeatherPowerInfo info):base(self,info){this.info=info;}
        public override void Activate(Actor self,Order order,SupportPowerManager manager)
        {
            base.Activate(self,order,manager);
            target=order.Target.CenterPosition;fraction=0;deferment=info.Deferment;remaining=info.Duration;
            hit=info.HitDelay;scatter=info.ScatterDelay;DirectHits=ScatterHits=0;launched=true;
            PlayLaunchSounds();
        }
        void ITick.Tick(Actor self)
        {
            if(!launched)return;
            fraction+=15;
            while(fraction>=25)
            {
                fraction-=25;
                if(deferment>0)
                {
                    if(--deferment==0 && !string.IsNullOrEmpty(info.PaletteEffectType))
                        foreach(var effect in self.World.WorldActor.TraitsImplementing<WeatherPaletteEffect>().Where(p=>p.Info.Type==info.PaletteEffectType))effect.Enable(-1);
                    continue;
                }
                if(remaining<=0){launched=false;return;}
                remaining--;
                if(--hit<=0)
                {
                    hit=info.HitDelay;DirectHits++;
                    info.WeaponInfo.Impact(Target.FromPos(target),new WarheadArgs{SourceActor=self});
                }
                if(--scatter<=0)
                {
                    scatter=info.ScatterDelay;
                    for(var i=0;i<info.ScatterCount;i++)
                    {
                        var offset=new WVec(self.World.SharedRandom.Next(info.OffsetsX.X,info.OffsetsX.Y),self.World.SharedRandom.Next(info.OffsetsY.X,info.OffsetsY.Y),0);
                        info.WeaponInfo.Impact(Target.FromPos(target+offset),new WarheadArgs{SourceActor=self});ScatterHits++;
                    }
                }
                if(remaining==0)launched=false;
            }
        }
    }
}
